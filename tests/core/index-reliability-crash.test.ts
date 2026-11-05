/**
 * @file tests/core/index-reliability-crash.test.ts
 * @description 崩溃恢复验收 — 子进程按阶段强制退出,父进程重建完整实例后按 spec A1～A11 核对真实磁盘
 * @module tests/core/index-reliability-crash
 * @depends tests/helpers/index-crash-child, src/core/index-runtime-assembly,
 *   src/worker/chunker, tests/helpers/index-reliability-fixture
 *
 * 关键路径(T8 checkbox 1):
 * - 崩溃一律发生在**独立子进程**:`child_process.spawn` 跑 esbuild 现场构建的入口,
 *   在指定阶段 `SIGKILL` 自杀;父进程随后在**新进程**里重建完整索引管线。
 * - 断言全部落在真实磁盘:块 ID / 向量 / 维度 / 完成记录(inputHash、chunkCount、revision)/
 *   控制指针 / 待提交事务目录 / 清单;嵌入调用数用**可计数端口**。
 * - 本文件不 mock `obsidian`,也不使用 `Object.create(Plugin.prototype)`:管线经
 *   `core/index-runtime-assembly` 直接构造 —— 这正是 T8 装配下沉要交付的能力。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import esbuild from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

import { chunkMarkdown } from '../../src/worker/chunker';
import { sha256 } from '../../src/utils/hash';
import { deterministicVector, T0_CHUNK_OPTIONS } from '../helpers/index-reliability-fixture';
import type { EmbeddingPort } from '../../src/ports/embedding';
import {
	CRASH_CHILD_ENTRY_FLAG,
	CRASH_STAGES,
	CrashPointStorage,
	assembleIndexHarness,
	createCrashHookState,
	listMarkdownFiles,
	writeNotes,
	type CrashMarker,
	type IndexHarness,
} from '../helpers/index-crash-child';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DIMENSIONS = 128;

/**
 * 子进程显式超时上限 —— 小于用例级 120s,保证超时分支能在用例被判超时之前跑完。
 *
 * 关键路径:正常一轮(hang 注入关闭时)是数百毫秒量级,90s 只用于兜住真正的挂起;
 * 取小于用例超时是为了让「杀进程 + 清理目录 + 明确报错」这条路径有机会执行,
 * 而不是被 vitest 的用例超时直接掐断(那样又会回到目录泄漏 + 子进程存活)。
 */
const CHILD_TIMEOUT_MS = 90_000;

/** 挂起注入用例的父进程侧超时 —— 只要能观察到超时分支即可,不追求等满。 */
const HANG_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// 子进程入口构建
// ---------------------------------------------------------------------------

let buildRoot: string;
let childEntry: string;

/** esbuild 现场构建子进程入口 — 别名与 `esbuild.config.mjs` 一致(尤其 vectra 的 browser 入口)。 */
async function buildChildEntry(outDir: string): Promise<string> {
	const outfile = path.join(outDir, 'index-crash-child.cjs');
	await esbuild.build({
		entryPoints: [path.join(REPO_ROOT, 'tests/helpers/index-crash-child.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'es2021',
		outfile,
		logLevel: 'silent',
		sourcemap: false,
		alias: {
			// 关键路径:vectra 的 Node 入口会 re-export server 模块(带来 grpc);生产构建同样走
			// browser 入口,夹具必须一致,否则「夹具通过、生产失败」是最坏的假绿。
			vectra: path.resolve(REPO_ROOT, 'node_modules/vectra/lib/browser.js'),
			'@huggingface/transformers': path.resolve(REPO_ROOT, 'src/adapters/empty-transformers.cjs'),
			'onnxruntime-node': path.resolve(REPO_ROOT, 'src/adapters/empty-module.cjs'),
		},
		external: ['obsidian', 'electron', ...builtinModules],
	});
	return outfile;
}

/** 子进程运行结果。 */
interface ChildOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	/** 触发时的子进程 pid(诊断用;超时分支据此核对进程确实已死)。 */
	pid: number | undefined;
}

/**
 * 子进程超时错误 — 携带退出信号、pid 与被清理的场景目录。
 *
 * 关键路径:超时分支必须自带清理结论,不能只抛一句「超时」;否则调用方无法核对
 * 「进程已死 + 目录已删」这两件事实。
 */
class ChildTimeoutError extends Error {
	constructor(
		readonly timeoutMs: number,
		readonly signal: NodeJS.Signals | null,
		readonly pid: number | undefined,
		/** 已被本分支独立删除的场景目录;未提供场景目录时为 undefined。 */
		readonly scenarioRoot: string | undefined,
		/** 场景目录删除是否成功完成。 */
		readonly scenarioRemoved: boolean,
		readonly stdout: string,
		readonly stderr: string,
	) {
		super(`子进程在 ${timeoutMs}ms 内未退出,已 SIGKILL(signal=${String(signal)}, pid=${String(pid)});`
			+ `场景目录清理:${scenarioRemoved ? '已完成' : '未执行'}(${String(scenarioRoot)})`
			+ `;stdout=${stdout.slice(-500)};stderr=${stderr.slice(-500)}`);
		this.name = 'ChildTimeoutError';
	}
}

/**
 * 跑一次子进程并收集退出信息与输出。
 *
 * 关键路径:显式超时 + `SIGKILL` + **超时分支独立清理场景目录**。
 * 没有这三件事时,子进程一旦挂起,`await` 永不 settle:vitest 的用例超时无法把拒绝
 * 注入到这条悬空的 await 上,调用方的 `finally` 不会执行,于是场景临时目录泄漏、
 * 子进程存活。清理因此必须发生在超时分支内部,而不是依赖调用方的 `finally`。
 *
 * @param env - 子进程环境(会与当前 env 合并)。
 * @param options - `args` 覆盖(默认带入口参数)、场景目录与超时上限。
 * @returns 退出码、信号与 stdout/stderr。
 * @throws {ChildTimeoutError} 超过 `timeoutMs` 仍未退出(已杀进程并清理场景目录)。
 */
function runChild(
	env: Record<string, string>,
	options: { args?: string[]; scenarioRoot?: string; timeoutMs?: number } = {},
): Promise<ChildOutcome> {
	const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
	const scenarioRoot = options.scenarioRoot;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, options.args ?? [childEntry, CRASH_CHILD_ENTRY_FLAG], {
			cwd: REPO_ROOT,
			env: { ...process.env, ...env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			// 关键路径:先杀再等 `close`;`close` 只在进程真的被回收后触发,所以清理一定
			// 发生在子进程不再写盘之后。
			child.kill('SIGKILL');
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
		child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!timedOut) {
				resolve({ code, signal, stdout, stderr, pid: child.pid });
				return;
			}
			// 超时分支:独立清理(不依赖调用方的 finally,后者在悬空 await 下不会执行)。
			let scenarioRemoved = false;
			if (scenarioRoot !== undefined) {
				try {
					fs.rmSync(scenarioRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
					scenarioRemoved = !fs.existsSync(scenarioRoot);
				} catch {
					scenarioRemoved = false;
				}
			}
			reject(new ChildTimeoutError(timeoutMs, signal, child.pid, scenarioRoot, scenarioRemoved, stdout, stderr));
		});
	});
}

// ---------------------------------------------------------------------------
// 可计数嵌入端口
// ---------------------------------------------------------------------------

/** 记录全部嵌入文本的可计数端口 — 用于证明「已提交未变文件零重复嵌入」。 */
class RecordingEmbeddingPort implements EmbeddingPort {
	readonly modelId = 'test:deterministic';
	readonly dimensions: number;
	readonly batches: string[][] = [];
	/** 命中该正则的文本抛错(复现单文件推理失败)。 */
	failOnText: RegExp | undefined;

	constructor(dimensions: number) {
		this.dimensions = dimensions;
	}

	get callCount(): number {
		return this.batches.length;
	}

	get texts(): string[] {
		return this.batches.flat();
	}

	async embed(texts: string[]): Promise<number[][]> {
		const matcher = this.failOnText;
		if (matcher !== undefined && texts.some((text) => (matcher.lastIndex = 0, matcher.test(text)))) {
			throw new Error('注入故障:嵌入文本命中失败规则');
		}
		this.batches.push([...texts]);
		return texts.map((text) => deterministicVector(text, this.dimensions));
	}
}

// ---------------------------------------------------------------------------
// 场景与磁盘断言
// ---------------------------------------------------------------------------

/** 一次崩溃场景:合成 Vault + 索引根。 */
interface Scenario {
	root: string;
	vaultDir: string;
	indexRoot: string;
	notePaths: string[];
}

/** 合成笔记内容 — 每篇约 3~4 块(T0 分块配置:100 字符预算)。 */
function noteContent(name: string, marker = ''): string {
	const lines = [`# ${name}`, ''];
	for (let i = 0; i < 4; i++) {
		lines.push(`## 段落 ${i}`);
		lines.push(`${marker}${name} 的第 ${i} 段正文,用于崩溃恢复验收:内容长度足以切出多个块。`);
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * 建立崩溃场景 — 全部落在系统临时目录。
 *
 * @param prefix - 临时目录前缀。
 * @param names - 笔记文件名(相对路径)。
 * @returns 场景句柄。
 */
function createScenario(prefix: string, names: readonly string[]): Scenario {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const vaultDir = path.join(root, 'vault');
	const indexRoot = path.join(root, 'plugin', '.index');
	fs.mkdirSync(vaultDir, { recursive: true });
	fs.mkdirSync(path.join(root, 'plugin'), { recursive: true });
	const notePaths = writeNotes(vaultDir, names.map((name) => ({ path: `notes/${name}`, content: noteContent(name) })));
	return { root, vaultDir, indexRoot, notePaths };
}

/** 递归删除场景目录,重复调用安全。 */
async function disposeScenario(scenario: Scenario): Promise<void> {
	// 关键路径:删除**本身**就是可判定的收敛条件 —— 在途写造成的瞬时失败
	// (ENOTEMPTY / EBUSY / EPERM)由 Node 按 `retryDelay` 线性退避重试到 `maxRetries`,
	// 而不是先固定睡 25ms 去「猜」窗口。`force:true` 保证目录已被超时分支删掉时也不报错。
	fs.rmSync(scenario.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
}

/** 完成记录(raw JSON 形状)。 */
interface RawReceipt {
	path: string;
	state: 'present' | 'deleted';
	inputHash: string | null;
	revision: number;
	chunkCount: number;
	commitId: string;
	blockSetHash: string;
}

/** 读磁盘上的全部完成记录 — 不经任何内存视图。 */
async function readReceipts(indexDir: string): Promise<Map<string, RawReceipt>> {
	const dir = path.join(indexDir, 'files');
	const receipts = new Map<string, RawReceipt>();
	if (!fs.existsSync(dir)) return receipts;
	for (const name of await fsp.readdir(dir)) {
		if (!name.endsWith('.json')) continue;
		const raw = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) as RawReceipt;
		receipts.set(raw.path, raw);
	}
	return receipts;
}

/** 待提交事务目录名列表。 */
async function readPendingTransactions(indexDir: string): Promise<string[]> {
	const dir = path.join(indexDir, 'pending');
	if (!fs.existsSync(dir)) return [];
	return (await fsp.readdir(dir)).sort();
}

/** 磁盘上的一个块。 */
interface DiskBlock {
	id: string;
	vector: number[];
	metadata: { path?: string; chunkIndex?: number; commitId?: string };
}

/** 直读持久化索引取某路径的全部块 — 独立于内存视图的磁盘真值。 */
async function readDiskBlocks(indexDir: string, filePath: string): Promise<DiskBlock[]> {
	// 关键路径:分片布局下块散落在 `shards/<hh>/index.json`;没有分片目录才按旧单份布局读。
	const files = await indexPersistenceFiles(indexDir);
	const items: Array<{ id: string; vector: number[]; metadata: DiskBlock['metadata'] }> = [];
	for (const file of files) {
		let raw: string;
		try {
			raw = await fsp.readFile(file, 'utf8');
		}
		catch (error) {
			// 关键路径:片目录可能存在但索引尚未落盘,缺文件按空片处理。
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		const parsed = JSON.parse(raw) as { items?: typeof items };
		items.push(...(parsed.items ?? []));
	}
	return items
		.filter((item) => item.metadata?.path === filePath)
		.map((item) => ({ id: item.id, vector: item.vector, metadata: item.metadata }));
}

/** 列出代际目录下参与块持久化的文件 — 分片布局按片列出,否则回落单份 `index.json`。 */
async function indexPersistenceFiles(indexDir: string): Promise<string[]> {
	const shardsRoot = path.join(indexDir, 'shards');
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(shardsRoot, { withFileTypes: true });
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		return [path.join(indexDir, 'index.json')];
	}
	const files = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(shardsRoot, entry.name, 'index.json'));
	return files.length === 0 ? [path.join(indexDir, 'index.json')] : files;
}

/**
 * 计算某路径的期望块 ID 与向量(与生产分块器逐块一致)。
 *
 * @param filePath - 业务路径。
 * @param content - 正文。
 * @returns 块 ID 与向量列表。
 */
function expectedBlocks(filePath: string, content: string): Array<{ id: string; vector: number[] }> {
	const chunks = chunkMarkdown(content, T0_CHUNK_OPTIONS);
	return chunks.map((chunk, index) => ({
		id: `${filePath}#chunk-${index}`,
		vector: deterministicVector(chunk.embedText, DIMENSIONS),
	}));
}

/**
 * 断言磁盘块集合与期望逐块一致(顺序、ID、维度、向量值)。
 *
 * @param disk - 磁盘块。
 * @param expected - 期望块。
 * @param label - 断言上下文(路径)。
 */
function expectDiskBlocksEqual(disk: DiskBlock[], expected: Array<{ id: string; vector: number[] }>, label: string): void {
	expect(disk.map((block) => block.id), `${label} 块 ID 集合`).toEqual(expected.map((block) => block.id));
	expect(new Set(disk.map((block) => block.id)).size, `${label} 块 ID 去重后数量`).toBe(disk.length);
	for (const [index, block] of disk.entries()) {
		const wanted = expected[index];
		expect(wanted, `${label} 第 ${index} 块缺少期望值`).toBeDefined();
		expect(block.vector.length, `${label} 第 ${index} 块维度`).toBe(DIMENSIONS);
		expect(block.vector, `${label} 第 ${index} 块向量`).toEqual(wanted!.vector);
	}
}

/** 目录快照(相对路径 → 内容),用于「零变化启动不写向量数据」的逐字节断言。 */
async function snapshotDir(root: string): Promise<Map<string, string>> {
	const entries = new Map<string, string>();
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) entries.set(path.relative(root, full), fs.readFileSync(full).toString('base64'));
		}
	};
	if (fs.existsSync(root)) walk(root);
	return entries;
}

/** 索引目录内每个非临时 JSON 都能解析 — 「无半截文件」的直接断言。 */
function expectNoHalfWrittenJson(indexDir: string): void {
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.includes('.tmp-')) {
				expect(() => JSON.parse(fs.readFileSync(full, 'utf8')), `半截 JSON:${path.relative(indexDir, full)}`).not.toThrow();
			}
		}
	};
	walk(indexDir);
}

/** 待提交事务里的一条 prepared 记录(只声明本用例读取的字段)。 */
interface PendingPrepared {
	transactionId: string;
	path: string;
	inputHash: string | null;
	chunkCount: number;
	commitId: string;
}

/** 崩溃现场 — 全部来自真实磁盘。 */
interface CrashSite {
	receipts: Map<string, RawReceipt>;
	pendingTransactions: string[];
	prepared: PendingPrepared[];
	/** 路径 → 磁盘块 ID 与 commitId。 */
	blocks: Map<string, Array<{ id: string; commitId: string | undefined }>>;
}

/**
 * 读取崩溃现场 — 完成记录、待提交事务、prepared 记录与磁盘块。
 *
 * @param scenario - 崩溃场景。
 * @param filePaths - 需要读取磁盘块的路径。
 * @returns 现场快照。
 */
async function inspectCrashSite(scenario: Scenario, filePaths: readonly string[]): Promise<CrashSite> {
	const indexDir = indexRootOf(scenario);
	const receipts = await readReceipts(indexDir);
	const pendingTransactions = await readPendingTransactions(indexDir);
	const prepared: PendingPrepared[] = [];
	for (const transactionId of pendingTransactions) {
		const preparedPath = path.join(indexDir, 'pending', transactionId, 'prepared.json');
		if (!fs.existsSync(preparedPath)) continue;
		const raw = JSON.parse(fs.readFileSync(preparedPath, 'utf8')) as {
			next: { path: string; inputHash: string | null; chunkCount: number; commitId: string };
		};
		prepared.push({
			transactionId,
			path: raw.next.path,
			inputHash: raw.next.inputHash,
			chunkCount: raw.next.chunkCount,
			commitId: raw.next.commitId,
		});
	}
	const blocks = new Map<string, Array<{ id: string; commitId: string | undefined }>>();
	for (const filePath of filePaths) {
		const disk = await readDiskBlocks(indexDir, filePath);
		blocks.set(filePath, disk.map((block) => ({ id: block.id, commitId: block.metadata.commitId })));
	}
	return { receipts, pendingTransactions, prepared, blocks };
}

/**
 * 崩溃时「不应再次嵌入」的路径 — 依据 spec §2 的退出位置表从磁盘推导:
 * 有完成记录,或有可重放的 prepared(声明的输入 hash 与当前内容一致)。
 *
 * @param site - 崩溃现场。
 * @param vaultDir - 合成 Vault 目录。
 * @returns 路径集合。
 */
async function noReembedPaths(site: CrashSite, vaultDir: string): Promise<Set<string>> {
	const paths = new Set<string>();
	for (const [filePath, receipt] of site.receipts) {
		if (receipt.state === 'present') paths.add(filePath);
	}
	for (const entry of site.prepared) {
		const content = fs.readFileSync(path.join(vaultDir, entry.path), 'utf8');
		if (entry.inputHash === await sha256(content)) paths.add(entry.path);
	}
	return paths;
}

/** 在进程内重建并跑一轮;返回记录端口与链路句柄。 */
async function runRecovery(
	scenario: Scenario,
	options: { failOnText?: RegExp } = {},
): Promise<{ embedding: RecordingEmbeddingPort; harness: IndexHarness; result: { indexed: number; errors: number } | null }> {
	const embedding = new RecordingEmbeddingPort(DIMENSIONS);
	if (options.failOnText !== undefined) embedding.failOnText = options.failOnText;
	const harness = await assembleIndexHarness({
		indexRoot: scenario.indexRoot,
		vaultDir: scenario.vaultDir,
		notePaths: listMarkdownFiles(scenario.vaultDir),
		embedding,
		dimensions: DIMENSIONS,
	});
	const result = await harness.run();
	return { embedding, harness, result };
}

/** 运行子进程并强制退出到指定阶段;返回退出信息与标记。 */
async function crashAt(scenario: Scenario, stage: string, afterFiles = 0): Promise<{ outcome: ChildOutcome; marker: CrashMarker }> {
	const markerPath = path.join(scenario.root, `crash-${stage}.json`);
	const resultPath = path.join(scenario.root, `crash-${stage}-result.json`);
	const env: Record<string, string> = {
		RATEL_CRASH_CHILD_INDEX_ROOT: scenario.indexRoot,
		RATEL_CRASH_CHILD_VAULT_DIR: scenario.vaultDir,
		RATEL_CRASH_CHILD_MARKER: markerPath,
		RATEL_CRASH_CHILD_RESULT: resultPath,
		RATEL_CRASH_CHILD_STAGE: stage,
		RATEL_CRASH_CHILD_AFTER_FILES: String(afterFiles),
		RATEL_CRASH_CHILD_DIMENSIONS: String(DIMENSIONS),
	};
	// 关键路径:传 `scenarioRoot`,超时分支才能独立清理场景目录(调用方的 finally 不可依赖)。
	const outcome = await runChild(env, { scenarioRoot: scenario.root });
	expect(outcome.stderr, `子进程失败:${outcome.stderr}`).not.toContain('RATEL_CHILD_ERROR');
	expect(outcome.signal, `未在 ${stage} 阶段被强制退出(stdout=${outcome.stdout})`).toBe('SIGKILL');
	expect(outcome.stdout).toContain(`RATEL_CRASH ${stage} `);
	expect(fs.existsSync(markerPath), `缺少崩溃标记文件:${stage}`).toBe(true);
	const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as CrashMarker;
	expect(marker.stage).toBe(stage);
	return { outcome, marker };
}

/** 断言全部笔记都有完成记录,且 inputHash/chunkCount 与当前内容一致。 */
async function expectReceiptsMatchVault(scenario: Scenario): Promise<void> {
	const receipts = await readReceipts(indexRootOf(scenario));
	for (const filePath of listMarkdownFiles(scenario.vaultDir)) {
		const content = fs.readFileSync(path.join(scenario.vaultDir, filePath), 'utf8');
		const receipt = receipts.get(filePath);
		expect(receipt, `${filePath} 缺少完成记录`).toBeDefined();
		expect(receipt!.state, `${filePath} 完成记录状态`).toBe('present');
		expect(receipt!.inputHash, `${filePath} 完成记录 inputHash`).toBe(await sha256(content));
		expect(receipt!.chunkCount, `${filePath} 完成记录块数`).toBe(chunkMarkdown(content, T0_CHUNK_OPTIONS).length);
	}
}

/** 从场景解析当前代际目录。 */
function indexRootOf(scenario: Scenario): string {
	const control = JSON.parse(fs.readFileSync(path.join(scenario.indexRoot, 'control.json'), 'utf8')) as {
		activeGenerationId: string | null;
		generations: Record<string, { root: string }>;
	};
	const generationId = control.activeGenerationId ?? Object.keys(control.generations)[0];
	if (generationId === undefined) throw new Error('控制指针里没有任何代际');
	const generation = control.generations[generationId];
	if (generation === undefined) throw new Error(`控制指针缺少代际 ${generationId}`);
	return generation.root;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

beforeAll(async () => {
	buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t8-child-build-'));
	childEntry = await buildChildEntry(buildRoot);
	expect(fs.existsSync(childEntry)).toBe(true);
}, 120_000);

afterAll(() => {
	if (buildRoot !== undefined) fs.rmSync(buildRoot, { recursive: true, force: true });
});

describe('崩溃恢复 — 子进程按阶段强制退出后重建(A1/A2/A6)', () => {
	it.each(CRASH_STAGES)('阶段 %s - 真实磁盘恢复、块集合完整、无半截文件', async (stage) => {
		const scenario = createScenario(`ratel-t8-${stage}-`, ['a.md', 'b.md', 'c.md']);
		try {
			const { marker } = await crashAt(scenario, stage);
			const indexDir = indexRootOf(scenario);
			// before 在真实写入/删除前退出,after 在原子替换后退出;两者都不得留下半截 JSON。
			expectNoHalfWrittenJson(indexDir);

			const site = await inspectCrashSite(scenario, scenario.notePaths);
			// 现场断言:证明崩溃确实停在该阶段的边界上(而不是恰好在别处退出)。
			switch (stage) {
				case 'prepared-before':
					// 分片已落盘、`prepared.json` 缺失 —— 不完整准备数据,不可重放。
					expect(site.receipts.size).toBe(0);
					expect(site.prepared).toHaveLength(0);
					expect(site.pendingTransactions).toHaveLength(1);
					break;
				case 'prepared-after':
					// 待提交事务已落盘、向量尚未提交。
					expect(site.receipts.size).toBe(0);
					expect(site.prepared).toHaveLength(1);
					expect(site.blocks.get(site.prepared[0]!.path)).toHaveLength(0);
					break;
				case 'vector-before':
					// 已在 index.json 的真实原子替换入口前退出:prepared 可重放,目标向量尚未发布。
					expect(marker.relativePath).toBe('index.json');
					expect(site.receipts.size).toBe(0);
					expect(site.prepared).toHaveLength(1);
					expect(site.blocks.get(site.prepared[0]!.path)).toHaveLength(0);
					break;
				case 'vector-after':
					// 向量已提交、完成记录尚未落盘。
					expect(site.receipts.size).toBe(0);
					expect(site.prepared).toHaveLength(1);
					expect(site.blocks.get(site.prepared[0]!.path)!.length).toBe(site.prepared[0]!.chunkCount);
					break;
				case 'receipt-before':
					// 已在 files/<pathHash>.json 的真实原子替换入口前退出:向量完整,receipt 尚不存在。
					expect(marker.relativePath).toMatch(/^files\/[^/]+\.json$/);
					expect(site.receipts.size).toBe(0);
					expect(site.prepared).toHaveLength(1);
					expect(site.blocks.get(site.prepared[0]!.path)!.length).toBe(site.prepared[0]!.chunkCount);
					break;
				case 'receipt-after':
					// 完成记录已落盘、事务目录尚未清理。
					expect(site.receipts.size).toBe(1);
					expect(site.prepared).toHaveLength(1);
					expect(site.pendingTransactions).toHaveLength(1);
					break;
				case 'cleanup-before':
					// 已在 pending/<transactionId> 的真实 rm 入口前退出:receipt 与向量完整,事务目录仍在。
					expect(marker.relativePath).toMatch(/^pending\/[^/]+$/);
					expect(site.receipts.size).toBe(1);
					expect(site.prepared).toHaveLength(1);
					expect(site.pendingTransactions).toEqual([site.prepared[0]!.transactionId]);
					expect(site.blocks.get(site.prepared[0]!.path)!.length).toBe(site.prepared[0]!.chunkCount);
					break;
				case 'commit-after-cleanup':
					// 提交已返回且日志已清理 —— 磁盘上是可完全复用的状态。
					expect(site.receipts.size).toBe(1);
					expect(site.pendingTransactions).toHaveLength(0);
					break;
			}

			const noReembed = await noReembedPaths(site, scenario.vaultDir);

			const { embedding, harness, result } = await runRecovery(scenario);
			await harness.dispose();
			expect(result, '重建后的索引未完成').not.toBeNull();
			expect(result!.errors, '重建后仍有失败文件').toBe(0);

			// 每篇文件的块集合与当前内容逐块一致(无重复块、无旧块残留、维度正确)。
			const receipts = await readReceipts(indexDir);
			for (const filePath of scenario.notePaths) {
				const content = fs.readFileSync(path.join(scenario.vaultDir, filePath), 'utf8');
				expectDiskBlocksEqual(await readDiskBlocks(indexDir, filePath), expectedBlocks(filePath, content), filePath);
				expect(receipts.get(filePath), `${filePath} 完成记录`).toBeDefined();
			}
			expect(await readPendingTransactions(indexDir), '恢复后仍有待提交事务').toHaveLength(0);
			// 关键路径:崩溃时已持久化的文件不得再次嵌入;其余文件必须被真正提交(非空断言)。
			const embeddedPaths = new Set<string>();
			for (const text of embedding.texts) {
				for (const filePath of scenario.notePaths) {
					if (text.includes(path.basename(filePath))) embeddedPaths.add(filePath);
				}
			}
			for (const filePath of scenario.notePaths) {
				if (noReembed.has(filePath)) {
					expect(embeddedPaths.has(filePath), `${stage}:已持久化文件 ${filePath} 被重复嵌入`).toBe(false);
				} else {
					expect(embeddedPaths.has(filePath), `${stage}:未持久化文件 ${filePath} 未被重算`).toBe(true);
				}
			}
			// 第二次零变化启动:零嵌入(A1 的核心断言)。
			const second = await runRecovery(scenario);
			await second.harness.dispose();
			expect(second.embedding.callCount, '零变化重启的嵌入调用数').toBe(0);
			await expectReceiptsMatchVault(scenario);
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);

	it.each(['vector-before', 'receipt-before', 'cleanup-before'] as const)(
		'第 N+1 篇 %s 崩溃 - afterFiles=1 - 前 1 篇零重复嵌入且恢复完整',
		async (stage) => {
			const scenario = createScenario(`ratel-t8-${stage}-afterfiles-`, ['a.md', 'b.md', 'c.md']);
			try {
				const { marker } = await crashAt(scenario, stage, 1);
				const indexDir = indexRootOf(scenario);
				const site = await inspectCrashSite(scenario, scenario.notePaths);
				// 启动扫描并发核对,处理顺序不等于文件名顺序;唯一 pending 才是本次第 N+1 篇。
				expect(site.prepared).toHaveLength(1);
				const prepared = site.prepared[0]!;
				expect(site.pendingTransactions).toEqual([prepared.transactionId]);

				switch (stage) {
					case 'vector-before':
						expect(marker.relativePath).toBe('index.json');
						expect(site.receipts.size).toBe(1);
						expect(site.blocks.get(prepared.path)).toHaveLength(0);
						break;
					case 'receipt-before':
						expect(marker.relativePath).toMatch(/^files\/[^/]+\.json$/);
						expect(site.receipts.size).toBe(1);
						expect(site.blocks.get(prepared.path)!.length).toBe(prepared.chunkCount);
						break;
					case 'cleanup-before':
						expect(marker.relativePath).toBe(`pending/${prepared.transactionId}`);
						expect(site.receipts.size).toBe(2);
						expect(site.receipts.has(prepared.path), '第 2 篇 receipt 尚未落盘').toBe(true);
						expect(site.blocks.get(prepared.path)!.length).toBe(prepared.chunkCount);
						break;
				}

				// 排除当前 pending 后必须恰好剩一条 receipt:它才是本次崩溃前已完整提交的前 N 篇。
				const committedBefore = [...site.receipts.keys()].filter((filePath) => filePath !== prepared.path);
				expect(committedBefore, '崩溃前完整提交的文件数不是 1').toHaveLength(1);
				const firstCommittedPath = committedBefore[0]!;
				const noReembed = await noReembedPaths(site, scenario.vaultDir);
				expect(noReembed, '前 N 篇与当前篇均已有可恢复持久状态')
					.toEqual(new Set([firstCommittedPath, prepared.path]));
				const { embedding, harness, result } = await runRecovery(scenario);
				await harness.dispose();
				expect(result, '重建后的索引未完成').not.toBeNull();
				expect(result!.errors, '重建后仍有失败文件').toBe(0);

				const embeddedPaths = new Set<string>();
				for (const text of embedding.texts) {
					for (const filePath of scenario.notePaths) {
						if (text.includes(path.basename(filePath))) embeddedPaths.add(filePath);
					}
				}
				for (const filePath of scenario.notePaths) {
					if (noReembed.has(filePath)) {
						expect(embeddedPaths.has(filePath), `${stage}:已持久化文件 ${filePath} 被重复嵌入`).toBe(false);
					} else {
						expect(embeddedPaths.has(filePath), `${stage}:未持久化文件 ${filePath} 未被重算`).toBe(true);
					}
				}

				const receipts = await readReceipts(indexDir);
				expect(receipts.get(firstCommittedPath), '前 N 篇 receipt 在恢复后被改写')
					.toEqual(site.receipts.get(firstCommittedPath));
				for (const filePath of scenario.notePaths) {
					const content = fs.readFileSync(path.join(scenario.vaultDir, filePath), 'utf8');
					expectDiskBlocksEqual(await readDiskBlocks(indexDir, filePath), expectedBlocks(filePath, content), filePath);
					expect(receipts.get(filePath), `${filePath} 完成记录`).toBeDefined();
				}
				expect(await readPendingTransactions(indexDir), '恢复后仍有待提交事务').toHaveLength(0);
				const second = await runRecovery(scenario);
				await second.harness.dispose();
				expect(second.embedding.callCount, '零变化重启的嵌入调用数').toBe(0);
				await expectReceiptsMatchVault(scenario);
			} finally {
				await disposeScenario(scenario);
			}
		},
		120_000,
	);

	it('先完整提交两篇再在第三篇 prepared 后崩溃 - 已提交文件零重复嵌入', async () => {
		const scenario = createScenario('ratel-t8-afterfiles-', ['a.md', 'b.md', 'c.md']);
		try {
			await crashAt(scenario, 'prepared-after', 2);
			const indexDir = indexRootOf(scenario);
			const receipts = await readReceipts(indexDir);
			// 前置事实:确实已经有两篇完成记录(否则本用例退化成「第一篇崩溃」,断言恒真)。
			expect(receipts.size).toBe(2);

			const { embedding, harness } = await runRecovery(scenario);
			await harness.dispose();

			const committed = [...receipts.keys()];
			for (const text of embedding.texts) {
				for (const filePath of committed) {
					expect(text.includes(path.basename(filePath)), `已提交文件 ${filePath} 被重复嵌入`).toBe(false);
				}
			}
			expect(receipts.size).toBe(2);
			await expectReceiptsMatchVault(scenario);
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);

	it('receipt-after 在第 N+1 篇生效 - 先放行 1 篇再于第 2 篇完成记录后崩溃,已提交文件零重复嵌入', async () => {
		const scenario = createScenario('ratel-t8-receipt-afterfiles-', ['a.md', 'b.md', 'c.md']);
		try {
			await crashAt(scenario, 'receipt-after', 1);
			const indexDir = indexRootOf(scenario);
			const site = await inspectCrashSite(scenario, scenario.notePaths);
			// 关键路径(锁定 `afterFiles` 的 off-by-one):`afterFiles = 1` 表示「先完整提交
			// 第 1 篇,再对第 2 篇生效」。若判定写成「先自增再比较」,崩溃点会落到第 1 篇,
			// 这里就会只有 1 条完成记录 —— 该断言正是这条语义的现场锁。
			expect(site.receipts.size, 'afterFiles=1 的崩溃点落在了第 1 篇而非第 2 篇').toBe(2);
			// 第 2 篇的完成记录已落盘,但它的待提交事务目录尚未清理。
			expect(site.pendingTransactions).toHaveLength(1);
			// 现场只剩「刚写下完成记录的那一篇」的事务目录 —— 证明崩溃确实停在
			// 「记录已写、目录未清」的边界上,而不是别处。第 1 篇的目录已被清理。
			expect(site.prepared).toHaveLength(1);
			expect(site.receipts.has(site.prepared[0]!.path), '待提交事务与完成记录不是同一篇').toBe(true);

			const noReembed = await noReembedPaths(site, scenario.vaultDir);
			expect(noReembed.size, '崩溃时已持久化的文件数').toBe(2);
			const remaining = scenario.notePaths.filter((filePath) => !noReembed.has(filePath));
			expect(remaining, '未被持久化的文件应恰有一篇').toHaveLength(1);

			const { embedding, harness, result } = await runRecovery(scenario);
			await harness.dispose();
			expect(result, '重建后的索引未完成').not.toBeNull();
			expect(result!.errors, '重建后仍有失败文件').toBe(0);

			// 更强的「已提交文件零重复嵌入」形态:前两篇(含刚写下完成记录、事务目录仍在的那篇)
			// 一律不得再次嵌入,只允许第三篇重算。
			const embeddedPaths = new Set<string>();
			for (const text of embedding.texts) {
				for (const filePath of scenario.notePaths) {
					if (text.includes(path.basename(filePath))) embeddedPaths.add(filePath);
				}
			}
			for (const filePath of scenario.notePaths) {
				if (noReembed.has(filePath)) {
					expect(embeddedPaths.has(filePath), `已持久化文件 ${filePath} 被重复嵌入`).toBe(false);
				} else {
					expect(embeddedPaths.has(filePath), `未持久化文件 ${filePath} 未被重算`).toBe(true);
				}
			}

			// 三篇的块集合与完成记录都必须与当前内容一致;待提交事务已收敛。
			const receipts = await readReceipts(indexDir);
			for (const filePath of scenario.notePaths) {
				const content = fs.readFileSync(path.join(scenario.vaultDir, filePath), 'utf8');
				expectDiskBlocksEqual(await readDiskBlocks(indexDir, filePath), expectedBlocks(filePath, content), filePath);
				expect(receipts.get(filePath), `${filePath} 完成记录`).toBeDefined();
			}
			expect(await readPendingTransactions(indexDir)).toHaveLength(0);
			// 第二次零变化启动:零嵌入。
			const second = await runRecovery(scenario);
			await second.harness.dispose();
			expect(second.embedding.callCount, '零变化重启的嵌入调用数').toBe(0);
			await expectReceiptsMatchVault(scenario);
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);

	it('prepared 后崩溃且输入已过期 - 不发布旧快照,按当前内容重新提交(A3/A4)', async () => {
		const scenario = createScenario('ratel-t8-expired-', ['a.md', 'b.md']);
		try {
			await crashAt(scenario, 'prepared-after');
			const indexDir = indexRootOf(scenario);
			// 关键路径:磁盘上确实留下了待提交事务,否则本用例不是「过期 prepared」场景。
			expect(await readPendingTransactions(indexDir)).not.toHaveLength(0);

			// 崩溃后修改第一篇文件的正文(旧事务声明的输入已过期)。
			const newContent = noteContent('a.md', '过期后改写 ');
			fs.writeFileSync(path.join(scenario.vaultDir, 'notes/a.md'), newContent, 'utf8');

			const { harness, embedding } = await runRecovery(scenario);
			await harness.dispose();
			const expected = expectedBlocks('notes/a.md', newContent);
			const disk = await readDiskBlocks(indexDir, 'notes/a.md');
			expectDiskBlocksEqual(disk, expected, 'notes/a.md');
			// 旧快照的向量不得留在磁盘上。
			for (const oldBlock of expectedBlocks('notes/a.md', noteContent('a.md'))) {
				expect(disk.some((block) => block.id === oldBlock.id && JSON.stringify(block.vector) === JSON.stringify(oldBlock.vector)),
					'旧快照向量仍在磁盘上').toBe(false);
			}
			const receipts = await readReceipts(indexDir);
			expect(receipts.get('notes/a.md')!.inputHash).toBe(await sha256(newContent));
			expect(embedding.callCount).toBeGreaterThan(0);
			expect(await readPendingTransactions(indexDir)).toHaveLength(0);
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);
});

describe('重启语义 — 完整一轮后的零变化与文件变更(A1/A3/A5)', () => {
	it('完整一轮后再启动 - 零嵌入且不重写向量数据', async () => {
		const scenario = createScenario('ratel-t8-restart-', ['a.md', 'b.md', 'c.md']);
		try {
			const first = await runRecovery(scenario);
			await first.harness.dispose();
			expect(first.result?.errors).toBe(0);
			expect(first.embedding.callCount).toBeGreaterThan(0);

			const indexDir = indexRootOf(scenario);
			const before = await snapshotDir(indexDir);
			// 前置事实:向量数据确实存在(否则「未重写」无意义)。
			// 分片布局下块在 `shards/<hh>/index.json`;两种布局都算有向量数据。
			const hasVectorFiles = [...before.keys()].some((file) => file === 'index.json'
				|| /^shards[\\/][0-9a-f]{2}[\\/]index\.json$/.test(file));
			expect(hasVectorFiles).toBe(true);

			const second = await runRecovery(scenario);
			await second.harness.dispose();
			expect(second.embedding.callCount, '零变化重启的嵌入调用数').toBe(0);
			expect(await snapshotDir(indexDir), '零变化重启改写了索引目录').toEqual(before);
			await expectReceiptsMatchVault(scenario);
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);

	it('正文变化但 mtime/size 不变 - 只重算该文件(A3)', async () => {
		const scenario = createScenario('ratel-t8-mtime-', ['a.md', 'b.md', 'c.md']);
		try {
			const first = await runRecovery(scenario);
			await first.harness.dispose();
			const indexDir = indexRootOf(scenario);

			const target = path.join(scenario.vaultDir, 'notes/a.md');
			const original = fs.readFileSync(target, 'utf8');
			const stat = fs.statSync(target);
			// 同长度替换,再把 mtime 还原 —— 只改正文,时间戳与大小都不变。
			const changed = original.replace('崩溃恢复验收', '崩溃恢复验证');
			expect(changed.length).toBe(original.length);
			expect(changed).not.toBe(original);
			fs.writeFileSync(target, changed, 'utf8');
			fs.utimesSync(target, stat.atime, stat.mtime);

			const { embedding, harness } = await runRecovery(scenario);
			await harness.dispose();
			// 只有 a.md 进入嵌入:其他两篇的文本不得出现在嵌入输入里。
			expect(embedding.callCount).toBeGreaterThan(0);
			for (const text of embedding.texts) {
				expect(text.includes('b.md 的第'), 'b.md 被重复嵌入').toBe(false);
				expect(text.includes('c.md 的第'), 'c.md 被重复嵌入').toBe(false);
			}
			const disk = await readDiskBlocks(indexDir, 'notes/a.md');
			expectDiskBlocksEqual(disk, expectedBlocks('notes/a.md', changed), 'notes/a.md');
			expect((await readReceipts(indexDir)).get('notes/a.md')!.inputHash).toBe(await sha256(changed));
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);

	it('删除与改名 - 旧路径无残留块,新路径建立完成记录(A3)', async () => {
		const scenario = createScenario('ratel-t8-delete-', ['a.md', 'b.md', 'c.md']);
		try {
			const first = await runRecovery(scenario);
			await first.harness.dispose();
			const indexDir = indexRootOf(scenario);

			fs.rmSync(path.join(scenario.vaultDir, 'notes/b.md'));
			fs.renameSync(path.join(scenario.vaultDir, 'notes/c.md'), path.join(scenario.vaultDir, 'notes/d.md'));

			const { harness } = await runRecovery(scenario);
			await harness.dispose();
			const receipts = await readReceipts(indexDir);
			// 删除以 deleted 记录持久化,向量必须全部移除。
			expect(receipts.get('notes/b.md')?.state).toBe('deleted');
			expect(receipts.get('notes/b.md')?.inputHash).toBeNull();
			expect(await readDiskBlocks(indexDir, 'notes/b.md')).toHaveLength(0);
			// 改名 = 旧路径删除 + 新路径新增;旧路径不得留块。
			expect(await readDiskBlocks(indexDir, 'notes/c.md')).toHaveLength(0);
			expect(await readDiskBlocks(indexDir, 'notes/d.md')).toHaveLength(
				expectedBlocks('notes/d.md', fs.readFileSync(path.join(scenario.vaultDir, 'notes/d.md'), 'utf8')).length,
			);
			expect(receipts.get('notes/d.md')?.state).toBe('present');
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);

	it('文件变短与变空 - 旧多余块清除,空文件零块且可复用(A5)', async () => {
		const scenario = createScenario('ratel-t8-shrink-', ['a.md', 'b.md']);
		try {
			const first = await runRecovery(scenario);
			await first.harness.dispose();
			const indexDir = indexRootOf(scenario);
			const beforeBlocks = await readDiskBlocks(indexDir, 'notes/a.md');
			// 前置事实:原文件确实有多块,否则「清除多余块」无法观测。
			expect(beforeBlocks.length).toBeGreaterThan(1);

			const short = '# a.md\n\n很短。\n';
			fs.writeFileSync(path.join(scenario.vaultDir, 'notes/a.md'), short, 'utf8');
			fs.writeFileSync(path.join(scenario.vaultDir, 'notes/b.md'), '', 'utf8');

			const second = await runRecovery(scenario);
			await second.harness.dispose();
			const receipts = await readReceipts(indexDir);
			expectDiskBlocksEqual(
				await readDiskBlocks(indexDir, 'notes/a.md'),
				expectedBlocks('notes/a.md', short),
				'notes/a.md',
			);
			// 空文件提交零块 present 记录(不是删除凭据)。
			expect(receipts.get('notes/b.md')).toMatchObject({ state: 'present', chunkCount: 0, inputHash: await sha256('') });
			expect(await readDiskBlocks(indexDir, 'notes/b.md')).toHaveLength(0);

			// 空文件可复用:再启动一次不得为它嵌入,也不得重复提交。
			const third = await runRecovery(scenario);
			await third.harness.dispose();
			expect(third.embedding.callCount, '空文件未被复用').toBe(0);
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);

	it('单文件推理失败 - 其他文件不受影响,失败文件可重试(A5/A6)', async () => {
		const scenario = createScenario('ratel-t8-partial-', ['a.md', 'b.md', 'c.md']);
		try {
			// c.md 的嵌入抛错;正文里带唯一标记,故障只作用于该文件。
			const failing = noteContent('c.md', '单文件失败标记 ');
			fs.writeFileSync(path.join(scenario.vaultDir, 'notes/c.md'), failing, 'utf8');
			const first = await runRecovery(scenario, { failOnText: /单文件失败标记/ });
			await first.harness.dispose();
			const indexDir = indexRootOf(scenario);
			const receipts = await readReceipts(indexDir);
			expect(first.result?.errors, '失败文件未被计入失败').toBeGreaterThan(0);
			// 其他两篇照常提交且块集合完整。
			for (const filePath of ['notes/a.md', 'notes/b.md']) {
				const content = fs.readFileSync(path.join(scenario.vaultDir, filePath), 'utf8');
				expectDiskBlocksEqual(await readDiskBlocks(indexDir, filePath), expectedBlocks(filePath, content), filePath);
				expect(receipts.get(filePath)?.state).toBe('present');
			}
			// 失败文件不得留下完成记录(也不得留下可被当成成功的半成品)。
			expect(receipts.get('notes/c.md')).toBeUndefined();
			expect(await readDiskBlocks(indexDir, 'notes/c.md')).toHaveLength(0);

			// 恢复嵌入后重试:失败文件提交,其他文件零重复嵌入。
			const second = await runRecovery(scenario);
			await second.harness.dispose();
			expect(second.result?.errors).toBe(0);
			expectDiskBlocksEqual(
				await readDiskBlocks(indexDir, 'notes/c.md'),
				expectedBlocks('notes/c.md', failing),
				'notes/c.md',
			);
			for (const text of second.embedding.texts) {
				expect(text.includes('a.md 的第'), 'a.md 被重复嵌入').toBe(false);
				expect(text.includes('b.md 的第'), 'b.md 被重复嵌入').toBe(false);
			}
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);
});
describe('崩溃夹具自身 — 入口判据、超时清理与写收敛', () => {
	it('子进程挂起 - 父进程超时后 SIGKILL 并独立清理场景目录', async () => {
		const scenario = createScenario('ratel-t8-hang-', ['a.md']);
		const markerPath = path.join(scenario.root, 'crash-hang.json');
		// 关键路径:刻意让子进程在装配前挂起 60s;父进程侧只给 3s,超时分支必须自己收尾。
		const env: Record<string, string> = {
			RATEL_CRASH_CHILD_INDEX_ROOT: scenario.indexRoot,
			RATEL_CRASH_CHILD_VAULT_DIR: scenario.vaultDir,
			RATEL_CRASH_CHILD_MARKER: markerPath,
			RATEL_CRASH_CHILD_STAGE: 'prepared-after',
			RATEL_CRASH_CHILD_DIMENSIONS: String(DIMENSIONS),
			RATEL_CRASH_CHILD_HANG_MS: '60000',
		};
		let thrown: unknown;
		try {
			await runChild(env, { scenarioRoot: scenario.root, timeoutMs: HANG_TIMEOUT_MS });
		} catch (error) {
			thrown = error;
		}
		expect(thrown, '挂起的子进程没有被超时分支拦下').toBeInstanceOf(ChildTimeoutError);
		const failure = thrown as ChildTimeoutError;
		// 证据 1:确实被杀死。
		expect(failure.signal, '超时分支没有真正杀死子进程').toBe('SIGKILL');
		expect(failure.stdout, '超时分支没有观察到挂起标记').toContain('RATEL_HANG');
		// 证据 2:场景目录被超时分支独立清理(不依赖调用方的 finally)。
		expect(failure.scenarioRemoved, '超时分支没有清理场景目录').toBe(true);
		expect(fs.existsSync(scenario.root), '场景目录仍然存在').toBe(false);
		// 证据 3:进程确实已死 —— 存活时 process.kill(pid, 0) 不会抛。
		expect(failure.pid).toBeTypeOf('number');
		expect(() => process.kill(failure.pid ?? -1, 0), '子进程仍然存活').toThrow();
		// 等级更高的旁证:没有任何崩溃标记落到被删掉的目录里。
		expect(fs.existsSync(markerPath)).toBe(false);
	}, 60_000);

	it('仅环境变量齐备不足以进入子进程入口 - 不自杀且不留崩溃标记', async () => {
		const scenario = createScenario('ratel-t8-envleak-', ['a.md']);
		try {
			const markerPath = path.join(scenario.root, 'crash-envleak.json');
			// 关键路径:模拟 `RATEL_CRASH_CHILD_*` 从环境泄漏到 vitest worker 的情形 ——
			// 配置**齐备**,但**不传入口参数**。入口判据若用环境变量,这里就会按阶段自杀。
			const env: Record<string, string> = {
				RATEL_CRASH_CHILD_INDEX_ROOT: scenario.indexRoot,
				RATEL_CRASH_CHILD_VAULT_DIR: scenario.vaultDir,
				RATEL_CRASH_CHILD_MARKER: markerPath,
				RATEL_CRASH_CHILD_STAGE: 'prepared-after',
				RATEL_CRASH_CHILD_AFTER_FILES: '0',
				RATEL_CRASH_CHILD_DIMENSIONS: String(DIMENSIONS),
			};
			const outcome = await runChild(env, { args: [childEntry], scenarioRoot: scenario.root });
			expect(outcome.code, `环境变量泄漏进入口:${outcome.stderr}`).toBe(0);
			expect(outcome.signal, '环境变量泄漏导致子进程自杀').toBeNull();
			expect(outcome.stdout, '环境泄漏下仍然触发了崩溃').not.toContain('RATEL_CRASH');
			expect(outcome.stderr).not.toContain('RATEL_CHILD_ERROR');
			expect(fs.existsSync(markerPath), '环境泄漏下仍然写了崩溃标记').toBe(false);
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);

	it('写收敛条件 - 在途写归零前不返回,超过上限硬失败而非静默放过', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-t8-quiesce-'));
		// 120ms 的在途写:固定 25ms 睡眠的实现会在它结算前就返回。
		const storage = new CrashPointStorage(root, createCrashHookState(null), undefined, { writeDelayMs: 120 });
		try {
			const started = Date.now();
			const write = storage.upsertFile(path.join(root, 'index.json'), '{"items":[]}');
			expect(storage.pendingWrites(), '写已发起但未计入在途').toBe(1);
			await storage.waitForWriteQuiescence(5_000);
			expect(storage.pendingWrites(), '等待返回时仍有在途写').toBe(0);
			expect(Date.now() - started, '未等到在途写结算就返回(说明条件被放空)').toBeGreaterThanOrEqual(100);
			await write;
			expect(fs.existsSync(path.join(root, 'index.json'))).toBe(true);

			// 红:上限小于在途写耗时时必须报错 —— 证明收敛条件不是「恒定通过」的空断言。
			const slow = storage.upsertFile(path.join(root, 'index.json'), '{"items":[]}');
			await expect(storage.waitForWriteQuiescence(10)).rejects.toThrow(/未收敛/);
			await slow;
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	it('装配句柄 dispose 走写收敛条件 - 在途写结算后才返回', async () => {
		const scenario = createScenario('ratel-t8-dispose-quiesce-', ['a.md']);
		try {
			const harness = await assembleIndexHarness({
				indexRoot: scenario.indexRoot,
				vaultDir: scenario.vaultDir,
				notePaths: listMarkdownFiles(scenario.vaultDir),
				embedding: new RecordingEmbeddingPort(DIMENSIONS),
				dimensions: DIMENSIONS,
				storageWriteDelayMs: 120,
			});
			// 制造一次真实落盘,并等到它进入存储层(可观测计数;上限明确,不是固定睡眠猜窗口)。
			const writeStartedAt = Date.now();
			const write = harness.store.replaceFile({
				path: 'notes/a.md',
				commitId: 'quiesce-probe',
				blocks: [{ id: 'notes/a.md#chunk-0', vector: new Array<number>(DIMENSIONS).fill(0), metadata: {} }],
			});
			const enterDeadline = Date.now() + 5_000;
			while (harness.pendingWrites() === 0 && Date.now() < enterDeadline) {
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
			}
			expect(harness.pendingWrites(), '在途写没有进入存储层').toBeGreaterThan(0);

			await harness.dispose();
			expect(harness.pendingWrites(), 'dispose 返回时仍有在途写').toBe(0);
			// 这次在途写要 120ms 才结算:固定睡眠 25ms 的实现会在它结算前就返回。
			expect(Date.now() - writeStartedAt, 'dispose 未等到在途写结算就返回').toBeGreaterThanOrEqual(100);
			await write;
		} finally {
			await disposeScenario(scenario);
		}
	}, 120_000);
});
