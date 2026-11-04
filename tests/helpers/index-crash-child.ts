/**
 * @file tests/helpers/index-crash-child.ts
 * @description 崩溃验收夹具 — 宿主无关的索引管线装配 + 独立子进程入口(按阶段强制退出)
 * @module tests/helpers/index-crash-child
 * @depends src/core/index-runtime-assembly, src/core/persistent-index-backend, src/core/index-manager,
 *   src/core/index-manifest, src/adapters/atomic-index-storage, src/adapters/vector-vectra,
 *   src/utils/hash, src/worker/chunker, tests/helpers/index-reliability-fixture
 *
 * 关键路径(T8 checkbox 1):
 * - 管线装配只走 `core/index-runtime-assembly`(不 import obsidian、不依赖 `Plugin` 类字段),
 *   因此父进程与子进程都能在**没有任何宿主替身**的前提下构造完整索引管线。
 * - 子进程入口由**命令行参数**判定({@link isCrashChildEntryArgv}),配置仍按 `RATEL_CRASH_CHILD_*`
 *   环境变量读取。配置用环境变量是因为它便于父进程传值,但入口判据**不能**用环境变量:
 *   父进程 vitest 也 import 本模块,环境变量会被子进程/同一进程的后续 fork 继承,
 *   一旦泄漏到 vitest worker 就会让它按阶段 `SIGKILL` 自杀。命令行参数不继承,因此安全。
 * - 子进程在指定阶段写标记后 `SIGKILL` 自杀:不依赖退出回调保存任何索引状态,
 *   磁盘状态就是真实崩溃现场。
 * - 所有磁盘读写都落在调用方给的临时目录;本文件不读真实 Vault、不碰网络、不下载模型。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { PersistentIndexBackend } from '../../src/core/persistent-index-backend';
import { IndexManager } from '../../src/core/index-manager';
import { IndexManifest, resolveIndexManifestPath, CURRENT_CHUNKER_VERSION } from '../../src/core/index-manifest';
import type { IndexFileJournal } from '../../src/core/index-file-journal';
import type { CoordinatorJournalPort, IndexTaskCoordinator } from '../../src/core/index-task-coordinator';
import type { IndexWriteOwner } from '../../src/core/index-write-owner';
import type { IndexGenerations } from '../../src/core/index-generations';
import type { IndexConfigDescriptor } from '../../src/core/index-persistence-types';
import { computeConfigFingerprint } from '../../src/core/index-persistence-types';
import { setupWritableIndexRuntime } from '../../src/core/index-runtime-assembly';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import { T0_CHUNK_OPTIONS, FakeEmbeddingPort } from './index-reliability-fixture';

// ---------------------------------------------------------------------------
// 崩溃阶段
// ---------------------------------------------------------------------------

/**
 * 强制退出阶段 — 与 spec §2 的退出位置表逐项对应。
 *
 * - `prepared-before`:分片已落盘、`prepared.json` 尚未落盘(不完整准备数据,不可重放);
 * - `prepared-after`:待提交事务已落盘、向量尚未提交(应重放暂存向量,零重复嵌入);
 * - `vector-before`:待提交事务已落盘、向量替换尚未开始(应重放暂存向量,零重复嵌入);
 * - `vector-after`:向量事务已落盘、文件完成记录尚未落盘(应补写完成记录,零重复嵌入);
 * - `receipt-before`:向量事务已落盘、完成记录写入尚未开始(应补写完成记录,零重复嵌入);
 * - `receipt-after`:文件记录已落盘、事务目录尚未清理(应只清理,零重复嵌入);
 * - `cleanup-before`:文件记录已落盘、事务目录删除尚未开始(应只清理,零重复嵌入);
 * - `commit-after-cleanup`:提交已返回且事务目录已清理(应完全复用)。
 */
export const CRASH_STAGES = [
	'prepared-before',
	'prepared-after',
	'vector-before',
	'vector-after',
	'receipt-before',
	'receipt-after',
	'cleanup-before',
	'commit-after-cleanup',
] as const;

export type CrashStage = (typeof CRASH_STAGES)[number];

/** 崩溃钩子状态 — 存储与日志包装共用同一份计数。 */
export interface CrashHookState {
	/** 目标阶段;null 表示不注入崩溃。 */
	readonly stage: CrashStage | null;
	/** 先让前 N 篇文件完整提交,再对第 N+1 篇生效(用于「已提交文件零重复嵌入」)。 */
	readonly afterFiles: number;
	/**
	 * 已落盘的完成记录数(含刚落盘但尚未清理事务的当前文件)。
	 *
	 * 关键路径:写入前/后阶段在**自增之前**读它,以 `>= afterFiles` 选中第 N+1 篇;
	 * `cleanup-before` 在 receipt 落盘并自增后读取,因此改用 `> afterFiles` 选中同一篇。
	 */
	receiptsSeen: number;
	/** 已有已落盘的 `prepared.json`(用于把「文件事务的向量提交」与建库时的索引创建区分开)。 */
	preparedSeen: boolean;
	/** 已返回的提交数。 */
	commitsSeen: number;
	/** 是否已经触发过(只触发一次)。 */
	crashed: boolean;
}

/**
 * 创建崩溃钩子状态。
 *
 * @param stage - 目标阶段;null 表示不注入。
 * @param afterFiles - 先放行的完整提交篇数,默认 0。
 * @returns 可变状态对象。
 */
export function createCrashHookState(stage: CrashStage | null, afterFiles = 0): CrashHookState {
	return { stage, afterFiles, receiptsSeen: 0, preparedSeen: false, commitsSeen: 0, crashed: false };
}

/** 崩溃现场标记 — 父进程据此确认「确实在期望阶段被强制退出」。 */
export interface CrashMarker {
	stage: CrashStage;
	/** 触发时的相对路径(诊断用)。 */
	relativePath: string;
	/** 触发时的墙钟时间。 */
	at: number;
}

/**
 * 强制退出当前进程 — 先同步写标记文件与 stdout,再 SIGKILL。
 *
 * 关键路径:标记用 `fs.writeFileSync` 落盘后才自杀;`fs.writeSync(1, ...)`
 * 让父进程即使只拿到 stdout 也能判定阶段。两者都**不承载索引状态** —— 索引状态只存在于真实索引目录。
 * 这里**不做 `fsyncSync`**:`SIGKILL` 杀的是本进程,内核持有的 page cache 不随进程消亡,
 * 标记照常会被刷盘;`fsync` 只对「整机掉电」有意义,而本夹具不模拟掉电。加 `fsync` 只会
 * 给每次崩溃注入多一次磁盘同步,收益为零。
 *
 * @param state - 崩溃钩子状态(负责只触发一次)。
 * @param markerPath - 标记文件绝对路径;为空时只写 stdout。
 * @param stage - 触发的阶段。
 * @param relativePath - 触发时的相对路径。
 */
export function forceCrash(state: CrashHookState, markerPath: string | undefined, stage: CrashStage, relativePath: string): void {
	if (state.crashed) return;
	state.crashed = true;
	const marker: CrashMarker = { stage, relativePath, at: Date.now() };
	const line = `RATEL_CRASH ${stage} ${relativePath}\n`;
	try {
		fs.writeSync(1, line);
	} catch {
		// stdout 关闭(极少数宿主形态)时不影响标记文件这条权威通道。
	}
	if (markerPath !== undefined) {
		try {
			fs.writeFileSync(markerPath, JSON.stringify(marker), 'utf8');
		} catch {
			// 标记文件写不进去时仍按阶段自杀:磁盘现场本身才是验收依据。
		}
	}
	process.kill(process.pid, 'SIGKILL');
	// 理论上不可达;防御性抛出避免「自杀失败」被当成正常完成。
	throw new Error(`崩溃注入未生效:${stage}`);
}

// ---------------------------------------------------------------------------
// 可注入崩溃点的原子存储
// ---------------------------------------------------------------------------

/** 完成记录目录名 — 与 `IndexFileJournal` 的目录契约一致。 */
const JOURNAL_FILES_DIRNAME = 'files';
/** 待提交事务目录名。 */
const JOURNAL_PENDING_DIRNAME = 'pending';
/** 完成 `prepared.json` 的文件名。 */
const JOURNAL_PREPARED_FILENAME = 'prepared.json';

/**
 * 「已收敛」需要连续无新写的事件循环轮次数。
 *
 * 关键路径:vectra 的同一次事务会顺序写多个文件,两次写之间有计数归零的间隙;
 * 单个轮次足以让纯微任务链上的后续写开始,取 2 是留给「写之间还夹了一次 I/O 回调」的余量。
 */
const QUIESCENT_TURNS = 2;

/**
 * 原子存储的崩溃注入包装 — 在真实写入之前或完成之后按阶段判定。
 *
 * 关键路径:before 阶段必须放在 `super.upsertFile` 之前,after 阶段放在其后;
 * 因此 before 现场尚未发生目标写入,after 现场则是完整的原子替换结果,两者都不会留下半截 JSON。
 *
 * 附带职责(取代调用方的固定睡眠):统计在途写,给装配句柄一个**可判定**的收敛条件。
 * 固定「等 25ms」是在猜窗口 —— 猜短了让断言与真实磁盘赛跑,猜长了拖慢每个用例;
 * 「计数归零且若干个事件循环轮次内没有新写」是可观测事实,超过上限直接抛错而不是静默放过。
 */
export class CrashPointStorage extends AtomicIndexStorage {
	private readonly root: string;
	private readonly state: CrashHookState;
	private readonly markerPath: string | undefined;
	/** 注入的在途写耗时 — 只给「收敛条件」用例用,生产路径为 0。 */
	private readonly writeDelayMs: number;
	/** 在途写计数。 */
	private inFlightWrites = 0;
	/** 已开始的写总数(单调)— 用于判定「归零之后又起了新写」。 */
	private writeEpoch = 0;
	/** 等待「计数归零」的醒觉者。 */
	private readonly quiescentWaiters = new Set<() => void>();

	constructor(
		generationRoot: string,
		state: CrashHookState,
		markerPath?: string,
		options: { writeDelayMs?: number } = {},
	) {
		super({ generationRoot });
		this.root = path.resolve(generationRoot);
		this.state = state;
		this.markerPath = markerPath;
		this.writeDelayMs = options.writeDelayMs ?? 0;
	}

	/** 是否对「第 N+1 篇」生效(前 N 篇已产生完成记录)。 */
	private eligible(): boolean {
		return this.state.receiptsSeen >= this.state.afterFiles;
	}

	/** 在途写计数 — 收敛判定的可观测依据。 */
	pendingWrites(): number {
		return this.inFlightWrites;
	}

	/**
	 * 等待在途写收敛 — 可判定的收敛条件。
	 *
	 * 关键路径:收敛 = 「计数归零」**且**「连续 {@link QUIESCENT_TURNS} 个事件循环轮次内没有新写开始」。
	 * 只看「计数归零」是不够的:vectra 的一次文档事务会**顺序**写多个文件
	 * (`LocalDocumentIndex.endUpdate` 先写索引本体、再写 catalog),两者之间存在计数归零的
	 * 间隙 —— 只看计数会让判定落在间隙里,后续那次写就跑到返回之后去了。
	 * `setImmediate` 是事件循环轮次而不是墙钟延迟:它只用来确认「同一事务链上还有没有后续写」,
	 * 条件本身仍由可观测计数决定;超过 `timeoutMs` 上限则**硬失败**,而不是当成功放过
	 * (静默放过就等于把断言改松)。
	 *
	 * @param timeoutMs - 明确上限(毫秒)。
	 * @throws {Error} 上限内仍未收敛。
	 */
	async waitForWriteQuiescence(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			await this.awaitZeroWrites(deadline);
			const epoch = this.writeEpoch;
			for (let turn = 0; turn < QUIESCENT_TURNS; turn++) {
				await new Promise<void>((resolve) => { setImmediate(resolve); });
				if (this.inFlightWrites !== 0 || this.writeEpoch !== epoch) break;
				if (turn === QUIESCENT_TURNS - 1) return;
			}
			if (this.inFlightWrites === 0 && this.writeEpoch === epoch) return;
			if (Date.now() >= deadline) break;
		}
		throw new Error(`索引写入未收敛:${timeoutMs}ms 内仍有 ${this.inFlightWrites} 个在途写入(${this.root})`);
	}

	/** 事件驱动地等到计数归零;到 `deadline` 仍未归零则交回调用方按上限处理。 */
	private async awaitZeroWrites(deadline: number): Promise<void> {
		while (this.inFlightWrites > 0) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) return;
			await new Promise<void>((resolve) => {
				let timer: ReturnType<typeof setTimeout>;
				const wake = (): void => { clearTimeout(timer); resolve(); };
				timer = setTimeout(() => { this.quiescentWaiters.delete(wake); resolve(); }, remaining);
				this.quiescentWaiters.add(wake);
			});
		}
	}

	/** 进入一次写 — 同步执行,保证调用方一发起就计入在途。 */
	private beginWrite(): void {
		this.inFlightWrites += 1;
		this.writeEpoch += 1;
	}

	/** 结束一次写 — 归零时唤醒全部等待者。 */
	private endWrite(): void {
		this.inFlightWrites -= 1;
		if (this.inFlightWrites !== 0) return;
		const waiters = [...this.quiescentWaiters];
		this.quiescentWaiters.clear();
		for (const resolve of waiters) resolve();
	}

	/** 把一次落盘调用包进在途计数(失败也要归还计数)。 */
	private async trackWrite<T>(operation: () => Promise<T>): Promise<T> {
		this.beginWrite();
		try {
			return await operation();
		} finally {
			this.endWrite();
		}
	}

	async upsertFile(filePath: string, content: Buffer | string): Promise<void> {
		await this.trackWrite(async () => {
			if (this.writeDelayMs > 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, this.writeDelayMs));
			}
			this.onBeforeWrite(filePath);
			await super.upsertFile(filePath, content);
			this.onWritten(filePath);
		});
	}

	async createFile(filePath: string, content: Buffer | string): Promise<void> {
		await this.trackWrite(() => super.createFile(filePath, content));
	}

	async createFolder(folderPath: string): Promise<void> {
		await this.trackWrite(() => super.createFolder(folderPath));
	}

	async deleteFile(filePath: string): Promise<void> {
		await this.trackWrite(() => super.deleteFile(filePath));
	}

	async deleteFolder(folderPath: string): Promise<void> {
		await this.trackWrite(() => super.deleteFolder(folderPath));
	}

	/** 写入开始前的阶段判定 — 目标原子替换尚未执行,不得用前一阶段 after 代替。 */
	private onBeforeWrite(filePath: string): void {
		const stage = this.state.stage;
		if ((stage !== 'vector-before' && stage !== 'receipt-before') || this.state.crashed) return;
		const relativePath = path.relative(this.root, path.resolve(filePath)).split(path.sep).join('/');
		const name = path.posix.basename(relativePath);
		if (relativePath === 'index.json' && stage === 'vector-before' && this.state.preparedSeen && this.eligible()) {
			forceCrash(this.state, this.markerPath, 'vector-before', relativePath);
		}
		if (
			relativePath.startsWith(`${JOURNAL_FILES_DIRNAME}/`)
			&& name.endsWith('.json')
			&& stage === 'receipt-before'
			&& this.state.preparedSeen
			&& this.eligible()
		) {
			forceCrash(this.state, this.markerPath, 'receipt-before', relativePath);
		}
	}

	/** 写入完成后的阶段判定 — 绝不改变写入结果。 */
	private onWritten(filePath: string): void {
		const stage = this.state.stage;
		if (stage === null || this.state.crashed) return;
		const relativePath = path.relative(this.root, path.resolve(filePath)).split(path.sep).join('/');
		const name = path.posix.basename(relativePath);
		if (relativePath.startsWith(`${JOURNAL_PENDING_DIRNAME}/`)) {
			if (name === JOURNAL_PREPARED_FILENAME) {
				this.state.preparedSeen = true;
				if (stage === 'prepared-after' && this.eligible()) {
					forceCrash(this.state, this.markerPath, 'prepared-after', relativePath);
				}
				return;
			}
			// 分片:第一个分片落盘时 prepared.json 必然还不存在。
			if (stage === 'prepared-before' && this.eligible()) {
				forceCrash(this.state, this.markerPath, 'prepared-before', relativePath);
			}
			return;
		}
		if (relativePath === 'index.json') {
			// 关键路径:建库时的索引创建也写 index.json;只有「已有 prepared 事务」之后的
			// 索引写入才是文件事务的向量提交。
			if (stage === 'vector-after' && this.state.preparedSeen && this.eligible()) {
				forceCrash(this.state, this.markerPath, 'vector-after', relativePath);
			}
			return;
		}
		if (relativePath.startsWith(`${JOURNAL_FILES_DIRNAME}/`) && name.endsWith('.json')) {
			// 关键路径(与其它阶段一致):**先按「此前已有几条完成记录」判定,再自增**。
			// 先自增会把 `afterFiles = N` 的崩溃点挪到第 N 篇,而契约与文档说的是「先放行前 N 篇,
			// 再对第 N+1 篇生效」;当前默认 N=0 掩盖了这个 off-by-one。
			if (stage === 'receipt-after' && this.eligible()) {
				forceCrash(this.state, this.markerPath, 'receipt-after', relativePath);
			}
			this.state.receiptsSeen += 1;
		}
	}
}

/**
 * 在事务目录的真实 `rm` 入口前注入清理前崩溃。
 *
 * 关键路径:生产清理由 `IndexFileJournal` 直接调用 `fs.promises.rm`,不经过原子存储;
 * 因此必须在同一 fs 门面拦截目标调用,不能拿 receipt 写完后的时点冒充 cleanup-before。
 */
function installCleanupBeforeCrash(
	generationRoot: string,
	state: CrashHookState,
	markerPath?: string,
): () => void {
	const originalRm = fs.promises.rm.bind(fs.promises);
	const wrappedRm = (async (
		target: Parameters<typeof originalRm>[0],
		options?: Parameters<typeof originalRm>[1],
	) => {
		if (typeof target === 'string' && !state.crashed && state.preparedSeen && state.receiptsSeen > state.afterFiles) {
			const relativePath = path.relative(generationRoot, path.resolve(target)).split(path.sep).join('/');
			if (/^pending\/[^/]+$/.test(relativePath)) {
				forceCrash(state, markerPath, 'cleanup-before', relativePath);
			}
		}
		await originalRm(target, options);
	}) as typeof fs.promises.rm;
	fs.promises.rm = wrappedRm;
	return () => {
		if (fs.promises.rm === wrappedRm) fs.promises.rm = originalRm;
	};
}

/**
 * 日志包装 — 在提交返回后判定 `commit-after-cleanup` 阶段。
 *
 * 关键路径:成功提交的日志清理发生在 `IndexFileJournal.commit` 内部(临时目录删除),
 * 因此「提交已返回」等价于「日志已清理」。可选成员按存在性原样转发,避免把「未实现核对」
 * 悄悄变成「核对结果为无记录」。
 */
export function wrapJournalForCrash(
	journal: IndexFileJournal,
	state: CrashHookState,
	markerPath?: string,
): CoordinatorJournalPort {
	const port: CoordinatorJournalPort = {
		prepare: (input) => journal.prepare(input),
		commit: async (transactionId) => {
			const result = await journal.commit(transactionId);
			const skip = state.commitsSeen < state.afterFiles;
			state.commitsSeen += 1;
			if (!skip && state.stage === 'commit-after-cleanup') {
				forceCrash(state, markerPath, 'commit-after-cleanup', transactionId);
			}
			return result;
		},
		cleanup: (transactionId) => journal.cleanup(transactionId),
		readReceipt: (p) => journal.readReceipt(p),
	};
	if (journal.listReceipts !== undefined) port.listReceipts = () => journal.listReceipts();
	if (journal.listPathStates !== undefined) port.listPathStates = () => journal.listPathStates();
	if (journal.isGenerationQuarantined !== undefined) {
		port.isGenerationQuarantined = () => journal.isGenerationQuarantined();
	}
	if (journal.listTombstones !== undefined) port.listTombstones = () => journal.listTombstones();
	return port;
}

// ---------------------------------------------------------------------------
// 合成 Vault(只读磁盘)
// ---------------------------------------------------------------------------

/** 磁盘 Vault 端口 — 枚举给定目录下的 `.md`,按相对路径排序保证跨进程顺序一致。 */
export interface DiskVaultPort {
	listMarkdownFiles(): string[];
	readFile(p: string): Promise<string>;
	stat(p: string): { mtime: number; size?: number } | null;
}

/**
 * 递归枚举目录下的 `.md` 文件(相对路径,字典序)。
 *
 * @param vaultDir - 合成 Vault 根目录。
 * @returns 相对路径列表。
 */
export function listMarkdownFiles(vaultDir: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.md')) {
				found.push(path.relative(vaultDir, full).split(path.sep).join('/'));
			}
		}
	};
	walk(vaultDir);
	return found.sort();
}

/**
 * 构造只读磁盘 Vault 端口。
 *
 * @param vaultDir - 合成 Vault 根目录。
 * @param notePaths - 参与枚举的相对路径(缺省现场扫描)。
 * @returns Vault 端口。
 */
export function createDiskVault(vaultDir: string, notePaths?: readonly string[]): DiskVaultPort {
	const paths = notePaths === undefined ? listMarkdownFiles(vaultDir) : [...notePaths];
	return {
		listMarkdownFiles: () => [...paths],
		readFile: (p) => fsp.readFile(path.join(vaultDir, p), 'utf8'),
		stat: (p) => {
			try {
				const stat = fs.statSync(path.join(vaultDir, p));
				return { mtime: stat.mtimeMs, size: stat.size };
			} catch {
				return null;
			}
		},
	};
}

/**
 * 写入合成笔记到临时 Vault。
 *
 * @param vaultDir - 目标目录。
 * @param notes - 路径与正文。
 * @returns 相对路径列表(字典序)。
 */
export function writeNotes(vaultDir: string, notes: Array<{ path: string; content: string }>): string[] {
	for (const note of notes) {
		const full = path.join(vaultDir, note.path);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, note.content, 'utf8');
	}
	return listMarkdownFiles(vaultDir);
}

// ---------------------------------------------------------------------------
// 管线装配(父/子共用)
// ---------------------------------------------------------------------------

/**
 * `dispose` 等待在途写收敛的明确上限。
 *
 * 关键路径:取值远小于用例级 120s 超时,因此「真有不收敛的落盘」会以夹具错误暴露,
 * 而不是把整个用例拖到 vitest 超时(那会让清理逻辑没有机会执行)。
 */
const DISPOSE_WRITE_QUIESCE_TIMEOUT_MS = 5_000;

/** 夹具固定配置 — 与 `FakeEmbeddingPort` 的身份一致,父/子两侧必须算出同一指纹。 */
export function harnessConfig(dimensions: number): IndexConfigDescriptor {
	return {
		embeddingModelId: 'test:deterministic',
		embeddingModelRevision: null,
		embeddingDimension: dimensions,
		chunkerVersion: CURRENT_CHUNKER_VERSION,
		chunkSize: T0_CHUNK_OPTIONS.maxTokens,
		chunkOverlap: T0_CHUNK_OPTIONS.overlapTokens,
		embeddingTextVersion: null,
	};
}

/** 装配选项。 */
export interface HarnessOptions {
	/** 索引根 `.index/`(临时目录内的绝对路径)。 */
	indexRoot: string;
	/** 合成 Vault 根目录。 */
	vaultDir: string;
	/** 参与枚举的相对路径。 */
	notePaths: readonly string[];
	/** 嵌入端口(父进程用可计数实现)。 */
	embedding: EmbeddingPort;
	/** 向量维度。 */
	dimensions: number;
	/** 崩溃注入状态;不传表示跑完整一轮。 */
	crash?: CrashHookState;
	/** 崩溃标记文件路径。 */
	markerPath?: string;
	/** 注入的在途写耗时(毫秒)— 只给「收敛条件」用例复现未结算落盘,生产路径不传。 */
	storageWriteDelayMs?: number;
}

/** 已装配的索引链路句柄。 */
export interface IndexHarness {
	readonly indexRoot: string;
	readonly indexDir: string;
	readonly generationId: string;
	readonly store: VectraStore;
	readonly journal: IndexFileJournal;
	readonly coordinator: IndexTaskCoordinator;
	readonly generations: IndexGenerations;
	readonly lease: IndexWriteOwner;
	readonly manager: IndexManager;
	/** 跑一轮启动索引(与生产 `IndexController.onLayoutReady(true)` 同一后端路径)。 */
	run(): Promise<{ indexed: number; errors: number } | null>;
	/** 装配期全部存储实例的在途写合计 — `dispose` 收敛条件的可观测视图。 */
	pendingWrites(): number;
	/** 停看护、销毁协调器、等待在途写收敛并释放写所有权。 */
	dispose(): Promise<void>;
}

/** 协调器模式下不会走 Worker 请求;给出最小替身,避免夹具依赖真实 WorkerManager。 */
function workerStub(): WorkerManager {
	const notUsed = (): never => {
		throw new Error('夹具:协调器模式不应发出 Worker 请求');
	};
	return {
		runExclusive: <T>(operation: () => Promise<T>): Promise<T> => operation(),
		request: notUsed,
		clearProgressCallback: () => undefined,
		setProgressCallback: () => undefined,
		cancelIndex: () => false,
	} as unknown as WorkerManager;
}

/**
 * 装配完整索引管线(代际 → owner → 存储 → 日志 → 协调器 → 后端 → 经理)。
 *
 * 关键路径:唯一入口是 `setupWritableIndexRuntime`,因此子进程与父进程看到的是同一份
 * 生产装配逻辑;夹具只注入嵌入端口与(可选的)崩溃观测点。
 *
 * @param options - 装配选项。
 * @returns 链路句柄。
 */
export async function assembleIndexHarness(options: HarnessOptions): Promise<IndexHarness> {
	const config = harnessConfig(options.dimensions);
	const configFingerprint = await computeConfigFingerprint(config);
	const vault = createDiskVault(options.vaultDir, options.notePaths);
	const crash = options.crash;
	// 关键路径:装配期创建的每个存储实例都要能被 `dispose` 查询在途写 —— 收敛条件必须覆盖
	// 真实参与落盘的那一个,而不是另建一个「观测用」实例。
	const storages: CrashPointStorage[] = [];
	const storageOptions = options.storageWriteDelayMs === undefined ? {} : { writeDelayMs: options.storageWriteDelayMs };
	const runtime = await setupWritableIndexRuntime({
		indexRoot: options.indexRoot,
		config,
		configFingerprint,
		vault,
		embedding: options.embedding,
		getChunkOptions: () => T0_CHUNK_OPTIONS,
		chunkLimits: {
			chunkSize: T0_CHUNK_OPTIONS.maxTokens,
			chunkOverlap: T0_CHUNK_OPTIONS.overlapTokens,
		},
		expectedDimension: options.dimensions,
		createStorage: (root) => {
			const storage = new CrashPointStorage(root, crash ?? createCrashHookState(null), options.markerPath, storageOptions);
			storages.push(storage);
			return storage;
		},
		...(crash === undefined
			? {}
			: { wrapJournal: (journal: IndexFileJournal) => wrapJournalForCrash(journal, crash, options.markerPath) }),
	});
	const restoreCleanupCrash = crash?.stage === 'cleanup-before'
		? installCleanupBeforeCrash(runtime.indexDir, crash, options.markerPath)
		: undefined;
	const store = runtime.pipeline.store;
	// 关键路径:先把建库时的 index.json 落盘,否则它与真实文件事务的向量提交会竞争崩溃判定。
	await store.init();
	const manifest = new IndexManifest(resolveIndexManifestPath(runtime.indexDir));
	const backend = new PersistentIndexBackend({
		indexDir: runtime.indexDir,
		manifest,
		worker: workerStub(),
		getStore: () => store,
		vault,
		getBuildStamp: () => ({
			chunkerVersion: CURRENT_CHUNKER_VERSION,
			chunkSize: T0_CHUNK_OPTIONS.maxTokens,
			chunkOverlap: T0_CHUNK_OPTIONS.overlapTokens,
			embedModelId: config.embeddingModelId,
		}),
		getChunkOptions: () => ({
			maxTokens: T0_CHUNK_OPTIONS.maxTokens,
			overlapTokens: T0_CHUNK_OPTIONS.overlapTokens,
		}),
		fileRecords: runtime.pipeline.journal,
		getRoundCounters: () => runtime.pipeline.coordinator.counters(),
		getEpoch: () => runtime.lease.epoch,
		getTaskId: () => String(runtime.pipeline.coordinator.counters().taskId ?? 0),
	});
	const manager = new IndexManager(backend, runtime.pipeline.coordinator);
	let disposed = false;
	return {
		indexRoot: options.indexRoot,
		indexDir: runtime.indexDir,
		generationId: runtime.generationId,
		store,
		journal: runtime.pipeline.journal,
		coordinator: runtime.pipeline.coordinator,
		generations: runtime.generations,
		lease: runtime.lease,
		manager,
		run: () => manager.onLayoutReady(),
		pendingWrites: () => storages.reduce((total, storage) => total + storage.pendingWrites(), 0),
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			runtime.pipeline.stallWatchdog.stop();
			runtime.pipeline.coordinator.destroy();
			restoreCleanupCrash?.();
			// 关键路径:先把在途写收敛到归零,再释放写所有权并返回。
			// 这里是**可判定条件**(计数归零)而不是固定睡眠:调用方在本函数返回后就做逐字节
			// 快照与目录删除,任何未结算的落盘都必须在此之前结束;超过上限直接抛错,不静默放过。
			for (const storage of storages) {
				await storage.waitForWriteQuiescence(DISPOSE_WRITE_QUIESCE_TIMEOUT_MS);
			}
			await runtime.lease.release();
		},
	};
}

// ---------------------------------------------------------------------------
// 子进程入口
// ---------------------------------------------------------------------------

/**
 * 子进程入口判据 — **命令行参数**,不是环境变量。
 *
 * 关键路径:父进程 vitest 也 import 本模块。环境变量是可继承的(父进程 fork、CI 环境、
 * `.env` 注入都会带进来),一旦 `RATEL_CRASH_CHILD_*` 泄漏到 vitest worker,worker 就会
 * 按阶段 `SIGKILL` 自杀。命令行参数只在父进程显式传给子进程时存在,不会被继承,
 * 因此可以作为入口判据;配置本身仍走环境变量(便于父进程传值,且泄漏时无害)。
 */
export const CRASH_CHILD_ENTRY_FLAG = '--ratel-crash-child-entry';

/**
 * 判定给定 argv 是否为本夹具的子进程入口。
 *
 * @param argv - 进程参数(通常为 `process.argv`)。
 * @returns 命中入口参数时为 true。
 */
export function isCrashChildEntryArgv(argv: readonly string[]): boolean {
	return argv.includes(CRASH_CHILD_ENTRY_FLAG);
}

/** 子进程环境变量。 */
export interface CrashChildEnv {
	indexRoot: string;
	vaultDir: string;
	markerPath: string | undefined;
	resultPath: string | undefined;
	stage: CrashStage | null;
	afterFiles: number;
	dimensions: number;
	/** 命中该正则的嵌入文本抛错 — 复现「单文件推理失败」。 */
	failOnText: RegExp | undefined;
	/** 装配前刻意挂起的毫秒数 — 只用于验证父进程的超时/杀死/清理分支。 */
	hangMs: number | undefined;
}

/**
 * 从环境变量读取子进程配置。
 *
 * @returns 配置;缺少索引根或 Vault 目录时为 null(调用方据此不做任何事)。
 */
export function readCrashChildEnv(): CrashChildEnv | null {
	const indexRoot = process.env['RATEL_CRASH_CHILD_INDEX_ROOT'];
	const vaultDir = process.env['RATEL_CRASH_CHILD_VAULT_DIR'];
	if (indexRoot === undefined || vaultDir === undefined) return null;
	const rawStage = process.env['RATEL_CRASH_CHILD_STAGE'];
	const stage = CRASH_STAGES.find((candidate) => candidate === rawStage) ?? null;
	const rawAfter = process.env['RATEL_CRASH_CHILD_AFTER_FILES'];
	const afterFiles = rawAfter === undefined ? 0 : Number.parseInt(rawAfter, 10);
	const rawDimensions = process.env['RATEL_CRASH_CHILD_DIMENSIONS'];
	const dimensions = rawDimensions === undefined ? 128 : Number.parseInt(rawDimensions, 10);
	const rawFail = process.env['RATEL_CRASH_CHILD_FAIL_TEXT'];
	const rawHang = process.env['RATEL_CRASH_CHILD_HANG_MS'];
	return {
		indexRoot,
		vaultDir,
		markerPath: process.env['RATEL_CRASH_CHILD_MARKER'],
		resultPath: process.env['RATEL_CRASH_CHILD_RESULT'],
		stage,
		afterFiles: Number.isFinite(afterFiles) ? afterFiles : 0,
		dimensions: Number.isFinite(dimensions) ? dimensions : 128,
		failOnText: rawFail === undefined || rawFail.length === 0 ? undefined : new RegExp(rawFail),
		hangMs: rawHang === undefined ? undefined : Number.parseInt(rawHang, 10),
	};
}

/**
 * 子进程主流程 — 装配管线、跑一轮(或按阶段自杀)、写结果文件。
 *
 * @param env - 子进程配置。
 * @returns 完整跑完时的进程退出码(崩溃路径永不返回)。
 */
export async function runCrashChild(env: CrashChildEnv): Promise<number> {
	if (env.hangMs !== undefined && Number.isFinite(env.hangMs)) {
		// 关键路径:只用于父进程超时分支的验证 —— 这里刻意挂起且不持有任何索引资源,
		// 父进程超时后应 `SIGKILL` 本进程并独立清理场景目录。
		fs.writeSync(1, `RATEL_HANG ${env.hangMs}\n`);
		await new Promise<void>((resolve) => setTimeout(resolve, env.hangMs));
	}
	const crash = createCrashHookState(env.stage, env.afterFiles);
	const embedding = new FakeEmbeddingPort(
		env.dimensions,
		env.failOnText === undefined ? {} : { failWhenTextMatches: env.failOnText },
	);
	const notePaths = listMarkdownFiles(env.vaultDir);
	const harness = await assembleIndexHarness({
		indexRoot: env.indexRoot,
		vaultDir: env.vaultDir,
		notePaths,
		embedding,
		dimensions: env.dimensions,
		crash,
		...(env.markerPath === undefined ? {} : { markerPath: env.markerPath }),
	});
	let indexed = 0;
	let errors = 0;
	let completed = false;
	try {
		const result = await harness.run();
		indexed = result?.indexed ?? 0;
		errors = result?.errors ?? 0;
		completed = true;
	} finally {
		await harness.dispose();
	}
	const summary = {
		indexed,
		errors,
		embedCalls: embedding.callCount,
		embedTexts: embedding.textCount,
		completed,
	};
	if (env.resultPath !== undefined) {
		fs.writeFileSync(env.resultPath, JSON.stringify(summary), 'utf8');
	}
	fs.writeSync(1, `RATEL_DONE ${JSON.stringify(summary)}\n`);
	return 0;
}

// 关键路径:入口判据是**命令行参数**({@link CRASH_CHILD_ENTRY_FLAG}),不是环境变量 ——
// 父进程 vitest 也 import 本文件供复用夹具,而环境变量会被继承;若 `RATEL_CRASH_CHILD_*`
// 从环境泄漏到 vitest worker,以环境变量判定就会让 worker 按阶段 `SIGKILL` 自杀。
// 参数缺失时本模块只导出工具函数,不执行任何主流程。
if (isCrashChildEntryArgv(process.argv)) {
	const env = readCrashChildEnv();
	if (env === null) {
		fs.writeSync(2, 'RATEL_CHILD_ERROR 缺少 RATEL_CRASH_CHILD_INDEX_ROOT / RATEL_CRASH_CHILD_VAULT_DIR\n');
		process.exitCode = 1;
	} else {
		void runCrashChild(env).then(
			(code) => { process.exitCode = code; },
			(error: unknown) => {
				fs.writeSync(2, `RATEL_CHILD_ERROR ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}\n`);
				process.exitCode = 1;
			},
		);
	}
}