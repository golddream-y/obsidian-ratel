/**
 * @file tests/core/index-reliability-scale.test.ts
 * @description 规模与性能验收 — 3000 篇大库、重复嵌入计数、写入行为与 T0 口径相对门槛
 * @module tests/core/index-reliability-scale
 * @depends tests/helpers/index-reliability-scale, tests/helpers/index-reliability-production,
 *   tests/helpers/index-reliability-fixture, src/core/index-task-coordinator, src/core/index-file-journal
 *
 * 关键路径(T8 checkbox 2、4、5):
 * - 大库正文**流式落盘**,内存里只有路径列表;规模证据建立在「端口只暴露路径 + 按需 readFile」之上。
 * - 「已提交版本无重复嵌入」用可计数嵌入端口直接观察:完整构建的 `embed` 调用数等于文件数;
 *   120 篇档断言**嵌入文本多重集合**逐项相等,3000 篇档把同一断言下沉为
 *   **嵌入文本摘要(sha256)多重集合**逐项相等 —— 「等块数文件互相冒名」会让摘要集合不等,
 *   而摘要表只占约 1 MiB,不把全库正文留在内存里。
 * - 性能读数一律**与负载一并记录**;带载读数不得作为门槛依据(计划 checkbox 4 的口径限制)。
 *   门槛判定同时核对**分子臂(被测)与分母臂(基线)**:任一侧超过核数、或分母臂没有负载读数,
 *   一律判 `not-comparable`,并在输出里呈现两侧负载。
 * - 事务/并发上界一律**确定性计数**(日志与嵌入端口的状态转移点),不依赖 20ms 定时采样;
 *   目录差异按**每文件内容 sha256** 比对,不再只比字节数。
 * - 本文件**不跑真实 ONNX**:嵌入端口是确定性假实现,专用配置的 include 面也不含 ONNX 测试;
 *   真实模型耗时按计划在 Sandbox 合成库另测(见证据文档「未验证」一节)。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../../src/utils/hash';
import { chunkMarkdown } from '../../src/worker/chunker';
import type { CoordinatorBlock, CoordinatorJournalPort } from '../../src/core/index-task-coordinator';
import type { EmbeddingPort } from '../../src/ports/embedding';
import {
	FakeEmbeddingPort,
	MemorySampler,
	createTempWorkspace,
	deterministicVector,
	formatBytes,
	median,
	readDiskBlockIds,
	T0_CHUNK_OPTIONS,
	type TempWorkspace,
} from '../helpers/index-reliability-fixture';
import { runProductionIndex } from '../helpers/index-reliability-production';
import {
	assembleScaleHarness,
	blocksForContent,
	BoundaryCountingJournal,
	countPendingDirectories,
	createCountingVault,
	diffSnapshotContents,
	expectedChunkIds,
	formatLoad,
	generateAndWriteNotes,
	readLoad,
	ScaleCountingStorage,
	snapshotDirectoryContents,
	syntheticNoteContent,
	writeBigChunkNote,
	writeNoteFile,
	type LoadReading,
	type ScaleHarness,
	type ScaleHarnessOptions,
	type ScaleWriteCounters,
	type TransactionBoundaryObservations,
} from '../helpers/index-reliability-scale';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 口径开关
// ---------------------------------------------------------------------------

/** 门控开关:开启后跑 3000 篇 @512 维(生产维度)与完整性能读数表。默认只跑 64 维规模矩阵。 */
const SCALE_HEAVY = process.env.RATEL_SCALE === '1';
/**
 * 专用配置标记 — 由 `vitest.index-reliability.config.ts` 的 `test.env` 注入。
 *
 * 关键路径:规模用例里有 3000 篇 @64 维的完整构建(本机约 11–12 分钟)与若干百篇级用例。
 * `npm test`(基础配置)会按 tests 目录下的全部测试文件收集本文件,如果这些用例无条件执行,
 * 默认套件会从约 2 分钟涨到 15 分钟以上。因此重样本默认**只在专用配置**下跑:
 * 专用配置的默认口径仍然覆盖计划要求的 3000 篇矩阵,`npm test` 只跑结构性用例与夹具自检。
 * 显式 `RATEL_SCALE=1` / `RATEL_SCALE_SUITE=1` 可在任意配置下打开它们。
 */
const SCALE_SUITE = process.env.RATEL_SCALE_SUITE === '1';
/** 是否执行重样本用例(3000 篇 / 数百篇级写入行为)。 */
const RUN_HEAVY_SCALE = SCALE_SUITE || SCALE_HEAVY || process.env.RATEL_SCALE_HEAVY_SCALE === '1';
/**
 * 100 篇档三臂 A/B 的门控 — **不包含** `RATEL_SCALE`。
 *
 * 关键路径(规范审查 I2):计划要求的执行命令是
 * `npx vitest run --config vitest.index-reliability.config.ts`,它只注入 `RATEL_SCALE_SUITE=1`。
 * 此前整张性能表都挂在 `RATEL_SCALE=1` 之下,导致计划命令 **一条门槛读数都不产生**、
 * checkbox 4 的判定没有出口。100 篇档 A/B 约 35s,放进专用配置的默认口径;
 * 1000/3000 篇与 512 维读数表仍留在重门控(`RATEL_SCALE=1`)里按机时单独采集。
 */
const RUN_GATE_AB_100 = SCALE_SUITE || SCALE_HEAVY;
/**
 * 默认 3000 篇的维度。
 *
 * 关键路径:写放大是每文件一次全量重写 `index.json`;512 维的 3000 篇单次构建在 100 GiB 量级
 * 的写入之上,默认套件不可接受。因此**默认 64 维**跑 3000 篇的规模断言,512 维的 3000 篇读数
 * 由 `RATEL_SCALE=1` 门控采集。两种口径都在证据文档中如实列出,不把 64 维读数当生产数字。
 */
const DEFAULT_DIMS = 64;
/** 规模用例的主样本数(计划 checkbox 2)。 */
const SCALE_NOTE_COUNT = 3000;
/** 超长文件的块数下界(计划 checkbox 2)。 */
const BIG_CHUNK_TARGET = 200;
/** 超长文件的相对路径。 */
const BIG_NOTE_PATH = 'notes/big-chunk-note.md';

/** 本文件用到的临时工作区 — 每个用例结束即释放,`afterAll` 只作为兜底。 */
const workspaces = new Set<TempWorkspace>();

/** 创建并登记一个临时工作区。 */
function workspace(prefix: string): TempWorkspace {
	const created = createTempWorkspace(prefix);
	workspaces.add(created);
	return created;
}

/**
 * 释放当前登记的全部工作区。
 *
 * 关键路径(测试卫生 S5/S6):1000/3000 篇档的索引目录是 GiB 级,只在 `afterAll` 释放会让
 * 多个臂/样本在整个文件生命周期内并存。这里由 `afterEach` **逐用例**释放(用例失败也照常释放,
 * 与 `try/finally` 等价且不会漏),`beforeEach` 再兜一次底,`afterAll` 作为最后防线。
 */
function releaseWorkspaces(): void {
	for (const created of workspaces) created.dispose();
	workspaces.clear();
}

beforeEach(() => {
	releaseWorkspaces();
});

afterEach(() => {
	releaseWorkspaces();
});

afterAll(() => {
	releaseWorkspaces();
});

// ---------------------------------------------------------------------------
// 观测端口
// ---------------------------------------------------------------------------

/**
 * 记录全部嵌入文本的可计数端口 — 用于断言「无重复嵌入」。
 *
 * 关键路径:记录文本等价于把语料留驻内存,因此**只在小样本**上启用;
 * 大样本只用调用/条数计数(见 `CountingOnlyPort`)。
 */
class RecordingEmbeddingPort implements EmbeddingPort {
	readonly modelId = 'test:deterministic';
	readonly dimensions: number;
	readonly batches: string[][] = [];

	constructor(dimensions: number) {
		this.dimensions = dimensions;
	}

	async embed(texts: string[]): Promise<number[][]> {
		this.batches.push([...texts]);
		// 关键路径:与夹具的确定性假嵌入同一实现,避免两处各写一份哈希规则而漂移。
		return texts.map((text) => deterministicVector(text, this.dimensions));
	}

	/** 全部嵌入文本(调用顺序)。 */
	allTexts(): string[] {
		return this.batches.flat();
	}
}

/** 只计数、不保留文本的嵌入端口 — 大样本专用。 */
class CountingOnlyPort implements EmbeddingPort {
	readonly modelId = 'test:deterministic';
	readonly dimensions: number;
	calls = 0;
	texts = 0;

	constructor(dimensions: number) {
		this.dimensions = dimensions;
	}

	async embed(batch: string[]): Promise<number[][]> {
		this.calls += 1;
		this.texts += batch.length;
		return batch.map((text) => deterministicVector(text, this.dimensions));
	}
}

/** 文本内容摘要 — sha256 前缀 64 位,用于「嵌入文本多重集合」的可比较表示。 */
function digestOf(text: string): bigint {
	return createHash('sha256').update(text, 'utf8').digest().readBigUInt64BE(0);
}

/**
 * 内容摘要多重集合 — 以定长 `BigUint64Array` 累积、按需扩容,支持排序后逐项比较。
 *
 * 关键路径:3000 篇档要把 120 篇档的「嵌入文本多重集合等式」下沉下来,但**不能**把正文
 * 留驻内存。这里只存 8 字节/条的摘要(21670 条约 0.17 MiB),并与「同一分块器 + 同一磁盘正文」
 * 独立算出的期望集合比较。摘要碰撞在确定性输入上概率约 1e-14,不引入抖动。
 */
class DigestMultiset {
	private buffer: BigUint64Array;
	private size = 0;

	constructor(initialCapacity = 1024) {
		this.buffer = new BigUint64Array(initialCapacity);
	}

	/** 追加一条文本摘要。 */
	push(text: string): void {
		if (this.size === this.buffer.length) {
			const grown = new BigUint64Array(this.buffer.length * 2);
			grown.set(this.buffer);
			this.buffer = grown;
		}
		this.buffer[this.size] = digestOf(text);
		this.size += 1;
	}

	/** 元素个数。 */
	length(): number {
		return this.size;
	}

	/** 升序摘要序列(拷贝)。 */
	sorted(): BigUint64Array {
		return this.buffer.slice(0, this.size).sort();
	}
}

/**
 * 摘要计数嵌入端口 — 大样本专用:逐条记录嵌入文本的内容摘要,不保留正文。
 *
 * 关键路径(规范审查 建议 7):3000 篇档此前只有「调用数 == 文件数」+「文本数 == 块数」两式联立,
 * 理论上可被「等块数的文件互相冒名」抵消。这里把 120 篇档的**多重集合等式**下沉到 3000 篇,
 * 与 `expectedDigests` 算出的期望摘要多重集合逐项比较。
 */
class DigestCountingPort implements EmbeddingPort {
	readonly modelId = 'test:deterministic';
	readonly dimensions: number;
	calls = 0;
	texts = 0;
	private readonly digests = new DigestMultiset(4096);

	constructor(dimensions: number) {
		this.dimensions = dimensions;
	}

	async embed(batch: string[]): Promise<number[][]> {
		this.calls += 1;
		this.texts += batch.length;
		for (const text of batch) this.digests.push(text);
		return batch.map((text) => deterministicVector(text, this.dimensions));
	}

	/** 记录到的摘要多重集合(升序)。 */
	multiset(): BigUint64Array {
		return this.digests.sorted();
	}
}

/**
 * 比较两个摘要多重集合。
 *
 * @param actual - 实测摘要(升序)。
 * @param expected - 期望摘要(升序)。
 * @returns 一致时为 null;不一致时给出首个差异与差异总数(避免打印两万个元素)。
 */
function firstDigestMismatch(
	actual: BigUint64Array,
	expected: BigUint64Array,
): { index: number; actual: string; expected: string; mismatches: number } | null {
	if (actual.length !== expected.length) {
		return { index: -1, actual: `${actual.length} 条`, expected: `${expected.length} 条`, mismatches: -1 };
	}
	let mismatches = 0;
	let firstIndex = -1;
	for (let i = 0; i < actual.length; i++) {
		const a = actual[i] ?? 0n;
		const e = expected[i] ?? 0n;
		if (a !== e) {
			mismatches += 1;
			if (firstIndex < 0) firstIndex = i;
		}
	}
	if (mismatches === 0) return null;
	return {
		index: firstIndex,
		actual: (actual[firstIndex] ?? 0n).toString(16),
		expected: (expected[firstIndex] ?? 0n).toString(16),
		mismatches,
	};
}

/**
 * 用同一分块器与同一磁盘正文算出期望摘要多重集合(流式读取,不保留全库正文)。
 *
 * @param vaultDir - 合成 Vault 根目录。
 * @param notePaths - 相对路径列表。
 * @returns 期望摘要(升序)与块数。
 */
function expectedDigests(
	vaultDir: string,
	notePaths: readonly string[],
): { digests: BigUint64Array; chunks: number } {
	const digests = new DigestMultiset(notePaths.length * 8);
	let chunks = 0;
	for (const relative of notePaths) {
		const content = fs.readFileSync(path.join(vaultDir, relative), 'utf8');
		for (const chunk of chunkMarkdown(content, T0_CHUNK_OPTIONS)) {
			digests.push(chunk.embedText);
			chunks += 1;
		}
	}
	return { digests: digests.sorted(), chunks };
}

/** 运行期观察到的计数与边界。 */
interface RunObservations {
	/**
	 * 观察到的 `queued` 最大值 — 在**固定控制流位置**(每次 vault `readFile`/`stat`)读取。
	 *
	 * 关键路径:这是下界而不是上界,只能用于说明量级;上界类断言一律改用 `boundary`
	 * 的确定性计数(见 `TransactionBoundaryObservations`)。
	 */
	maxQueued: number;
	/** 观测点数量(vault 访问次数)。 */
	steps: number;
	/** 事务边界观测(确定性:由日志状态转移点计数)。 */
	boundary: TransactionBoundaryObservations;
	/** 嵌入并发峰值(确定性:由 `embed` 进出点计数)。 */
	maxConcurrentEmbeds: number;
	/** 运行结束时的磁盘 `pending/` 目录项数。 */
	pendingDirsAtEnd: number;
}

/**
 * 运行期观察器 — 只在**固定控制流位置**观测,不使用定时器。
 *
 * 关键路径(代码质量审查 I5/S5):原实现用 20ms `setInterval` 采样,`maxActive` /
 * `maxPendingDirs` 因此只是「采样到的下界」,不足以支撑「同一时刻只有一个活动项/一个未结算事务」
 * 这类上界断言。现在:
 * - `queued` 在每次 vault 访问时读取(仍是下界,只作说明);
 * - 并发/在途/磁盘目录项上界改由**日志与嵌入端口的状态转移点**确定性计数
 *   (`harness.journalBoundary` / `harness.embeddingBoundary`)。
 */
class StepObserver {
	private maxQueued = 0;
	private steps = 0;

	constructor(
		private readonly counters: () => { queued: number },
		private readonly boundary: () => TransactionBoundaryObservations,
		private readonly embeddingConcurrency: () => number,
		private readonly indexDir: () => string,
	) {}

	/** 在一个固定的控制流位置(vault 访问)记录一次。 */
	step(): void {
		this.maxQueued = Math.max(this.maxQueued, this.counters().queued);
		this.steps += 1;
	}

	/** 结束观测并汇总确定性边界计数。 */
	stop(): RunObservations {
		return {
			maxQueued: this.maxQueued,
			steps: this.steps,
			boundary: this.boundary(),
			maxConcurrentEmbeds: this.embeddingConcurrency(),
			pendingDirsAtEnd: countPendingDirectories(this.indexDir()),
		};
	}
}

/** 一次带观测的启动结果。 */
interface ObservedRun {
	/** 真实代际目录(索引落盘处;不等于 `indexRoot`)。 */
	indexDir: string;
	/** 装配耗时(毫秒):构造管线 + `store.init()`,不含 `onLayoutReady()`。 */
	assemblyMs: number;
	indexed: number;
	errors: number;
	elapsedMs: number;
	peaks: { peakHeapUsed: number; peakRss: number; peakExternal: number };
	observations: RunObservations;
	load: LoadReading;
	/** 本轮 `vault.readFile` 调用次数(内存证据:不预构造全库正文)。 */
	vaultReads: number;
	/** 本轮被读取过的不同路径数。 */
	vaultDistinctPaths: number;
	/** 本轮启动**之前的**写入计数快照(装配期写入已被排除)。 */
	countersBefore: ScaleWriteCounters;
	/** 本轮启动**之后的**写入计数快照。 */
	countersAfter: ScaleWriteCounters;
}

/**
 * 装配、观察、跑一轮、可选定点核对,然后销毁。
 *
 * 关键路径:耗时与内存峰值在 `dispose()` 之前读取;负载在开始与结束各采一次,
 * 取 1 分钟负载的**较大者**记录,避免用「跑完刚好降下来」的数字过门。
 *
 * @param options - 装配选项。
 * @param inspect - 运行结束后、销毁前的定点核对(块集合等)。
 * @returns 耗时、内存峰值、计数上界、写入计数与负载。
 */
async function runAndInspect(
	options: ScaleHarnessOptions,
	inspect?: (harness: ScaleHarness) => Promise<void>,
): Promise<ObservedRun> {
	const assemblyStart = process.hrtime.bigint();
	// 关键路径:观测回调在装配期也可能被触发(旧索引探测会 `stat`),但那时观察者尚未建立;
	// 用可变引用延迟绑定,装配期的调用被忽略,观测窗口与 `harness.run()` 对齐。
	let observer: StepObserver | null = null;
	const harness = await assembleScaleHarness({
		...options,
		onCoordinatorStep: () => observer?.step(),
	});
	const assemblyMs = Number(process.hrtime.bigint() - assemblyStart) / 1e6;
	const sampler = new MemorySampler(20);
	observer = new StepObserver(
		() => harness.coordinator.counters(),
		() => harness.journalBoundary.observations(),
		() => harness.embeddingBoundary.observations().maxConcurrentEmbeds,
		() => harness.indexDir,
	);
	const loadBefore = readLoad();
	const countersBefore = harness.storage.counters();
	sampler.start();
	try {
		const started = process.hrtime.bigint();
		const result = await harness.run();
		const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
		const peaks = sampler.stop();
		const observations = observer.stop();
		const countersAfter = harness.storage.counters();
		const loadAfter = readLoad();
		const load = loadBefore.load1 >= loadAfter.load1 ? loadBefore : loadAfter;
		if (!result) throw new Error('规模用例:启动索引未完成(onLayoutReady 返回 null)');
		if (inspect) await inspect(harness);
		return {
			indexDir: harness.indexDir,
			assemblyMs,
			indexed: result.indexed,
			errors: result.errors,
			elapsedMs,
			peaks,
			observations,
			load,
			vaultReads: harness.vault.readCount(),
			vaultDistinctPaths: harness.vault.distinctReadPaths(),
			countersBefore,
			countersAfter,
		};
	} finally {
		sampler.stop();
		await harness.dispose();
	}
}

/** 隔离事务目录的绝对路径。 */
function quarantineTxsDir(indexDir: string): string {
	return path.join(indexDir, 'quarantine', 'transactions');
}

/** 计数 `pending/` 下的目录项(磁盘真值,不依赖内存计数)。 */
function countPendingDirs(indexDir: string): number {
	return countPendingDirectories(indexDir);
}

/** 一次启动的写入增量(索引文件与总写入)。 */
function writeDelta(run: ObservedRun): {
	totalCount: number;
	totalBytes: number;
	totalMs: number;
	indexCount: number;
	indexBytes: number;
	indexMs: number;
} {
	return {
		totalCount: run.countersAfter.totalCount - run.countersBefore.totalCount,
		totalBytes: run.countersAfter.totalBytes - run.countersBefore.totalBytes,
		totalMs: totalMs(run.countersAfter) - totalMs(run.countersBefore),
		indexCount: run.countersAfter.byKind.index.count - run.countersBefore.byKind.index.count,
		indexBytes: run.countersAfter.byKind.index.bytes - run.countersBefore.byKind.index.bytes,
		indexMs: run.countersAfter.byKind.index.ms - run.countersBefore.byKind.index.ms,
	};
}

/** 一次启动按分类的写入增量(次数/字节/耗时)。 */
function kindDelta(run: ObservedRun): Record<string, { count: number; bytes: number; ms: number }> {
	const kinds: Record<string, { count: number; bytes: number; ms: number }> = {};
	for (const kind of Object.keys(run.countersAfter.byKind)) {
		const after = run.countersAfter.byKind[kind as keyof typeof run.countersAfter.byKind];
		const before = run.countersBefore.byKind[kind as keyof typeof run.countersBefore.byKind];
		kinds[kind] = { count: after.count - before.count, bytes: after.bytes - before.bytes, ms: after.ms - before.ms };
	}
	return kinds;
}

/** 全部类别的累计写入耗时(毫秒)。 */
function totalMs(counters: ScaleWriteCounters): number {
	let sum = 0;
	for (const kind of Object.keys(counters.byKind)) {
		sum += counters.byKind[kind as keyof typeof counters.byKind].ms;
	}
	return sum;
}

/** 读文件字节数,不存在时为 0。 */
function fileSizeOrZero(filePath: string): number {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return 0;
	}
}

/** 汇总整库的期望块数与「非空文件数」(流式读取,不保留正文)。 */
function expectedTotals(vaultDir: string, notePaths: readonly string[]): { chunks: number; paths: number } {
	let chunks = 0;
	let paths = 0;
	for (const relative of notePaths) {
		const content = fs.readFileSync(path.join(vaultDir, relative), 'utf8');
		const count = chunkMarkdown(content, T0_CHUNK_OPTIONS).length;
		chunks += count;
		if (count > 0) paths += 1;
	}
	return { chunks, paths };
}

// ---------------------------------------------------------------------------
// 规模用例 — 3000 篇短文档 + 超长文件(checkbox 2)
// ---------------------------------------------------------------------------

describe('规模用例 - 3000 篇短文档 + 超过 200 块的文件(checkbox 2)', () => {
	it.skipIf(!RUN_HEAVY_SCALE)(
		'完整构建 - 块集合逐文件相等、嵌入文本摘要多重集合相等、零变化启动三连测(订正读数在本仓库内复现)',
		async () => {
			const ws = workspace('ratel-t8b-scale-3000-');
			const vaultDir = ws.mkdir('vault');
			const indexRoot = ws.mkdir('index-root');
			const notePaths = generateAndWriteNotes(vaultDir, SCALE_NOTE_COUNT, { bodyChars: 320 });
			const bigChunks = writeBigChunkNote(vaultDir, BIG_NOTE_PATH, BIG_CHUNK_TARGET);
			notePaths.push(BIG_NOTE_PATH);
			expect(bigChunks).toBeGreaterThan(BIG_CHUNK_TARGET);

			const expected = expectedTotals(vaultDir, notePaths);
			const expectedDigestSet = expectedDigests(vaultDir, notePaths);
			const port = new DigestCountingPort(DEFAULT_DIMS);
			const loadBefore = readLoad();
			const observed = await runAndInspect(
				{ indexRoot, vaultDir, notePaths, dimensions: DEFAULT_DIMS, embedding: port },
				async (harness) => {
					// 关键路径:块集合按 ID 序列核对(只比数量会让「旧块残留 + 新块写入」互相抵消)。
					const sampled = [notePaths[0], notePaths[Math.floor(notePaths.length / 2)], BIG_NOTE_PATH].filter(
						(value): value is string => typeof value === 'string',
					);
					for (const relative of sampled) {
						const content = fs.readFileSync(path.join(vaultDir, relative), 'utf8');
						const ids = expectedChunkIds(relative, content);
						const blocks = await harness.store.inspectFile(relative);
						expect(blocks.map((block) => block.id)).toEqual(ids);
					}
					expect(fs.existsSync(quarantineTxsDir(harness.indexDir))).toBe(false);
				},
			);

			expect(observed.errors).toBe(0);
			expect(observed.indexed).toBe(expected.paths);
			// 关键路径:完整构建下每个非空文件恰好一次嵌入调用 —— 重复计算会让调用数大于文件数。
			expect(port.calls).toBe(expected.paths);
			expect(port.texts).toBe(expected.chunks);
			// 关键路径(规范审查 建议 7):把 120 篇档的**嵌入文本多重集合等式**下沉到 3000 篇。
			// 「等块数的文件互相冒名」会让摘要集合不等 —— 只比条数的两式联立无法排除这种情况。
			expect(port.texts).toBe(expectedDigestSet.chunks);
			expect(
				firstDigestMismatch(port.multiset(), expectedDigestSet.digests),
				'每一条嵌入文本都必须与「同一分块器 + 同一磁盘正文」算出的摘要逐项相等',
			).toBeNull();
			// 关键路径:队列按路径合并,因此运行期 queued 的下界不超过文件数(下界说明,非门槛依据)。
			expect(observed.observations.maxQueued).toBeLessThanOrEqual(notePaths.length);
			// 关键路径(代码质量审查 I5):并发与在途上界用**确定性计数**断言,
			// 不再依赖 20ms 采样。3000 篇是最能暴露「批量并发写」的样本。
			expect(observed.observations.maxConcurrentEmbeds).toBeLessThanOrEqual(1);
			expect(observed.observations.boundary.maxConcurrentPrepares).toBeLessThanOrEqual(1);
			expect(observed.observations.boundary.maxInFlight).toBeLessThanOrEqual(1);
			expect(observed.observations.boundary.maxPendingDirs).toBeLessThanOrEqual(1);
			expect(observed.observations.boundary.pendingDirMismatches).toBe(0);
			expect(observed.observations.pendingDirsAtEnd).toBe(0);
			const writes = writeDelta(observed);

			console.log(
				[
					`[T8b 规模] 样本=${notePaths.length}(含 1 篇 ${bigChunks} 块) 维度=${DEFAULT_DIMS}`,
					`耗时=${observed.elapsedMs.toFixed(0)}ms 完成=${observed.indexed} 块数=${expected.chunks}`,
					`嵌入调用=${port.calls}/文本=${port.texts}`,
					`峰值heap=${formatBytes(observed.peaks.peakHeapUsed)} 峰值rss=${formatBytes(observed.peaks.peakRss)}`,
					`写入=${writes.totalCount}次/${formatBytes(writes.totalBytes)}/${writes.totalMs.toFixed(0)}ms 其中索引=${writes.indexCount}次/${formatBytes(writes.indexBytes)}/${writes.indexMs.toFixed(0)}ms`,
					`maxQueued(下界)=${observed.observations.maxQueued} 嵌入并发峰值=${observed.observations.maxConcurrentEmbeds} 在途峰值=${observed.observations.boundary.maxInFlight} 磁盘pending峰值=${observed.observations.boundary.maxPendingDirs} 步进点=${observed.observations.steps}`,
					`读文件=${observed.vaultReads}次/路径=${observed.vaultDistinctPaths}条`,
					`负载(起)=${formatLoad(loadBefore)} 负载(止/高)=${formatLoad(observed.load)}`,
				].join(' | '),
			);

			// ------------------------------------------------------------------
			// 3000 篇零变化启动的三连测(规范审查 I5:原订正读数来自仓库外临时探针)
			// ------------------------------------------------------------------
			// 关键路径:这一段的唯一目的是让「3000 篇零变化启动」的订正读数**在仓库内可复现** ——
			// 复现命令就是本计划要求的 `npx vitest run --config vitest.index-reliability.config.ts`
			// (本用例由专用配置的 `RATEL_SCALE_SUITE=1` 打开)。读数一律带负载记录。
			const zeroRuns: number[] = [];
			const zeroLoads: LoadReading[] = [];
			for (let restart = 1; restart <= 3; restart++) {
				const zeroPort = new CountingOnlyPort(DEFAULT_DIMS);
				const zero = await runAndInspect({
					indexRoot,
					vaultDir,
					notePaths,
					dimensions: DEFAULT_DIMS,
					embedding: zeroPort,
				});
				expect(zero.errors).toBe(0);
				expect(zero.indexed).toBe(0);
				expect(zeroPort.calls).toBe(0);
				expect(zeroPort.texts).toBe(0);
				// 关键路径:零变化启动不写向量数据 —— 写入计数逐类为零。
				const zeroWrites = writeDelta(zero);
				expect(zeroWrites.totalCount).toBe(0);
				expect(zeroWrites.indexCount).toBe(0);
				expect(zero.observations.pendingDirsAtEnd).toBe(0);
				zeroRuns.push(zero.elapsedMs);
				zeroLoads.push(zero.load);
			}
			const sortedZero = [...zeroRuns].sort((a, b) => a - b);
			const zeroMedian = sortedZero[1] ?? 0;
			const zeroMaxLoad = Math.max(...zeroLoads.map((load) => load.load1));
			const zeroBaselineMs = T0_BASELINE[SCALE_NOTE_COUNT]?.zeroMs;
			// 关键路径:与 T0 记录的 3000 篇零变化基线(683 ms)只比**绝对值与比值**,并显式标注
			// 「负载高于核数时不作门槛依据」;基线缺失时如实写「无 T0 基线」,不用 0 冒充。
			const zeroRatioText =
				zeroBaselineMs === undefined
					? '无 T0 基线(不比较)'
					: `${(zeroMedian / zeroBaselineMs).toFixed(2)}×(负载>核数时不作门槛依据)`;
			console.log(
				[
					`[T8b 3000 零变化订正读数] 三次=${zeroRuns.map((ms) => ms.toFixed(0)).join(' / ')}ms 中位=${zeroMedian.toFixed(0)}ms`,
					`零变化负载=${zeroLoads.map((load) => load.load1.toFixed(2)).join(' / ')} 最高=${zeroMaxLoad.toFixed(2)} 核数=${zeroLoads[0]?.cores ?? 0}`,
					`T0 记录基线=${zeroBaselineMs === undefined ? '无' : `${zeroBaselineMs.toFixed(0)}ms`} 比值=${zeroRatioText}`,
				].join(' | '),
			);
		},
		7_200_000,
	);

	it('512 维与 768 维各一 - 维度与块集合不失真', async () => {
		for (const dimension of [512, 768]) {
			const ws = workspace(`ratel-t8b-dims-${dimension}-`);
			try {
				const vaultDir = ws.mkdir('vault');
				const indexRoot = ws.mkdir('index-root');
				const noteCount = 120;
				const notePaths = generateAndWriteNotes(vaultDir, noteCount, { bodyChars: 320, seed: `dim${dimension}` });
				const port = new RecordingEmbeddingPort(dimension);
				const expectedTexts: string[] = [];
				for (const relative of notePaths) {
					const content = fs.readFileSync(path.join(vaultDir, relative), 'utf8');
					for (const chunk of chunkMarkdown(content, T0_CHUNK_OPTIONS)) expectedTexts.push(chunk.embedText);
				}
				const observed = await runAndInspect(
					{ indexRoot, vaultDir, notePaths, dimensions: dimension, embedding: port },
					async (harness) => {
						// 关键路径:磁盘上的向量维度必须等于配置维度(维度混写会静默检索错位)。
						const blocks = await harness.store.inspectFile(notePaths[0] ?? '');
						expect(blocks.length).toBeGreaterThan(0);
						for (const block of blocks) expect(block.vector.length).toBe(dimension);
					},
				);
				expect(observed.errors).toBe(0);
				expect(observed.indexed).toBe(noteCount);
				// 关键路径:嵌入输入的多重集合必须与「同一分块器 + 同一内容」逐项相等 ——
				// 重复嵌入、漏嵌入或把别的文件内容喂进模型都会让集合不等。
				expect(port.allTexts().slice().sort()).toEqual(expectedTexts.slice().sort());
				expect(port.batches.length).toBe(noteCount);

				console.log(
					`[T8b 维度] 样本=${noteCount} 维度=${dimension} 耗时=${observed.elapsedMs.toFixed(0)}ms 块数=${expectedTexts.length} 负载=${formatLoad(observed.load)}`,
				);
			} finally {
				// 关键路径(测试卫生 S5):循环内逐轮释放,单轮失败也不会把工作区留到 afterAll。
				releaseWorkspaces();
			}
		}
	}, 900_000);

	it('连续编辑同一路径 - 队列按路径合并 - 只有末版进入提交', async () => {
		/**
		 * 跑一次「先建库 → 同一路径连续编辑 N 次 → 再启动」，返回读写观测。
		 *
		 * 关键路径:比较 N=5 与 N=25 的**热点路径读取次数**是否相同 ——
		 * 队列按路径合并的直接体现;比写死一个上界更稳健(不依赖内部核对轮数)。
		 *
		 * @param edits - 连续编辑次数。
		 * @returns 提交数、热点读取次数、总读取次数、块数与末版 hash 是否匹配。
		 */
		async function measureContinuousEdits(edits: number): Promise<{
			indexed: number;
			hotReads: number;
			totalReads: number;
			blockCount: number;
			receiptMatches: boolean;
		}> {
			const ws = workspace(`ratel-t8b-continuous-${edits}-`);
			const vaultDir = ws.mkdir('vault');
			const indexRoot = ws.mkdir('index-root');
			const notePaths = generateAndWriteNotes(vaultDir, 40, { bodyChars: 320, seed: 'cont' });
			const hotPath = notePaths[0];
			expect(hotPath).toBeDefined();
			if (hotPath === undefined) throw new Error('合成笔记缺少热点路径');

			const seed = await runAndInspect({ indexRoot, vaultDir, notePaths, dimensions: DEFAULT_DIMS });
			expect(seed.errors).toBe(0);

			let finalContent = '';
			for (let i = 0; i < edits; i++) {
				finalContent = syntheticNoteContent(1000 + i, 320, `edit-${i}`);
				writeNoteFile(vaultDir, hotPath, finalContent);
			}

			const harness = await assembleScaleHarness({
				indexRoot,
				vaultDir,
				notePaths,
				dimensions: DEFAULT_DIMS,
				embedding: new FakeEmbeddingPort(DEFAULT_DIMS),
			});
			try {
				const result = await harness.run();
				expect(result?.errors).toBe(0);
				const receipt = await harness.journal.readReceipt(hotPath);
				const finalHash = await sha256(finalContent);
				const ids = expectedChunkIds(hotPath, finalContent);
				const disk = await readDiskBlockIds(harness.indexDir, hotPath);
				expect(disk.slice().sort()).toEqual(ids.slice().sort());
				return {
					indexed: result?.indexed ?? -1,
					hotReads: harness.vault.readsFor(hotPath),
					totalReads: harness.vault.readCount(),
					blockCount: ids.length,
					receiptMatches: receipt?.inputHash === finalHash,
				};
			} finally {
				await harness.dispose();
			}
		}

		try {
			const few = await measureContinuousEdits(5);
			const many = await measureContinuousEdits(25);
			// 关键路径:只有热点路径需要重新提交;其它 39 篇零重新嵌入。
			expect(few.indexed).toBe(1);
			expect(many.indexed).toBe(1);
			expect(few.receiptMatches).toBe(true);
			expect(many.receiptMatches).toBe(true);
			// 关键路径:25 次编辑的热点读取次数与 5 次完全相同 ——
			// 读取次数不随编辑次数增长,证明队列按路径只保留最新项。
			expect(many.hotReads).toBe(few.hotReads);
			expect(many.totalReads).toBe(few.totalReads);
			console.log(
				`[T8b 连续编辑] 编辑=5次 热点读取=${few.hotReads} 总读取=${few.totalReads} | 编辑=25次 热点读取=${many.hotReads} 总读取=${many.totalReads} 块数=${many.blockCount} 负载=${formatLoad(readLoad())}`,
			);
		} finally {
			releaseWorkspaces();
		}
	}, 900_000);

	it.skipIf(!RUN_HEAVY_SCALE)('多次重启 - 三次零变化启动零嵌入且索引目录内容不变', async () => {
		const ws = workspace('ratel-t8b-restart-');
		try {
			const vaultDir = ws.mkdir('vault');
			const indexRoot = ws.mkdir('index-root');
			const notePaths = generateAndWriteNotes(vaultDir, 300, { bodyChars: 320, seed: 'restart' });
			notePaths.push(BIG_NOTE_PATH);
			const bigChunks = writeBigChunkNote(vaultDir, BIG_NOTE_PATH, BIG_CHUNK_TARGET);

			const seed = await runAndInspect({ indexRoot, vaultDir, notePaths, dimensions: DEFAULT_DIMS });
			expect(seed.errors).toBe(0);
			const generationIndexDir = seed.indexDir;

			for (let restart = 1; restart <= 3; restart++) {
				const before = snapshotDirectoryContents(indexRoot);
				const port = new CountingOnlyPort(DEFAULT_DIMS);
				const observed = await runAndInspect({
					indexRoot,
					vaultDir,
					notePaths,
					dimensions: DEFAULT_DIMS,
					embedding: port,
				});
				const after = snapshotDirectoryContents(indexRoot);
				expect(observed.indexed).toBe(0);
				expect(port.calls).toBe(0);
				expect(port.texts).toBe(0);
				// 关键路径:零变化启动不写向量数据 —— 索引目录里每个文件的**字节数与内容摘要**
				// 都不变(此前只比字节数却写成「逐字节」),也没有 `.tmp-` 残留。
				expect(after.size).toBe(before.size);
				expect(diffSnapshotContents(before, after)).toEqual({
					added: [],
					removed: [],
					changed: [],
					resized: [],
				});
				expect(writeDelta(observed).totalCount).toBe(0);
				expect(observed.observations.boundary.pendingDirMismatches).toBe(0);
				console.log(
					`[T8b 重启] 第 ${restart} 次 耗时=${observed.elapsedMs.toFixed(0)}ms 嵌入=${port.calls} 写入=0 目录差异=0 在途峰值=${observed.observations.boundary.maxInFlight} 负载=${formatLoad(observed.load)}`,
				);
			}
			const bigBlocks = await readDiskBlockIds(generationIndexDir, BIG_NOTE_PATH);
			expect(bigBlocks.length).toBe(bigChunks);
		} finally {
			releaseWorkspaces();
		}
	}, 1_800_000);
});

describe.skipIf(!SCALE_HEAVY)('规模用例 - 3000 篇 @512 维(生产维度,`RATEL_SCALE=1`)', () => {
	it('3000 篇 + 超长文件 @512 维 - 完整构建读数与写入量', async () => {
		const ws = workspace('ratel-t8b-scale-3000-512-');
		try {
			const vaultDir = ws.mkdir('vault');
			const indexRoot = ws.mkdir('index-root');
			const notePaths = generateAndWriteNotes(vaultDir, SCALE_NOTE_COUNT, { bodyChars: 320, seed: 't8-512' });
			const bigChunks = writeBigChunkNote(vaultDir, BIG_NOTE_PATH, BIG_CHUNK_TARGET);
			notePaths.push(BIG_NOTE_PATH);
			const expected = expectedTotals(vaultDir, notePaths);
			const port = new CountingOnlyPort(512);
			const loadBefore = readLoad();
			const observed = await runAndInspect({ indexRoot, vaultDir, notePaths, dimensions: 512, embedding: port });
			expect(observed.errors).toBe(0);
			expect(observed.indexed).toBe(expected.paths);
			expect(port.calls).toBe(expected.paths);
			expect(port.texts).toBe(expected.chunks);
			const writes = writeDelta(observed);

			console.log(
				[
					`[T8b 规模 512] 样本=${notePaths.length}(含 1 篇 ${bigChunks} 块) 维度=512`,
					`耗时=${observed.elapsedMs.toFixed(0)}ms 完成=${observed.indexed} 块数=${expected.chunks}`,
					`嵌入调用=${port.calls}/文本=${port.texts}`,
					`峰值heap=${formatBytes(observed.peaks.peakHeapUsed)} 峰值rss=${formatBytes(observed.peaks.peakRss)}`,
					`写入=${writes.totalCount}次/${formatBytes(writes.totalBytes)}/${writes.totalMs.toFixed(0)}ms 其中索引=${writes.indexCount}次/${formatBytes(writes.indexBytes)}/${writes.indexMs.toFixed(0)}ms`,
					`索引文件=${formatBytes(fs.statSync(path.join(indexRoot, 'index.json')).size)}`,
					`maxQueued(下界)=${observed.observations.maxQueued} 嵌入并发峰值=${observed.observations.maxConcurrentEmbeds} 在途峰值=${observed.observations.boundary.maxInFlight} 磁盘pending峰值=${observed.observations.boundary.maxPendingDirs}`,
					`负载(起)=${formatLoad(loadBefore)} 负载(止/高)=${formatLoad(observed.load)}`,
				].join(' | '),
			);
		} finally {
			releaseWorkspaces();
		}
	}, 7_200_000);
});

// ---------------------------------------------------------------------------
// 写入行为断言(checkbox 5)
// ---------------------------------------------------------------------------

describe('写入行为断言(checkbox 5)', () => {
	it.skipIf(!RUN_HEAVY_SCALE)('零变化启动不写向量数据 - 写入计数为零且索引目录内容不变', async () => {
		const ws = workspace('ratel-t8b-zero-write-');
		try {
			const vaultDir = ws.mkdir('vault');
			const indexRoot = ws.mkdir('index-root');
			const notePaths = generateAndWriteNotes(vaultDir, 200, { bodyChars: 320, seed: 'zerowrite' });

			// 关键路径:两轮都跑在**同一个已装配实例**上 —— 同实例第二轮即「零变化启动」,
			// 比重新装配更强(排除装配期写入被误算成启动写入)。
			const harness = await assembleScaleHarness({
				indexRoot,
				vaultDir,
				notePaths,
				dimensions: DEFAULT_DIMS,
				embedding: new FakeEmbeddingPort(DEFAULT_DIMS),
			});
			try {
				const built = await harness.run();
				expect(built?.errors).toBe(0);
				const before = snapshotDirectoryContents(indexRoot);
				harness.storage.resetCounters();
				const second = await harness.run();
				const after = snapshotDirectoryContents(indexRoot);
				const counters = harness.storage.counters();

				expect(second?.indexed).toBe(0);
				expect(counters.byKind.index.count).toBe(0);
				expect(counters.byKind.index.ms).toBe(0);
				expect(counters.byKind.shard.count).toBe(0);
				expect(counters.byKind.prepared.count).toBe(0);
				expect(counters.byKind.receipt.count).toBe(0);
				expect(counters.totalCount).toBe(0);
				expect(diffSnapshotContents(before, after)).toEqual({
					added: [],
					removed: [],
					changed: [],
					resized: [],
				});
				console.log(
					`[T8b 零变化写入] 同一实例第二轮 写入=${counters.totalCount}次 索引=${counters.byKind.index.count}次 目录差异=0 负载=${formatLoad(readLoad())}`,
				);
			} finally {
				await harness.dispose();
			}
		} finally {
			releaseWorkspaces();
		}
	}, 900_000);

	it.skipIf(!RUN_HEAVY_SCALE)('单文件变化只提交一次该文件事务 - 索引写入 1 次、完成记录 1 次、其它文件零嵌入', async () => {
		const ws = workspace('ratel-t8b-single-tx-');
		try {
			const vaultDir = ws.mkdir('vault');
			const indexRoot = ws.mkdir('index-root');
			const notePaths = generateAndWriteNotes(vaultDir, 200, { bodyChars: 320, seed: 'singletx' });
			const targetPath = notePaths[7];
			expect(targetPath).toBeDefined();
			if (targetPath === undefined) return;

			const first = await assembleScaleHarness({
				indexRoot,
				vaultDir,
				notePaths,
				dimensions: DEFAULT_DIMS,
				embedding: new FakeEmbeddingPort(DEFAULT_DIMS),
			});
			const built = await first.run();
			expect(built?.errors).toBe(0);
			await first.dispose();

			const updatedContent = syntheticNoteContent(8807, 320, 'single-tx');
			writeNoteFile(vaultDir, targetPath, updatedContent);
			const port = new CountingOnlyPort(DEFAULT_DIMS);
			const second = await assembleScaleHarness({
				indexRoot,
				vaultDir,
				notePaths,
				dimensions: DEFAULT_DIMS,
				embedding: port,
			});
			try {
				second.storage.resetCounters();
				const result = await second.run();
				const counters = second.storage.counters();
				expect(result?.errors).toBe(0);
				expect(result?.indexed).toBe(1);
				expect(port.calls).toBe(1);
				// 关键路径:单文件 durable 提交 = 一次向量事务 + 一条完成记录。
				expect(counters.byKind.index.count).toBe(1);
				expect(counters.byKind.receipt.count).toBe(1);
				expect(counters.byKind.prepared.count).toBe(1);
				expect(counters.byKind.shard.count).toBeGreaterThanOrEqual(1);
				// 关键路径(规范审查 I4):「逐文件重写大 JSON 的累计字节数**与耗时**」两项齐备 ——
				// 索引文件的累计耗时必须大于零,且不超过本轮总耗时(同一次运行的同一口径)。
				expect(counters.byKind.index.ms).toBeGreaterThan(0);
				const singleTotalMs = totalMs(counters);
				expect(counters.byKind.index.ms).toBeLessThanOrEqual(singleTotalMs);
				// 关键路径:提交完成后待提交事务目录被清理。
				expect(countPendingDirs(second.indexDir)).toBe(0);
				expect(second.journalBoundary.observations().pendingDirMismatches).toBe(0);
				const ids = expectedChunkIds(targetPath, updatedContent);
				expect((await readDiskBlockIds(second.indexDir, targetPath)).slice().sort()).toEqual(ids.slice().sort());
				console.log(
					[
						`[T8b 单文件事务] 索引写入=${counters.byKind.index.count}次/${formatBytes(counters.byKind.index.bytes)}/${counters.byKind.index.ms.toFixed(1)}ms`,
						`完成记录=${counters.byKind.receipt.count}次 prepared=${counters.byKind.prepared.count}次 分片=${counters.byKind.shard.count}次`,
						`写入合计=${counters.totalCount}次/${formatBytes(counters.totalBytes)}/${singleTotalMs.toFixed(1)}ms`,
						`嵌入调用=${port.calls} 文本=${port.texts} 块数=${ids.length}`,
						`负载=${formatLoad(readLoad())}`,
					].join(' | '),
				);
			} finally {
				await second.dispose();
			}
		} finally {
			releaseWorkspaces();
		}
	}, 900_000);

	it.skipIf(!RUN_HEAVY_SCALE)('队列只存路径/序号 - 结构守卫 + 事务边界确定性计数(内存读数不作为独立结论)', async () => {
		// 结构守卫:队列项类型不得出现任何承载正文的字段(与 T0 的静态守卫同一口径;
		// 能力边界:静态文本扫描,动态字段名与间接引用覆盖不到)。
		const source = fs.readFileSync(path.join(HERE, '../../src/core/index-task-coordinator.ts'), 'utf8');
		const entryStart = source.indexOf('interface QueueEntry');
		expect(entryStart).toBeGreaterThan(0);
		const entryBlock = source.slice(entryStart, source.indexOf('\n}', entryStart));
		expect(entryBlock).not.toMatch(/\b(content|text|body|blocks|vector|embedText|snapshot)\b/);
		// 关键路径:`CoordinatorSnapshot` 含 content,但它必须是**局部变量** —— 一旦成为字段,
		// 就退化为「在途快照常驻」,并可能在收敛前把全库正文留在内存里。
		expect(source).not.toMatch(/private\s+(readonly\s+)?[a-zA-Z]*[Ss]napshot[a-zA-Z]*\s*[:=]/);
		expect(source).not.toMatch(/private\s+(readonly\s+)?[a-zA-Z]*(content|contents|bodies|texts)[a-zA-Z]*\s*[:=]/);

		// 关键路径(代码质量审查 I5):这里原先断言 `heapDelta < corpusDelta / 4`。
		// 实测三次堆增量为**负**(−39.5 / −22.0 / −14.3 MiB),该不等式对负值恒真,
		// 因此它**不能**作为「内存有界」的独立证据 —— 现已降级:堆读数只作为观测输出,
		// 不再断言;该用例的证据改为「结构守卫 + 事务边界确定性计数」。
		// (完整管线的峰值内存另见规模用例与性能读数表,那些同样只报绝对值。)
		const ws = workspace('ratel-t8b-queue-memory-');
		try {
			const small = await measureQueueProbe(ws.mkdir('small-vault'), 3000, 1_000);
			const large = await measureQueueProbe(ws.mkdir('large-vault'), 3000, 24_000);
			const corpusDelta = large.corpusBytes - small.corpusBytes;
			const heapDelta = large.peakHeapUsed - small.peakHeapUsed;
			console.log(
				[
					'[T8b 队列内存探针(观测,不作为独立结论)] 文件数=3000',
					`小语料=${formatBytes(small.corpusBytes)} 堆峰值=${formatBytes(small.peakHeapUsed)}`,
					`大语料=${formatBytes(large.corpusBytes)} 堆峰值=${formatBytes(large.peakHeapUsed)}`,
					`语料增量=${formatBytes(corpusDelta)} 堆增量=${formatBytes(heapDelta)}(负值只能说明这一次采样没捕捉到增长,不能证明有界)`,
					`确定性边界:小语料 prepare=${small.boundary.prepareCount} 在途峰值=${small.boundary.maxInFlight} prepare并发峰值=${small.boundary.maxConcurrentPrepares}`,
					`确定性边界:大语料 prepare=${large.boundary.prepareCount} 在途峰值=${large.boundary.maxInFlight} prepare并发峰值=${large.boundary.maxConcurrentPrepares}`,
					`负载=${formatLoad(readLoad())}`,
				].join(' | '),
			);
			// 关键路径:确定性计数(每条事务的 prepare/commit/cleanup 边界)替代 20ms 采样 ——
			// 「同一时刻只有一个在途事务、一个 prepare」是「状态里不常驻多份正文」的结构性替代证据。
			expect(small.boundary.maxInFlight).toBeLessThanOrEqual(1);
			expect(large.boundary.maxInFlight).toBeLessThanOrEqual(1);
			expect(small.boundary.maxConcurrentPrepares).toBeLessThanOrEqual(1);
			expect(large.boundary.maxConcurrentPrepares).toBeLessThanOrEqual(1);
			expect(small.boundary.prepareCount).toBeGreaterThan(0);
			expect(large.boundary.prepareCount).toBeGreaterThan(0);
		} finally {
			releaseWorkspaces();
		}
	}, 1_800_000);

	it.skipIf(!RUN_HEAVY_SCALE)('未结算事务只保留活动文件 - 事务与嵌入边界确定性计数均不超过 1', async () => {
		const ws = workspace('ratel-t8b-pending-bound-');
		try {
			const vaultDir = ws.mkdir('vault');
			const indexRoot = ws.mkdir('index-root');
			const notePaths = generateAndWriteNotes(vaultDir, 400, { bodyChars: 320, seed: 'pending' });
			notePaths.push(BIG_NOTE_PATH);
			writeBigChunkNote(vaultDir, BIG_NOTE_PATH, BIG_CHUNK_TARGET);

			const observed = await runAndInspect({ indexRoot, vaultDir, notePaths, dimensions: DEFAULT_DIMS });
			expect(observed.errors).toBe(0);
			const boundary = observed.observations.boundary;
			console.log(
				[
					`[T8b pending 上界] 样本=${notePaths.length} 观测点=${observed.observations.steps}`,
					`确定性:嵌入并发峰值=${observed.observations.maxConcurrentEmbeds} prepare并发峰值=${boundary.maxConcurrentPrepares}`,
					`在途峰值=${boundary.maxInFlight} 磁盘pending峰值=${boundary.maxPendingDirs}(核对 ${boundary.pendingDirChecks} 次,不一致 ${boundary.pendingDirMismatches} 次)`,
					`结束 pending=${observed.observations.pendingDirsAtEnd} prepare=${boundary.prepareCount} commit=${boundary.commitCount} cleanup=${boundary.cleanupCount}`,
					`负载=${formatLoad(observed.load)}`,
				].join(' | '),
			);
			// 关键路径(代码质量审查 I5):以下全部是**确定性计数** ——
			// 计数点落在协调器处理流程的固定位置(vault 访问、日志 prepare/commit/cleanup、嵌入进出),
			// 不是 20ms 定时采样,因此才足以支撑「同一时刻只有一个活动项/一个未结算事务」这类上界断言。
			expect(observed.observations.maxConcurrentEmbeds).toBeLessThanOrEqual(1);
			expect(boundary.maxConcurrentPrepares).toBeLessThanOrEqual(1);
			expect(boundary.maxInFlight).toBeLessThanOrEqual(1);
			expect(boundary.maxPendingDirs).toBeLessThanOrEqual(1);
			expect(boundary.pendingDirChecks).toBeGreaterThan(0);
			expect(boundary.pendingDirMismatches).toBe(0);
			expect(observed.observations.pendingDirsAtEnd).toBe(0);
			expect(boundary.prepareCount).toBeGreaterThan(0);
			expect(observed.observations.steps).toBeGreaterThan(0);
		} finally {
			releaseWorkspaces();
		}
	}, 1_800_000);

	it('已结算但清理失败的分片可定位回收 - 隔离区枚举/回收/自动回收', async () => {
		const ws = workspace('ratel-t8b-quarantine-');
		const vaultDir = ws.mkdir('vault');
		const indexRoot = ws.mkdir('index-root');
		const relative = 'notes/quarantine-target.md';
		const v1 = syntheticNoteContent(1, 320, 'q-v1');
		writeNoteFile(vaultDir, relative, v1);

		const harness = await assembleScaleHarness({
			indexRoot,
			vaultDir,
			notePaths: [relative],
			dimensions: DEFAULT_DIMS,
			embedding: new FakeEmbeddingPort(DEFAULT_DIMS),
		});
		try {
			const journal = harness.journal;
			const store = harness.store;

			// 阶段 1:向量已替换、完成记录写失败 —— 正是「已落盘但未结算」的中间态。
			harness.storage.failNextUpsert((filePath) => filePath.includes(`${path.sep}files${path.sep}`));
			const tx1 = await journal.prepare({
				path: relative,
				operation: 'replace',
				inputHash: await sha256(v1),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: blocksForContent(relative, v1, DEFAULT_DIMS) as unknown as CoordinatorBlock[],
			});
			await expect(journal.commit(tx1.transactionId)).rejects.toThrow();
			expect(harness.storage.failureInjections()).toBe(1);
			// 关键路径:向量确实已在磁盘上(块数与 ID 序列),完成记录尚未落盘。
			expect((await store.inspectFile(relative)).map((block) => block.id).sort()).toEqual(
				expectedChunkIds(relative, v1).slice().sort(),
			);
			expect(await journal.readReceipt(relative)).toBeNull();
			// 未结算事务可定位:路径仍在 `pending/` 枚举里,磁盘上恰好一个待提交目录。
			const pendingPathsBefore = await journal.listPendingPaths();
			expect(pendingPathsBefore).toContain(relative);
			expect(countPendingDirs(harness.indexDir)).toBe(1);

			// 阶段 2:内容改写后再 prepare —— 前驱向量已在盘上而输入已过期,
			// 日志把旧事务移入隔离区保留依据,并写入不可用状态。
			const v2 = syntheticNoteContent(2, 320, 'q-v2');
			writeNoteFile(vaultDir, relative, v2);
			const tx2 = await journal.prepare({
				path: relative,
				operation: 'replace',
				inputHash: await sha256(v2),
				revision: 2,
				previousCommitId: null,
				previousRevision: 0,
				blocks: blocksForContent(relative, v2, DEFAULT_DIMS) as unknown as CoordinatorBlock[],
			});
			const quarantined = await journal.listQuarantinedTransactions();
			expect(quarantined).toContain(tx1.transactionId);
			expect(fs.existsSync(path.join(quarantineTxsDir(harness.indexDir), tx1.transactionId))).toBe(true);
			const states = await journal.listPathStates();
			expect(states.some((state) => state.path === relative && state.transactionId === tx1.transactionId)).toBe(true);

			// 关键路径:路径状态仍引用该事务时,孤儿回收**不得**删除它(不误删仍需要的依据)。
			const orphan = await journal.reclaimOrphanQuarantinedTransactions();
			expect(orphan.reclaimed).not.toContain(tx1.transactionId);
			expect(orphan.retained).toContain(tx1.transactionId);

			// 阶段 3:当前版本成功提交 → 路径状态清除 → 隔离区依据自动回收。
			const committed = await journal.commit(tx2.transactionId);
			expect(committed.cleanupPending).toBe(false);
			expect(committed.commit.inputHash).toBe(await sha256(v2));
			expect(await journal.listQuarantinedTransactions()).not.toContain(tx1.transactionId);
			expect(fs.existsSync(path.join(quarantineTxsDir(harness.indexDir), tx1.transactionId))).toBe(false);
			expect(countPendingDirs(harness.indexDir)).toBe(0);
			// 关键路径:已结算的最新版本块集合完整(过期快照向量没有留在盘上)。
			expect((await store.inspectFile(relative)).map((block) => block.id).sort()).toEqual(
				expectedChunkIds(relative, v2).slice().sort(),
			);
			console.log(
				`[T8b 隔离区回收] 未结算可定位=${pendingPathsBefore.length}条 隔离区枚举=${quarantined.length}条 孤儿回收 retained=${orphan.retained.length} 自动回收完成 pending=${countPendingDirs(harness.indexDir)} 负载=${formatLoad(readLoad())}`,
			);
		} finally {
			await harness.dispose();
			releaseWorkspaces();
		}
	}, 300_000);
});

/**
 * 隔离内存探针:固定文件数、变化语料字节,用**丢弃正文**的分块端口 + 内存日志替身。
 *
 * 关键路径:端口不返回块、日志不落盘,因此索引与日志都不随语料增长;
 * 日志替身外面再套一层事务边界计数,给出**确定性**的并发/在途上界。
 *
 * 能力边界(代码质量审查 I5,如实标注):堆峰值读数是 20ms 采样的观测值,历史三次的
 * 堆增量为负,`heapDelta < corpusDelta/4` 因此恒真、**不能**作为「内存有界」的独立证据;
 * 本函数只报出这个读数,不据此下结论。
 *
 * @param vaultDir - 合成 Vault 目录。
 * @param fileCount - 文件数。
 * @param bodyChars - 每篇正文字符数。
 * @returns 语料字节、堆峰值与确定性事务边界计数。
 */
async function measureQueueProbe(
	vaultDir: string,
	fileCount: number,
	bodyChars: number,
): Promise<{ corpusBytes: number; peakHeapUsed: number; boundary: TransactionBoundaryObservations }> {
	const notePaths = generateAndWriteNotes(vaultDir, fileCount, { bodyChars, seed: `probe-${bodyChars}` });
	let corpusBytes = 0;
	for (const relative of notePaths) corpusBytes += fs.statSync(path.join(vaultDir, relative)).size;

	const { IndexTaskCoordinator } = await import('../../src/core/index-task-coordinator');
	const vault = createCountingVault(vaultDir, notePaths);
	// 关键路径:纯内存替身不落盘,因此**不传**磁盘读取器 —— 读磁盘只会得到恒 0 的假结果,
	// 会伪造出「在途 1、磁盘 0」的不一致。磁盘核对只在生产装配的用例里做。
	const boundary = new BoundaryCountingJournal(createDiscardingJournal());
	const coordinator = new IndexTaskCoordinator({
		vault,
		journal: boundary,
		processor: { prepareBlocks: async () => [] },
		getConfigFingerprint: () => 't8b-probe',
	});
	const sampler = new MemorySampler(20);
	sampler.start();
	try {
		await coordinator.start();
		const peaks = sampler.stop();
		return { corpusBytes, peakHeapUsed: peaks.peakHeapUsed, boundary: boundary.observations() };
	} finally {
		sampler.stop();
		coordinator.destroy();
	}
}

/**
 * 内存日志替身 — 只满足协调器的窄端口,不落任何盘。
 *
 * 关键路径:探针要隔离的是**协调器自身**的保留,日志实现不属于被测对象;
 * 用替身同时避免 3000 次真实事务写盘把探针变成写性能测试。
 *
 * @returns 日志替身。
 */
function createDiscardingJournal(): CoordinatorJournalPort {
	let sequence = 0;
	return {
		prepare: async (input) => {
			sequence += 1;
			return { transactionId: `probe-tx-${sequence}-${input.path}` };
		},
		commit: async (transactionId) => ({
			commit: { revision: sequence, inputHash: transactionId, chunkCount: 0 },
			superseded: false,
		}),
		cleanup: async () => undefined,
		readReceipt: async () => null,
	};
}

// ---------------------------------------------------------------------------
// 性能口径与门槛(checkbox 4)
// ---------------------------------------------------------------------------

/** T0 记录的成功基线(64 维、带载采集、三次中位数)—— 相对门槛的分母,来自 T0 证据第 4 节。 */
const T0_BASELINE: Record<number, { fullMs: number; heapBytes: number; rssBytes: number; zeroMs: number }> = {
	100: { fullMs: 295, heapBytes: 163.0 * 1024 * 1024, rssBytes: 372.9 * 1024 * 1024, zeroMs: 14 },
	1000: { fullMs: 25357, heapBytes: 85.4 * 1024 * 1024, rssBytes: 377.8 * 1024 * 1024, zeroMs: 447 },
	3000: { fullMs: 194605, heapBytes: 111.3 * 1024 * 1024, rssBytes: 610.5 * 1024 * 1024, zeroMs: 683 },
};

/**
 * T0 记录基线一侧的负载读数 — **T0 证据没有给出负载数字**,只自述为「带载采集」
 * (1000 / 3000 篇运行期间另有并行短测试)。
 *
 * 关键路径(规范审查 I3):门槛可比性必须**两侧**都核对 —— 分子臂(本次被测)与分母臂(基线)。
 * 分母臂没有负载读数时「同一口径」无法成立,一律 `not-comparable`;
 * 这里如实记录「未记录」,而不是默认分母臂合格。
 */
const T0_BASELINE_LOAD: { maxLoad1: number | null; cores: number | null; note: string } = {
	/** 分母臂(T0 记录)的 1 分钟负载 — 证据没有给出,因此是 `null`,不是 0。 */
	maxLoad1: null,
	/** 分母臂(T0 记录)的核数 — 同上。 */
	cores: null,
	/** 证据里关于负载的原话摘要(不得改写成具体数字)。 */
	note: 'T0 证据第 4 节自述为「带载采集」,未给出 1 分钟负载数字;1000 / 3000 篇期间另有并行短测试。',
};

/** 相对门槛 — 本设计的验收目标(不是实测结论)。 */
const GATE = {
	/** 零变化启动耗时 / 成功基线。 */
	zeroChangeRatio: 1.25,
	/** 完整首次构建耗时 / 成功基线。 */
	fullBuildRatio: 1.5,
	/** 完整首次构建峰值 RSS / 成功基线。 */
	peakRssRatio: 1.5,
};

/**
 * 零变化门槛的最小可判定基线(毫秒)。
 *
 * 关键路径(代码质量审查 S8):100 篇档的 T0 基线是 14 ms,1.25× 门槛 = 17.5 ms,
 * 低于本机实测的计时抖动(同一台机器同档三次重启实测 59–72 ms,极差已超过该门槛)。
 * 基线低于本阈值时**只报绝对值、不给门槛判定**(`absolute-only`),不假装它可判定。
 */
const GATE_ZERO_MIN_BASELINE_MS = 100;

/** 一次基准读数记录。 */
interface ReadingRecord {
	sample: number;
	path: BenchPath;
	dimensions: number;
	runs: number;
	loadText: string;
	maxLoad1: number;
	cores: number;
	loadSamples: number[];
	fullRunsMs: number[];
	fullMedianMs: number;
	peakHeapBytes: number;
	peakRssBytes: number;
	chunks: number;
	zeroChangeMs: number;
	zeroEmbedCalls: number;
	singleUpdateMs: number;
	singleUpdateEmbedCalls: number;
	writeCount: number;
	writeBytes: number;
	/** 全部类别的累计写入耗时(毫秒)。 */
	writeMs: number;
	indexWriteCount: number;
	indexWriteBytes: number;
	/** `index.json` 的累计写入耗时(毫秒)—— 与上面两项同一次构建的同一口径。 */
	indexWriteMs: number;
	/** 按分类的写入次数、字节数与耗时(用于说明「每文件一次全量重写大 JSON」之外的开销)。 */
	writeKinds: Record<string, { count: number; bytes: number; ms: number }>;
	/** 构建结束后的 `index.json` 字节数。 */
	indexFileBytes: number;
	/** 装配耗时(毫秒,仅协调器路径可得;T0 路径的 `runProductionIndex` 不拆分装配)。 */
	assemblyMs: number;
	/** 零变化冷启动 = 装配 + `onLayoutReady()`(仅协调器路径可得)。 */
	zeroChangeColdStartMs: number;
}

/** 被测路径。 */
type BenchPath = 't0' | 't0-durable' | 'coordinator';

/**
 * 采集一个样本的三次完整构建 + 零变化启动 + 单文件更新读数。
 *
 * @param sample - 笔记数。
 * @param dimensions - 向量维度。
 * @param path - 被测路径:`t0` 为 T0 基线的 `smartReindex` 口径(vectra 默认非耐久存储);
 *   `t0-durable` 为同一条 `smartReindex` 路径但注入 T1 原子存储(耐久性对齐的对照臂);
 *   `coordinator` 为本次设计的生产路径。
 * @param runs - 完整构建重复次数。
 * @returns 读数记录(含负载)。
 */
async function collectReading(
	sample: number,
	dimensions: number,
	bench: BenchPath,
	runs: number,
): Promise<ReadingRecord> {
	const ws = workspace(`ratel-t8b-perf-${bench}-${sample}-${dimensions}-`);
	const vaultDir = ws.mkdir('vault');
	const indexRoot = ws.mkdir('index-root');
	const notePaths = generateAndWriteNotes(vaultDir, sample, { bodyChars: 320, seed: `perf${dimensions}` });
	const loadSamples: number[] = [];
	const fullRunsMs: number[] = [];
	const peakHeap: number[] = [];
	const peakRss: number[] = [];
	let chunks = 0;
	let writeCount = 0;
	let writeBytes = 0;
	let writeMs = 0;
	let indexWriteCount = 0;
	let indexWriteBytes = 0;
	let indexWriteMs = 0;
	let writeKinds: Record<string, { count: number; bytes: number; ms: number }> = {};
	let indexFileBytes = 0;
	let assemblyMs = 0;
	let zeroChangeColdStartMs = 0;
	let lastIndexDir = indexRoot;
	/** 协调器路径的真实代际目录(索引落盘处),用于读 `index.json` 字节数。 */
	let lastGenerationDir = '';
	let zeroChangeMs = 0;
	let zeroEmbedCalls = -1;
	let singleUpdateMs = 0;
	let singleUpdateEmbedCalls = -1;

	for (let run = 1; run <= runs; run++) {
		// 关键路径:每次完整构建都用**全新索引目录** —— 复用同一目录会让第二、三次变成
		// 「零变化启动」,三次中位数就变成「一次构建 + 两次热启动」的混合口径。
		const runDir = ws.mkdir(`${bench}-run-${run}`);
		lastIndexDir = runDir;
		if (bench === 'coordinator') {
			const port = new CountingOnlyPort(dimensions);
			const observed = await runAndInspect({ indexRoot: runDir, vaultDir, notePaths, dimensions, embedding: port });
			expect(observed.errors).toBe(0);
			expect(observed.indexed).toBe(sample);
			fullRunsMs.push(observed.elapsedMs);
			peakHeap.push(observed.peaks.peakHeapUsed);
			peakRss.push(observed.peaks.peakRss);
			chunks = port.texts;
			// 关键路径:写入计数取自**计时的同一次构建**(计数器是被动累加,不改变构建路径),
			// 因此「累计写入字节数」与「耗时」是同一口径的一组读数。
			const writes = writeDelta(observed);
			writeCount = writes.totalCount;
			writeBytes = writes.totalBytes;
			writeMs = writes.totalMs;
			indexWriteCount = writes.indexCount;
			indexWriteBytes = writes.indexBytes;
			indexWriteMs = writes.indexMs;
			writeKinds = kindDelta(observed);
			assemblyMs = observed.assemblyMs;
			lastGenerationDir = observed.indexDir;
		} else {
			const storage = bench === 't0-durable' ? new ScaleCountingStorage(runDir) : undefined;
			const result = await runProductionIndex({
				vaultDir,
				indexDir: runDir,
				notePaths,
				dimensions,
				...(storage === undefined ? {} : { storage }),
			});
			expect(result.errors).toBe(0);
			expect(result.indexed).toBe(sample);
			fullRunsMs.push(result.elapsedMs);
			peakHeap.push(result.peaks.peakHeapUsed);
			peakRss.push(result.peaks.peakRss);
			chunks = result.embedTexts;
			if (storage !== undefined) {
				const counters = storage.counters();
				writeCount = counters.totalCount;
				writeBytes = counters.totalBytes;
				writeMs = totalMs(counters);
				indexWriteCount = counters.byKind.index.count;
				indexWriteBytes = counters.byKind.index.bytes;
				indexWriteMs = counters.byKind.index.ms;
				writeKinds = Object.fromEntries(
					Object.entries(counters.byKind).map(([kind, tally]) => [
						kind,
						{ count: tally.count, bytes: tally.bytes, ms: tally.ms },
					]),
				);
			}
		}
		indexFileBytes = fileSizeOrZero(path.join(lastGenerationDir === '' ? runDir : lastGenerationDir, 'index.json'));
		loadSamples.push(readLoad().load1);
	}

	// 零变化启动:同一索引目录,内容未变 —— 必须零嵌入。
	if (bench === 'coordinator') {
		const zeroPort = new CountingOnlyPort(dimensions);
		const zero = await runAndInspect({
			indexRoot: lastIndexDir,
			vaultDir,
			notePaths,
			dimensions,
			embedding: zeroPort,
		});
		zeroChangeMs = zero.elapsedMs;
		zeroEmbedCalls = zeroPort.calls;
		zeroChangeColdStartMs = zero.assemblyMs + zero.elapsedMs;
		loadSamples.push(zero.load.load1);
	} else {
		const zero = await runProductionIndex({ vaultDir, indexDir: lastIndexDir, notePaths, dimensions });
		zeroChangeMs = zero.elapsedMs;
		zeroEmbedCalls = zero.embedCalls;
		loadSamples.push(readLoad().load1);
	}

	// 单文件更新:改一篇文件后重建,应只嵌入该文件。
	const updated = notePaths[0];
	if (updated !== undefined) {
		fs.appendFileSync(path.join(vaultDir, updated), '\n## 追加\n追加内容用于单文件更新基准。\n', 'utf8');
	}
	if (bench === 'coordinator') {
		const singlePort = new CountingOnlyPort(dimensions);
		const single = await runAndInspect({
			indexRoot: lastIndexDir,
			vaultDir,
			notePaths,
			dimensions,
			embedding: singlePort,
		});
		singleUpdateMs = single.elapsedMs;
		singleUpdateEmbedCalls = singlePort.calls;
		loadSamples.push(single.load.load1);
	} else {
		const single = await runProductionIndex({ vaultDir, indexDir: lastIndexDir, notePaths, dimensions });
		singleUpdateMs = single.elapsedMs;
		singleUpdateEmbedCalls = single.embedCalls;
		loadSamples.push(readLoad().load1);
	}
	loadSamples.push(readLoad().load1);

	const record: ReadingRecord = {
		sample,
		path: bench,
		dimensions,
		runs,
		loadText: formatLoad(readLoad()),
		maxLoad1: Math.max(...loadSamples),
		cores: readLoad().cores,
		loadSamples,
		fullRunsMs,
		fullMedianMs: median(fullRunsMs),
		peakHeapBytes: Math.max(...peakHeap),
		peakRssBytes: Math.max(...peakRss),
		chunks,
		zeroChangeMs,
		zeroEmbedCalls,
		singleUpdateMs,
		singleUpdateEmbedCalls,
		writeCount,
		writeBytes,
		writeMs,
		indexWriteCount,
		indexWriteBytes,
		indexWriteMs,
		writeKinds,
		indexFileBytes,
		assemblyMs,
		zeroChangeColdStartMs,
	};
	console.log(`[T8b 读数] ${JSON.stringify(record)}`);
	return record;
}

/** 单项门槛的判定。 */
type GateOutcome =
	/** 两侧负载都在同一口径内、基线可判定,且比值满足计划门槛。 */
	| 'pass'
	/** 同上,但比值超出计划门槛(如实上报,不用断言把「未达标」变成红)。 */
	| 'fail'
	/** 两侧负载不满足「同一口径」,或分母臂没有负载读数 → 不给门槛判定。 */
	| 'not-comparable'
	/** 基线低于计时分辨率 → 只报绝对值,不给门槛判定。 */
	| 'absolute-only';

/** 门槛判定结果。 */
interface GateVerdict {
	sample: number;
	scope: string;
	fullBuild: GateOutcome;
	peakRss: GateOutcome;
	zeroChange: GateOutcome;
	/** 两侧臂的负载呈现 —— 无论判定结果如何都给出(规范审查 I3)。 */
	loads: { measured: string; reference: string };
	notes: string[];
}

/** 相对门槛的分母(含**分母臂**的负载记录)。 */
interface GateBaseline {
	fullMs: number;
	rssBytes: number;
	zeroMs: number;
	label: string;
	/**
	 * 分母臂采样到的最高 1 分钟负载。
	 *
	 * 关键路径:`null` 表示「分母臂没有负载读数」—— 此时无法核对同一口径,判定必须是
	 * `not-comparable`,不能默认分母臂合格。
	 */
	maxLoad1: number | null;
	/** 分母臂运行时的核数(`maxLoad1` 为 `null` 时同为 `null`)。 */
	cores: number | null;
}

/** 把一侧臂的负载格式化成文本(缺读数时如实写明「未记录」)。 */
function formatArmLoad(label: string, maxLoad1: number | null, cores: number | null): string {
	if (maxLoad1 === null || cores === null) return `${label}:负载未记录`;
	return `${label}:1 分钟负载最高 ${maxLoad1.toFixed(2)} / 核数 ${cores}${maxLoad1 > cores ? '(高于核数)' : '(≤ 核数)'}`;
}

/**
 * 按相对门槛判定一次读数 —— **分子臂与分母臂的负载都要核对**。
 *
 * 关键路径(规范审查 I3):原实现只看被测臂(`coordinator`)的负载,分母臂无条件接受;
 * 但「同一口径」要求两侧都成立。任一侧超过核数、或分母臂没有负载读数,
 * 一律判 `not-comparable`,并在输出中同时呈现两侧负载。
 * 判定仍然只做记录:不用断言把「未达标」变成红,也不静默放宽门槛。
 *
 * @param record - 实测读数(分子臂)。
 * @param scope - 判定口径名称(计划口径 / 耐久性对齐口径)。
 * @param baseline - 门槛分母;缺省用 T0 记录的 64 维基线(T0 未记录负载读数)。
 * @returns 逐项判定、两侧负载与理由。
 */
function judgeGate(record: ReadingRecord, scope: string, baseline?: GateBaseline): GateVerdict {
	const isT0Default = baseline === undefined;
	const reference: GateBaseline | undefined =
		baseline ??
		(() => {
			const t0 = T0_BASELINE[record.sample];
			if (t0 === undefined) return undefined;
			return {
				fullMs: t0.fullMs,
				rssBytes: t0.rssBytes,
				zeroMs: t0.zeroMs,
				label: 'T0 记录(64 维,带载采集)',
				// 关键路径:T0 证据没给出负载数字 —— 如实记 `null`,不猜一个「接近核数」的值。
				maxLoad1: T0_BASELINE_LOAD.maxLoad1,
				cores: T0_BASELINE_LOAD.cores,
			};
		})();
	const verdict: GateVerdict = {
		sample: record.sample,
		scope,
		fullBuild: 'not-comparable',
		peakRss: 'not-comparable',
		zeroChange: 'not-comparable',
		loads: {
			measured: formatArmLoad(`分子臂=${record.path}`, record.maxLoad1, record.cores),
			reference: formatArmLoad(
				`分母臂=${reference?.label ?? '未知'}`,
				reference?.maxLoad1 ?? null,
				reference?.cores ?? null,
			),
		},
		notes: [],
	};
	if (reference === undefined) {
		verdict.notes.push(`无可用基线(样本 ${record.sample})`);
		return verdict;
	}
	if (record.dimensions !== 64) {
		verdict.notes.push(`维度 ${record.dimensions} 与 64 维基线不同,不与 64 维门槛直接比较`);
		return verdict;
	}
	const measuredComparable = record.maxLoad1 <= record.cores;
	const referenceComparable =
		reference.maxLoad1 !== null && reference.cores !== null && reference.maxLoad1 <= reference.cores;
	if (!measuredComparable || !referenceComparable) {
		verdict.notes.push(
			`可比性不成立 → 未在同一口径下验证(带载读数不过门)。${verdict.loads.measured};${verdict.loads.reference}`,
		);
		if (record.maxLoad1 > record.cores) {
			verdict.notes.push(`分子臂 1 分钟负载最高 ${record.maxLoad1.toFixed(2)} 高于核数 ${record.cores}`);
		}
		if (reference.maxLoad1 === null || reference.cores === null) {
			verdict.notes.push(`分母臂没有负载读数,无法核对「同一口径」;这不等于分母臂合格`);
			if (isT0Default) verdict.notes.push(T0_BASELINE_LOAD.note);
		} else if (reference.maxLoad1 > reference.cores) {
			verdict.notes.push(`分母臂 1 分钟负载最高 ${reference.maxLoad1.toFixed(2)} 高于核数 ${reference.cores}`);
		}
		return verdict;
	}
	const fullRatio = record.fullMedianMs / reference.fullMs;
	const rssRatio = record.peakRssBytes / reference.rssBytes;
	const zeroRatio = record.zeroChangeMs / reference.zeroMs;
	verdict.fullBuild = fullRatio <= GATE.fullBuildRatio ? 'pass' : 'fail';
	verdict.peakRss = rssRatio <= GATE.peakRssRatio ? 'pass' : 'fail';
	verdict.zeroChange = zeroRatio <= GATE.zeroChangeRatio ? 'pass' : 'fail';
	verdict.notes.push(
		`基线=${reference.label}`,
		verdict.loads.measured,
		verdict.loads.reference,
		`完整构建 ${record.fullMedianMs.toFixed(0)}ms / ${reference.fullMs.toFixed(0)}ms = ${fullRatio.toFixed(2)}× (门槛 ${GATE.fullBuildRatio}×)`,
		`峰值 RSS ${formatBytes(record.peakRssBytes)} / ${formatBytes(reference.rssBytes)} = ${rssRatio.toFixed(2)}× (门槛 ${GATE.peakRssRatio}×)`,
	);
	// 关键路径(代码质量审查 S8):零变化基线低于计时分辨率时,1.25× 门槛本身没有判定力
	// (100 篇档:基线 14 ms → 门槛 17.5 ms),只报绝对值。
	if (reference.zeroMs < GATE_ZERO_MIN_BASELINE_MS) {
		verdict.zeroChange = 'absolute-only';
		verdict.notes.push(
			`零变化启动基线 ${reference.zeroMs.toFixed(0)}ms 低于可判定下限 ${GATE_ZERO_MIN_BASELINE_MS}ms` +
				`(1.25× 门槛 = ${(reference.zeroMs * GATE.zeroChangeRatio).toFixed(1)}ms,落在计时抖动内)` +
				` → 只报绝对值 ${record.zeroChangeMs.toFixed(0)}ms,不给门槛判定`,
		);
		return verdict;
	}
	verdict.notes.push(
		`零变化启动 ${record.zeroChangeMs.toFixed(0)}ms / ${reference.zeroMs.toFixed(0)}ms = ${zeroRatio.toFixed(2)}× (门槛 ${GATE.zeroChangeRatio}×)`,
	);
	return verdict;
}

/**
 * 跑一个样本的 64 维三臂 A/B 并打印两份门槛判定。
 *
 * 关键路径:三臂分别是
 * 1. `t0` — T0 记录的采集口径(vectra 默认存储,无 fsync);
 * 2. `t0-durable` — 同一条 `smartReindex` 路径,注入 T1 原子存储(fsync + 目录同步);
 * 3. `coordinator` — 本次设计的生产路径。
 * 计划门槛按字面用 `t0` 作分母;`t0-durable` 提供**耐久性对齐**的对照分母,
 * 两者都给读数与**各自的负载**,不用后者替换前者。
 *
 * @param sample - 笔记数。
 * @param runs - 完整构建重复次数。
 */
async function abAt(sample: number, runs: number): Promise<void> {
	const t0 = await collectReading(sample, 64, 't0', runs);
	const t0d = await collectReading(sample, 64, 't0-durable', runs);
	const coordinator = await collectReading(sample, 64, 'coordinator', runs);
	const planVerdict = judgeGate(coordinator, 'plan:分母=T0 记录(非耐久)');
	const durableVerdict = judgeGate(coordinator, 'durable-matched:分母=本次 t0-durable', {
		fullMs: t0d.fullMedianMs,
		rssBytes: t0d.peakRssBytes,
		zeroMs: t0d.zeroChangeMs,
		label: `本次 t0-durable(64 维,${String(runs)} 次中位)`,
		maxLoad1: t0d.maxLoad1,
		cores: t0d.cores,
	});
	console.log(`[T8b 门槛 plan] ${JSON.stringify(planVerdict)}`);
	console.log(`[T8b 门槛 durable-matched] ${JSON.stringify(durableVerdict)}`);
	console.log(
		`[T8b A/B 摘要] 样本=${sample} runs=${runs} t0中位=${t0.fullMedianMs.toFixed(0)}ms(${formatArmLoad('t0', t0.maxLoad1, t0.cores)}) t0-durable中位=${t0d.fullMedianMs.toFixed(0)}ms(${formatArmLoad('t0-durable', t0d.maxLoad1, t0d.cores)}) coordinator中位=${coordinator.fullMedianMs.toFixed(0)}ms(${formatArmLoad('coordinator', coordinator.maxLoad1, coordinator.cores)})`,
	);
	// 关键路径(规范审查 I4):「逐文件重写大 JSON 的累计字节数与耗时」两项必须齐备 ——
	// 下面这行把 `index.json` 的累计次数/字节/耗时与全部写入合计放在同一条读数上。
	console.log(
		`[T8b 写放大] 样本=${sample} 索引写入=${coordinator.indexWriteCount}次/${formatBytes(coordinator.indexWriteBytes)}/${coordinator.indexWriteMs.toFixed(0)}ms 全部写入=${coordinator.writeCount}次/${formatBytes(coordinator.writeBytes)}/${coordinator.writeMs.toFixed(0)}ms`,
	);
	// 关键路径:门槛判定只做记录,不用断言把「未达标」变成红 ——
	// 未达标本身是必须如实上报的结论,而断言失败会连带丢掉同一次运行里的其它读数。
	expect(coordinator.fullMedianMs).toBeGreaterThan(0);
	expect(t0.fullMedianMs).toBeGreaterThan(0);
	expect(t0d.fullMedianMs).toBeGreaterThan(0);
	// 零变化启动必须零嵌入(这一条是功能正确性,不是性能门槛)。
	expect(coordinator.zeroEmbedCalls).toBe(0);
	expect(t0.zeroEmbedCalls).toBe(0);
	expect(t0d.zeroEmbedCalls).toBe(0);
	expect(coordinator.singleUpdateEmbedCalls).toBe(1);
	// 关键路径(I4):`index.json` 累计耗时必须是被实测出来的正数,而不是缺省的 0。
	expect(coordinator.indexWriteMs).toBeGreaterThan(0);
	expect(t0d.indexWriteMs).toBeGreaterThan(0);
}

/**
 * 采集 512 维的绝对读数(生产维度)。
 *
 * 关键路径:512 维没有 T0 成功基线(基线是 64 维),因此这里只报绝对值与写入量,
 * 门槛判定必然为 `not-comparable` —— 判定为不可比才是如实的。
 *
 * @param sample - 笔记数。
 * @param runs - 完整构建重复次数。
 */
async function dim512At(sample: number, runs: number): Promise<void> {
	const record = await collectReading(sample, 512, 'coordinator', runs);
	console.log(`[T8b 门槛 512] ${JSON.stringify(judgeGate(record, '512 维无 T0 基线'))}`);
	console.log(
		`[T8b 写放大 512] 样本=${sample} 索引写入=${record.indexWriteCount}次/${formatBytes(record.indexWriteBytes)}/${record.indexWriteMs.toFixed(0)}ms 全部写入=${record.writeCount}次/${formatBytes(record.writeBytes)}/${record.writeMs.toFixed(0)}ms`,
	);
	expect(record.zeroEmbedCalls).toBe(0);
	expect(record.indexWriteMs).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// 100 篇档门槛判定(计划命令的默认口径)
// ---------------------------------------------------------------------------

/**
 * 100 篇档三臂 A/B — 由 @see RUN_GATE_AB_100 门控。
 *
 * 关键路径(规范审查 I2):这是计划命令
 * `npx vitest run --config vitest.index-reliability.config.ts` 默认口径下产出的 checkbox 4 判定,
 * 因此不能挂在 `RATEL_SCALE=1` 之下(此前正是如此,导致计划命令一条门槛读数都没有)。
 * 约 35s,与 3000 篇档留在重门控互不影响。
 */
describe.skipIf(!RUN_GATE_AB_100)('性能口径与相对门槛 - 100 篇档(checkbox 4,专用配置默认口径)', () => {
	it('64 维 A/B - 100 篇(三次中位数,含两侧负载与两种分母)', async () => {
		try {
			await abAt(100, 3);
		} finally {
			releaseWorkspaces();
		}
	}, 900_000);
});

// ---------------------------------------------------------------------------
// 重门控读数表(1000 / 3000 篇与 512 维,`RATEL_SCALE=1`)
// ---------------------------------------------------------------------------

describe.skipIf(!SCALE_HEAVY)('性能口径与相对门槛(checkbox 4,`RATEL_SCALE=1`)', () => {
	it('512 维绝对读数 - 100 篇(三次中位数)', async () => {
		try {
			await dim512At(100, 3);
		} finally {
			releaseWorkspaces();
		}
	}, 1_800_000);

	it('64 维 A/B - 1000 篇(三次中位数,含两侧负载)', async () => {
		try {
			await abAt(1000, 3);
		} finally {
			releaseWorkspaces();
		}
	}, 7_200_000);

	it('512 维绝对读数 - 1000 篇(三次中位数)', async () => {
		try {
			await dim512At(1000, 3);
		} finally {
			releaseWorkspaces();
		}
	}, 7_200_000);

	it('64 维 A/B - 3000 篇(单次构建,已注明非中位数)', async () => {
		try {
			await abAt(3000, 1);
		} finally {
			releaseWorkspaces();
		}
	}, 7_200_000);

	it.skipIf(process.env.RATEL_SCALE_XL !== '1')('512 维绝对读数 - 3000 篇(`RATEL_SCALE_XL=1`)', async () => {
		// 关键路径:3000 篇 @512 维的绝对读数由同一次门控运行里的规模用例
		// (`规模用例 - 3000 篇 @512 维`)给出,这里只在需要独立复现耗时/内存时开启。
		try {
			await dim512At(3000, 1);
		} finally {
			releaseWorkspaces();
		}
	}, 7_200_000);
});

// ---------------------------------------------------------------------------
// 夹具自检
// ---------------------------------------------------------------------------

describe('夹具自检', () => {
	it('确定性合成与块 ID 期望值一致', () => {
		const ws = workspace('ratel-t8b-fixture-');
		try {
			const vaultDir = ws.mkdir('vault');
			const relative = 'notes/self-check.md';
			const content = syntheticNoteContent(7, 320, 'self');
			writeNoteFile(vaultDir, relative, content);
			expect(fs.readFileSync(path.join(vaultDir, relative), 'utf8')).toBe(content);
			const ids = expectedChunkIds(relative, content);
			expect(ids.length).toBe(chunkMarkdown(content, T0_CHUNK_OPTIONS).length);
			expect(ids[0]).toBe(`${relative}#chunk-0`);
			const blocks = blocksForContent(relative, content, DEFAULT_DIMS);
			expect(blocks.map((block) => block.id)).toEqual(ids);
			// 关键路径:同内容两次生成的向量必须逐位相同(确定性假嵌入的前提)。
			expect(blocks[0]?.vector).toEqual(blocksForContent(relative, content, DEFAULT_DIMS)[0]?.vector);
		} finally {
			releaseWorkspaces();
		}
	});

	it('门槛可比性核对两个臂 - 分子或分母任一侧超核数/无读数都判 not-comparable', () => {
		/**
		 * 造一条只用于门槛判定的读数(字段与真实采集一致,数值可任意)。
		 *
		 * @param overrides - 需要覆盖的字段。
		 * @returns 读数记录。
		 */
		function recordOf(overrides: Partial<ReadingRecord>): ReadingRecord {
			return {
				sample: 100,
				path: 'coordinator',
				dimensions: 64,
				runs: 3,
				loadText: 'load=0.00/0.00/0.00 cores=10',
				maxLoad1: 0,
				cores: 10,
				loadSamples: [0],
				fullRunsMs: [4000],
				// 构造读数取 4000ms / 基线 2000ms = 2.00× ,稳定落在 1.5× 门槛之外(判定 fail)。
				fullMedianMs: 4000,
				peakHeapBytes: 0,
				peakRssBytes: 100 * 1024 * 1024,
				chunks: 0,
				zeroChangeMs: 100,
				zeroEmbedCalls: 0,
				singleUpdateMs: 0,
				singleUpdateEmbedCalls: 1,
				writeCount: 0,
				writeBytes: 0,
				writeMs: 0,
				indexWriteCount: 0,
				indexWriteBytes: 0,
				indexWriteMs: 0,
				writeKinds: {},
				indexFileBytes: 0,
				assemblyMs: 0,
				zeroChangeColdStartMs: 0,
				...overrides,
			};
		}

		const baseline: GateBaseline = {
			fullMs: 2000,
			rssBytes: 100 * 1024 * 1024,
			zeroMs: 200,
			label: '构造基线',
			maxLoad1: 5,
			cores: 10,
		};

		// 1) 两侧都在核数以内 → 给出判定,并同时呈现两侧负载。
		const comparable = judgeGate(recordOf({}), '自检:两侧空载', baseline);
		expect(comparable.fullBuild).toBe('fail');
		expect(comparable.peakRss).toBe('pass');
		expect(comparable.zeroChange).toBe('pass');
		expect(comparable.loads.measured).toContain('分子臂');
		expect(comparable.loads.reference).toContain('分母臂');

		// 2) 分子臂超核数 → not-comparable(旧实现也覆盖这一侧)。
		const hotMeasured = judgeGate(recordOf({ maxLoad1: 30 }), '自检:分子臂带载', baseline);
		expect(hotMeasured.fullBuild).toBe('not-comparable');
		expect(hotMeasured.notes.join(' ')).toContain('分子臂 1 分钟负载最高 30.00');

		// 3) **只有分母臂**超核数 → 同样必须 not-comparable(这正是旧实现漏掉的一侧)。
		const hotReference = judgeGate(recordOf({}), '自检:分母臂带载', { ...baseline, maxLoad1: 30 });
		expect(hotReference.fullBuild).toBe('not-comparable');
		expect(hotReference.peakRss).toBe('not-comparable');
		expect(hotReference.zeroChange).toBe('not-comparable');
		expect(hotReference.notes.join(' ')).toContain('分母臂 1 分钟负载最高 30.00');
		expect(hotReference.loads.reference).toContain('高于核数');

		// 4) 分母臂没有负载读数 → not-comparable,且不默认分母臂合格。
		const unknownReference = judgeGate(recordOf({}), '自检:分母臂无读数', {
			...baseline,
			maxLoad1: null,
			cores: null,
		});
		expect(unknownReference.fullBuild).toBe('not-comparable');
		expect(unknownReference.notes.join(' ')).toContain('分母臂没有负载读数');
		expect(unknownReference.loads.reference).toContain('负载未记录');

		// 5) 默认分母(T0 记录)没有负载读数 → 同样 not-comparable,并给出证据原话摘要。
		const t0Default = judgeGate(recordOf({}), '自检:默认分母');
		expect(t0Default.fullBuild).toBe('not-comparable');
		expect(t0Default.notes.join(' ')).toContain('T0 证据第 4 节');

		// 6) 分母基线低于计时分辨率 → 零变化只报绝对值,构建/RSS 仍给判定。
		const lowResolution = judgeGate(recordOf({}), '自检:低分辨率零变化基线', { ...baseline, zeroMs: 14 });
		expect(lowResolution.zeroChange).toBe('absolute-only');
		expect(lowResolution.fullBuild).toBe('fail');
		expect(lowResolution.notes.join(' ')).toContain('只报绝对值');
	});
});