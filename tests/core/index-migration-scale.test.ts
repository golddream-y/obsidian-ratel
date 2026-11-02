/**
 * @file tests/core/index-migration-scale.test.ts
 * @description 迁移兼容校验的规模成本实测 — 生产批量接缝与逐条回退接缝的耗时/枚举次数曲线
 * @module tests/core/index-migration-scale
 * @depends src/core/index-generations, src/core/index-manifest, src/core/index-persistence-types,
 *   src/adapters/vector-vectra, src/adapters/atomic-index-storage
 *
 * 测量对象边界(本文件到底在测什么):
 * - 被测入口是**真实** `IndexGenerations.migrateLegacyIndex`(迁移兼容校验的唯一生产入口),
 *   每次测量都在系统临时目录上跑真实磁盘 IO,不替换迁移引擎、不替换 `validateLegacyFileBlocks`、
 *   不替换 `computeBlockSetHash`,也不改写完成记录写入路径。
 * - 旧索引是**真实** vectra 目录形态:`legacy-index/index.json` 按 `LocalIndex` 的持久化格式
 *   一次性写出(而不是逐文件 `replaceFile` 构造)。唯一理由是**把夹具构造的写放大排除在读数
 *   之外** —— 逐文件构造本身就是 O(N²) 写盘(每次重写整份 index.json),会把待观察的迁移
 *   校验成本淹没。读取侧仍是真实 `VectraStore`:`listItems()` / `inspectFiles()` /
 *   `inspectFile()` 全部走真实实现,块枚举、块集合校验、完成记录写入都是生产代码路径。
 * - 两臂(批量 / 逐条)共用同一份旧索引与同一份清单,**唯一差异**是传给迁移入口的只读枚举面
 *   是否提供可选批量接缝 `inspectFiles`:提供走生产路径(装配层 `describeLegacyIndex` 恒提供),
 *   缺失走 `src/core/index-generations.ts` 里记录的逐条回退路径。
 * - 端到端读数会包含一份与规模**线性**的固定成本:每个可复用文件一条完成记录,而
 *   `writeJsonAtomically` 是「临时文件 fsync + rename + 目标 fsync + 目录 fsync」。本机实测
 *   该固定成本约 15.7ms/文件,在 600 文件档约 9.4s,会明显稀释枚举侧的平方信号。因此除了
 *   端到端表,本文件另加一个**枚举接缝微基准**:直接按迁移的调用方式驱动同一个真实
 *   `VectraStore`(逐条 N 次 / 批量 1 次),预热后取 3 次中位数,单独测 O(N²) 项。
 * - 观测点:
 *   1. **耗时**:整次 `migrateLegacyIndex` 的墙钟毫秒、枚举阶段累计毫秒、微基准中位毫秒;
 *   2. **次数**:真实 `VectraStore` 内部 `LocalDocumentIndex.listItems()` 的调用次数与累计返回
 *      条目数 —— 即「兼容校验真正访问了多少块」。逐条回退每次调用都全量 `listItems()`(含
 *      `slice()`)再 `filter`,该计数是平方增长的**直接测量**(不是估算)。
 * - 判定口径:端到端翻倍规模的比值(线性 ≈ 2,平方 ≈ 4),阈值取宽以避免 flaky;低于阈值断言
 *   「无超线性」。平方侧改用 100 → 600(6 倍规模)的枚举耗时倍数(线性 ≈ 6,平方 ≈ 36),
 *   阈值 8 明显高于线性;同时用确定性的条目访问计数作为硬证据。
 *
 * 实测结论(2026-11-02,本机 10 核 / Node 22 / APFS;下列为代表性一轮,同机多轮波动约 ±10%):
 * - 生产路径(批量接缝)端到端 100/300/600 文件 = 1638.7 / 4630.0 / 9718.8 ms,
 *   逐文件成本 16.4 / 15.4 / 16.2 ms(完成记录 fsync 主导),与文件数线性;
 *   块枚举每轮只 1 次(600 文件档 1200 条 / 14.9ms)。**生产路径不存在 O(N²)**。
 * - 逐条回退路径端到端 = 1590.2 / 4594.1 / 9120.8 ms(写盘主导,端到端看不出平方),
 *   但块枚举阶段 17.1 → 17.0 → 29.9ms,条目访问量 2万 → 18万 → 72万(600 文件档是
 *   100 文件档的 36 倍);隔离微基准逐条 0.54 / 3.64 / 12.77ms(600/300 翻倍约 3.5 倍、
 *   100→600 为 23.6 倍),批量 0.05 / 0.17 / 0.20ms,600 文件档批量比逐条快 64 倍 ——
 *   **平方项真实存在于逐条回退**,只是被同量级的线性写盘成本盖住。
 * - 风险点:回退分支在 `src/core/index-generations.ts` 的块枚举处(批量入口缺失或抛错时),
 *   其代价源自 `src/adapters/vector-vectra.ts` 的 `inspectFile`(全量 `listItems()` + `slice()`).
 *   生产装配层恒提供 `inspectFiles`,因此现状可控;一旦该接缝被绕过,大库迁移会回到平方级。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { VectraStore, type PreparedBlock } from '../../src/adapters/vector-vectra';
import {
	IndexGenerations,
	type GenerationLegacyBlockStore,
	type GenerationMigrationResult,
} from '../../src/core/index-generations';
import { CURRENT_CHUNKER_VERSION, type IndexManifestData, type IndexManifestEntry } from '../../src/core/index-manifest';
import type { IndexConfigDescriptor } from '../../src/core/index-persistence-types';
import type { JournalWriteOwner } from '../../src/core/index-file-journal';

// ==================== 规模口径 ====================

/** 参与测量的文件数档位 —— 100 / 300 / 600 同时覆盖「三倍」与「翻倍」两种比值。 */
const SCALES = [100, 300, 600] as const;

/** 每文件的块数 — 旧索引的典型形态量级。 */
const BLOCKS_PER_FILE = 2;

/** 向量维度 — 只影响夹具体积,不影响校验逻辑的复杂度;取小值以控制总耗时。 */
const DIMENSIONS = 32;

const CHUNK_SIZE = 100;
const CHUNK_OVERLAP = 20;

/** 单个规模的端到端测量读数。 */
interface ScaleReading {
	/** 文件数(= 清单条目数)。 */
	files: number;
	/** 整次迁移墙钟毫秒。 */
	totalMs: number;
	/** 枚举阶段累计毫秒(只包住只读枚举面,不含校验/写盘)。 */
	enumerateMs: number;
	/** 只读枚举面的调用次数(批量接缝为 1,逐条回退为文件数)。 */
	inspectCalls: number;
	/** 校验判定为可复用的文件数。 */
	reusable: number;
	/** 校验实际比较的块数(所有文件块数之和)。 */
	blocksCompared: number;
	/** 真实 `listItems()` 调用次数。 */
	listItemsCalls: number;
	/** 真实 `listItems()` 累计返回条目数 —— 逐条回退即「块数 × 文件数」。 */
	itemsVisited: number;
}

/** 一次端到端测量的完整结果。 */
interface ScaleRun {
	readonly reading: ScaleReading;
	readonly result: GenerationMigrationResult;
}

/** 枚举接缝微基准的单档读数。 */
interface BenchReading {
	/** 文件数。 */
	files: number;
	/** 3 次采样的中位毫秒。 */
	medianMs: number;
	/** 单次采样的 `listItems()` 累计返回条目数。 */
	itemsVisited: number;
	/** 单次采样的 `listItems()` 调用次数。 */
	listItemsCalls: number;
}

/** 本文件用到的临时工作区 — 每个用例结束即释放。 */
const workspaces = new Set<string>();

afterEach(() => {
	for (const root of workspaces) fs.rmSync(root, { recursive: true, force: true });
	workspaces.clear();
});

/** 创建并登记一个临时工作区(真实磁盘)。 */
function createWorkspace(prefix: string): string {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `ratel-mig-scale-${prefix}-`));
	workspaces.add(root);
	return root;
}

// ==================== 夹具 ====================

/** 可观测写所有权门面 — 迁移入口必填,记录断言次数以便确认确实复核过。 */
class TestWriteOwner implements JournalWriteOwner {
	epoch = 1;
	assertCount = 0;

	assertWritable(): void {
		this.assertCount += 1;
	}

	beginCommit(): { settle(): void } {
		return { settle: (): void => undefined };
	}
}

/** 当前生效配置 — 本地已知模型 + 可确认修订,迁移会走到「逐文件兼容校验」。 */
function currentConfig(): IndexConfigDescriptor {
	return {
		embeddingModelId: 'local:bge-small-zh-v1.5',
		embeddingModelRevision: 'v1.5',
		embeddingDimension: DIMENSIONS,
		chunkerVersion: CURRENT_CHUNKER_VERSION,
		chunkSize: CHUNK_SIZE,
		chunkOverlap: CHUNK_OVERLAP,
		embeddingTextVersion: null,
	};
}

/** 第 `index` 篇笔记的合成正文 — 只用于派生稳定 hash。 */
function contentOf(index: number): string {
	return `第 ${index} 篇规模样本\n正文第 ${index} 行`;
}

/** 与 vault 侧同口径的内容 hash(hex sha256),形状由 `parseLegacyManifestEntry` 校验。 */
function digestOf(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 确定性向量 — 全部有限、同维度,通过 `validateLegacyFileBlocks` 的维度与有限值检查。 */
function vectorFor(fileIndex: number, chunkIndex: number): number[] {
	const vector: number[] = new Array(DIMENSIONS);
	for (let dimension = 0; dimension < DIMENSIONS; dimension += 1) {
		vector[dimension] = Math.sin(fileIndex * 0.11 + chunkIndex * 0.37 + dimension * 0.53);
	}
	return vector;
}

/** 向量范数 — vectra 持久化格式的一部分,写真实形态而不是最小可读形态。 */
function normOf(vector: readonly number[]): number {
	let sum = 0;
	for (const value of vector) sum += value * value;
	return Math.sqrt(sum);
}

/** 旧索引夹具 — 真实 vectra 目录 + 旧版清单 + 当前内容 hash 视图。 */
interface LegacyFixture {
	/** 旧 Vectra 目录(迁移的只读来源)。 */
	readonly legacyDir: string;
	/** 旧清单文件路径。 */
	readonly manifestPath: string;
	/** 旧清单声明的路径(与写入顺序一致)。 */
	readonly paths: string[];
	/** 当前内容 hash 视图(与清单逐项相等)。 */
	readonly currentInputs: Map<string, string>;
}

/**
 * 构造旧索引夹具。
 *
 * 关键路径:块按 `LocalIndex` 的持久化格式一次写出(见文件头「测量对象边界」);
 * 清单 `hash` 与 `currentInputs` 用同一个 hash,保证所有路径都进入「真正需要枚举块集合」的
 * `eligible` 集合 —— 这正是被测的兼容校验成本所在。
 */
function buildLegacyFixture(root: string, fileCount: number): LegacyFixture {
	const legacyDir = path.join(root, 'legacy-index');
	fs.mkdirSync(legacyDir, { recursive: true });
	const entries: Record<string, IndexManifestEntry> = {};
	const currentInputs = new Map<string, string>();
	const items: Array<Record<string, unknown>> = [];
	const paths: string[] = [];
	for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
		const filePath = `notes/规模-${String(fileIndex).padStart(4, '0')}.md`;
		const hash = digestOf(contentOf(fileIndex));
		const commitId = `commit-${fileIndex}`;
		paths.push(filePath);
		currentInputs.set(filePath, hash);
		entries[filePath] = { path: filePath, hash, mtime: 1_700_000_000_000, chunkCount: BLOCKS_PER_FILE };
		for (let chunkIndex = 0; chunkIndex < BLOCKS_PER_FILE; chunkIndex += 1) {
			const vector = vectorFor(fileIndex, chunkIndex);
			const id = `${filePath}#chunk-${chunkIndex}`;
			items.push({
				id,
				metadata: {
					path: filePath,
					chunkIndex,
					startOffset: chunkIndex * 100,
					prefix: '',
					headingPath: [] as string[],
					commitId,
					docId: id,
					documentId: id,
				},
				vector,
				norm: normOf(vector),
			});
		}
	}
	fs.writeFileSync(
		path.join(legacyDir, 'index.json'),
		JSON.stringify({ version: 1, metadata_config: {}, items }),
		'utf8',
	);
	const manifest: IndexManifestData = {
		version: 1,
		embedModelId: 'local:bge-small-zh-v1.5',
		chunkSize: CHUNK_SIZE,
		chunkOverlap: CHUNK_OVERLAP,
		chunkerVersion: CURRENT_CHUNKER_VERSION,
		lastIndexTime: 1_700_000_000_000,
		entries,
	};
	const manifestPath = path.join(root, 'legacy-manifest.json');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
	return { legacyDir, manifestPath, paths, currentInputs };
}

/** 按夹具构造真实只读存储(不初始化写入,与装配层 `describeLegacyIndex` 同形)。 */
function openLegacyStore(fixture: LegacyFixture): VectraStore {
	return new VectraStore(fixture.legacyDir, {
		autoInit: false,
		storage: new AtomicIndexStorage({ generationRoot: fixture.legacyDir }),
	});
}

// ==================== 观测 ====================

/** 真实 `listItems()` 的观测计数 — 兼容校验实际访问的条目数。 */
interface ListItemsCounters {
	calls: number;
	itemsVisited: number;
}

/** `VectraStore` 内部索引实例的最小观测面(私有字段在运行时可达,仅用于计数)。 */
interface ObservableIndex {
	listItems(): Promise<unknown[]>;
}

/**
 * 给真实 `VectraStore` 内部的 `LocalDocumentIndex` 装上 `listItems()` 计数器。
 *
 * 关键路径:`inspectFile` 每次调用都会「全量 `listItems()`(含 `slice()`)后 filter」,
 * 因此这个计数就是逐条回退路径访问条目数的**直接测量**;批量接缝只会在一次调用内枚举一次。
 */
function observeListItems(store: VectraStore): ListItemsCounters {
	const counters: ListItemsCounters = { calls: 0, itemsVisited: 0 };
	const handle = (store as unknown as { index: ObservableIndex | null }).index;
	if (handle === null) throw new Error('真实 VectraStore 尚未 init,无法观测 listItems');
	const original = handle.listItems.bind(handle);
	handle.listItems = async (): Promise<unknown[]> => {
		const items = await original();
		counters.calls += 1;
		counters.itemsVisited += items.length;
		return items;
	};
	return counters;
}

/** 枚举阶段观测 — 只包住只读枚举面。 */
interface InspectStats {
	enumerateMs: number;
	calls: number;
	blocks: number;
}

/**
 * 构造迁移入口的只读枚举面。
 *
 * @param store - 真实 `VectraStore`。
 * @param batch - 是否提供可选批量接缝 `inspectFiles`(false 即模拟缺少该方法的旧存储)。
 * @param stats - 枚举阶段耗时/次数累加器。
 * @returns 只读枚举面。
 */
function legacyPort(store: VectraStore, batch: boolean, stats: InspectStats): GenerationLegacyBlockStore {
	const port: GenerationLegacyBlockStore = {
		inspectFile: async (filePath: string): Promise<PreparedBlock[]> => {
			const startedAt = performance.now();
			const blocks = await store.inspectFile(filePath);
			stats.enumerateMs += performance.now() - startedAt;
			stats.calls += 1;
			stats.blocks += blocks.length;
			return blocks;
		},
	};
	if (batch) {
		port.inspectFiles = async (paths: string[]): Promise<Map<string, PreparedBlock[]>> => {
			const startedAt = performance.now();
			const grouped = await store.inspectFiles(paths);
			stats.enumerateMs += performance.now() - startedAt;
			stats.calls += 1;
			for (const blocks of grouped.values()) stats.blocks += blocks.length;
			return grouped;
		};
	}
	return port;
}

/**
 * 跑一次真实迁移并汇总读数。
 *
 * @param root - 工作区根。
 * @param fixture - 旧索引夹具。
 * @param label - 目标索引子目录名(两臂各用独立目标,避免完成记录互相影响)。
 * @param batch - 是否提供批量接缝。
 */
async function runMigration(
	root: string,
	fixture: LegacyFixture,
	label: string,
	batch: boolean,
): Promise<ScaleRun> {
	const indexRoot = path.join(root, label, '.index');
	const owner = new TestWriteOwner();
	const generations = new IndexGenerations({ indexRoot, owner });
	const store = openLegacyStore(fixture);
	await store.init();
	const counters = observeListItems(store);
	const stats: InspectStats = { enumerateMs: 0, calls: 0, blocks: 0 };
	const port = legacyPort(store, batch, stats);
	const startedAt = performance.now();
	const result = await IndexGenerations.migrateLegacyIndex({
		indexRoot,
		generations,
		config: currentConfig(),
		legacy: {
			legacyIndexDir: fixture.legacyDir,
			manifestPath: fixture.manifestPath,
			store: port,
		},
		owner,
		currentInputs: fixture.currentInputs,
		chunkLimits: { chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP },
	});
	const totalMs = performance.now() - startedAt;
	return {
		result,
		reading: {
			files: fixture.paths.length,
			totalMs,
			enumerateMs: stats.enumerateMs,
			inspectCalls: stats.calls,
			reusable: result.files.filter((file) => file.status === 'reusable').length,
			blocksCompared: result.files.reduce((sum, file) => sum + file.actualChunkCount, 0),
			listItemsCalls: counters.calls,
			itemsVisited: counters.itemsVisited,
		},
	};
}

// ==================== 打印与断言工具 ====================

/** 打印一张中文表头的端到端读数表。 */
function printTable(title: string, rows: ScaleReading[]): void {
	console.log(`\n${title}`);
	console.table(
		rows.map((row) => ({
			文件数: row.files,
			总耗时毫秒: Number(row.totalMs.toFixed(1)),
			枚举耗时毫秒: Number(row.enumerateMs.toFixed(2)),
			枚举调用次数: row.inspectCalls,
			可复用文件: row.reusable,
			比较块数: row.blocksCompared,
			listItems调用: row.listItemsCalls,
			listItems条目: row.itemsVisited,
		})),
	);
}

/** 取某个规模的读数;缺失即硬失败,避免规模表悄悄少一行。 */
function readingAt<T extends { files: number }>(readings: readonly T[], files: number): T {
	const found = readings.find((reading) => reading.files === files);
	if (found === undefined) throw new Error(`缺少 ${files} 文件档的读数`);
	return found;
}

/** 断言一次迁移确实完成了逐文件校验(而不是提前失败返回)。 */
function expectPublished(run: ScaleRun): void {
	expect(run.result.published).toBe(true);
	expect(run.result.committed).toBe(true);
	expect(run.result.reason).toBe(null);
	expect(run.reading.reusable).toBe(run.reading.files);
	expect(run.reading.blocksCompared).toBe(run.reading.files * BLOCKS_PER_FILE);
}

/** 校验结论的稳定投影 — 用于证明两条枚举路径给出同一套判定。 */
function verdictShape(run: ScaleRun): Array<Record<string, unknown>> {
	return run.result.files.map((file) => ({
		path: file.path,
		status: file.status,
		reason: file.reason,
		actualChunkCount: file.actualChunkCount,
		blockSetHash: file.blockSetHash,
		commitId: file.commitId,
	}));
}

// ==================== 用例 ====================

// 关键路径:规模用例默认不跑(单次约 37 秒),由 RATEL_SCALE_SUITE=1 显式打开。
describe.skipIf(process.env.RATEL_SCALE_SUITE !== '1')('迁移兼容校验 - 规模成本', () => {
	it('生产批量接缝 - 100/300/600 文件 - 端到端耗时随规模线性增长且每轮只枚举一次', async () => {
		const root = createWorkspace('batch');
		const readings: ScaleReading[] = [];
		for (const scale of SCALES) {
			const fixture = buildLegacyFixture(path.join(root, String(scale)), scale);
			const run = await runMigration(root, fixture, `batch-${scale}`, true);
			expectPublished(run);
			// 批量接缝的结构性证据:无论多少文件,块枚举只发生一次。
			expect(run.reading.inspectCalls).toBe(1);
			expect(run.reading.listItemsCalls).toBe(1);
			expect(run.reading.itemsVisited).toBe(scale * BLOCKS_PER_FILE);
			readings.push(run.reading);
		}
		printTable('表 A — 生产路径(批量 inspectFiles):迁移兼容校验端到端耗时', readings);
		console.log(
			'生产路径每文件端到端成本(100/300/600):'
			+ readings.map((reading) => `${(reading.totalMs / reading.files).toFixed(1)}ms`).join(' / ')
			+ ' —— 与文件数线性,且由每条完成记录的 fsync 主导(块枚举只占十几毫秒)。',
		);

		// 翻倍规模(300 → 600)的耗时比值:线性 ≈ 2,平方 ≈ 4。
		// 阈值 3.0 宽于噪声:低于它即证明端到端没有出现超线性增长。
		const doublingRatio = readingAt(readings, 600).totalMs / readingAt(readings, 300).totalMs;
		console.log(`生产路径 600/300 文件耗时比:${doublingRatio.toFixed(2)}(线性 ≈ 2,平方 ≈ 4)`);
		expect(doublingRatio).toBeLessThan(3.0);
		// 三倍规模(100 → 300):线性 ≈ 3,平方 ≈ 9。
		const triplingRatio = readingAt(readings, 300).totalMs / readingAt(readings, 100).totalMs;
		console.log(`生产路径 300/100 文件耗时比:${triplingRatio.toFixed(2)}(线性 ≈ 3,平方 ≈ 9)`);
		expect(triplingRatio).toBeLessThan(4.2);
	}, 60_000);

	it('逐条回退接缝 - 100/300/600 文件 - 枚举条目数按平方增长,且判定结论与批量路径一致', async () => {
		const root = createWorkspace('single');
		const readings: ScaleReading[] = [];
		const runs = new Map<number, ScaleRun>();
		const fixtures = new Map<number, LegacyFixture>();
		for (const scale of SCALES) {
			const fixture = buildLegacyFixture(path.join(root, String(scale)), scale);
			fixtures.set(scale, fixture);
			const run = await runMigration(root, fixture, `single-${scale}`, false);
			expectPublished(run);
			// 回退路径的结构性证据:每个文件一次枚举,每次枚举都全量 listItems 后过滤。
			expect(run.reading.inspectCalls).toBe(scale);
			expect(run.reading.listItemsCalls).toBe(scale);
			expect(run.reading.itemsVisited).toBe(scale * scale * BLOCKS_PER_FILE);
			readings.push(run.reading);
			runs.set(scale, run);
		}
		printTable('表 B — 回退路径(逐条 inspectFile):迁移兼容校验端到端耗时', readings);

		// 条目访问量是平方的直接证据(确定性计数,不受机器快慢影响):
		// 300 → 600 文件时,访问条目数从 300×600 涨到 600×1200,恰为 4 倍。
		const itemsRatio = readingAt(readings, 600).itemsVisited / readingAt(readings, 300).itemsVisited;
		expect(itemsRatio).toBe(4);
		const inspectCallRatio = readingAt(readings, 600).inspectCalls / readingAt(readings, 300).inspectCalls;
		expect(inspectCallRatio).toBe(2);

		// 判定结论必须与批量路径逐项一致:回退只改变代价,不改变兼容校验语义。
		// 同一份旧索引(只读)换一个目标索引根再跑一次批量路径即可对照。
		const fixture100 = fixtures.get(100);
		if (fixture100 === undefined) throw new Error('缺少 100 文件档夹具');
		const batchRun = await runMigration(root, fixture100, 'single-100-batch', true);
		expectPublished(batchRun);
		expect(verdictShape(runs.get(100) as ScaleRun)).toEqual(verdictShape(batchRun));
		console.log(
			`同一份 100 文件旧索引:批量路径访问 ${batchRun.reading.itemsVisited} 条,`
			+ `逐条路径访问 ${(runs.get(100) as ScaleRun).reading.itemsVisited} 条`,
		);
	}, 60_000);

	it('枚举接缝微基准 - 预热后取 3 次中位 - 逐条枚举平方增长、批量恒为一次全量枚举', async () => {
		const root = createWorkspace('bench');
		const single: BenchReading[] = [];
		const batch: BenchReading[] = [];
		for (const scale of SCALES) {
			const fixture = buildLegacyFixture(path.join(root, String(scale)), scale);
			const store = openLegacyStore(fixture);
			await store.init();
			single.push(await benchEnumeration(store, fixture.paths, false));
			batch.push(await benchEnumeration(store, fixture.paths, true));
		}
		console.log('\n表 C — 枚举接缝微基准(真实 VectraStore,预热 1 次 + 3 次采样取中位数)');
		console.table([
			...single.map((row) => ({
				路径: '逐条 inspectFile',
				文件数: row.files,
				中位毫秒: Number(row.medianMs.toFixed(2)),
				listItems调用: row.listItemsCalls,
				listItems条目: row.itemsVisited,
			})),
			...batch.map((row) => ({
				路径: '批量 inspectFiles',
				文件数: row.files,
				中位毫秒: Number(row.medianMs.toFixed(2)),
				listItems调用: row.listItemsCalls,
				listItems条目: row.itemsVisited,
			})),
		]);

		// 批量接缝:每次调用只枚举一次全量条目,条目数随文件数线性增长。
		for (const row of batch) {
			expect(row.listItemsCalls).toBe(1);
			expect(row.itemsVisited).toBe(row.files * BLOCKS_PER_FILE);
		}
		// 逐条回退:调用次数 = 文件数,条目访问量 = 文件数 × 全量条目数(平方)。
		for (const row of single) {
			expect(row.listItemsCalls).toBe(row.files);
			expect(row.itemsVisited).toBe(row.files * row.files * BLOCKS_PER_FILE);
		}
		// 耗时同向:用 100 → 600(6 倍规模)这一跨度判定 —— 线性 ≈ 6,平方 ≈ 36。
		// 阈值取 8(宽于噪声又明显高于线性):逐条回退必须超过它。
		// 批量接缝只做结构性断言(每次调用一次全量枚举):它在 600 文件档仍是 0.24ms 量级,
		// 单次调用的常数项会盖过线性项,拿毫秒比值判定没有意义。
		const singleSpan = readingAt(single, 600).medianMs / readingAt(single, 100).medianMs;
		const batchSpan = readingAt(batch, 600).medianMs / readingAt(batch, 100).medianMs;
		const speedup = readingAt(single, 600).medianMs / readingAt(batch, 600).medianMs;
		console.log(
			`枚举耗时 100→600 文件倍数 —— 逐条:${singleSpan.toFixed(1)}(线性 ≈ 6,平方 ≈ 36),`
			+ `批量:${batchSpan.toFixed(1)}(线性 ≈ 6)`,
		);
		console.log(`600 文件档:批量入口比逐条回退快 ${speedup.toFixed(1)} 倍`);
		expect(singleSpan).toBeGreaterThan(8);
		// 同一档位上批量入口必须显著更快,这是「迁移侧走批量接缝」的直接收益。
		expect(speedup).toBeGreaterThan(10);
	}, 60_000);
});

/**
 * 枚举接缝微基准 — 完全按迁移的调用方式驱动真实存储。
 *
 * 关键路径:预热 1 次不计入(`listItems()` 的首次调用含索引加载与 JIT 冷启动),
 * 随后 3 次采样取中位数,避免单次抖动;计数取单次采样的稳定值。
 *
 * @param store - 已 `init()` 的真实存储。
 * @param paths - 该档位的全部路径。
 * @param batch - true 走一次批量入口,false 逐条枚举。
 */
async function benchEnumeration(store: VectraStore, paths: string[], batch: boolean): Promise<BenchReading> {
	const counters = observeListItems(store);
	const once = async (): Promise<{ ms: number; items: number; calls: number }> => {
		const itemsBefore = counters.itemsVisited;
		const callsBefore = counters.calls;
		const startedAt = performance.now();
		if (batch) {
			await store.inspectFiles(paths);
		} else {
			for (const filePath of paths) await store.inspectFile(filePath);
		}
		return {
			ms: performance.now() - startedAt,
			items: counters.itemsVisited - itemsBefore,
			calls: counters.calls - callsBefore,
		};
	};
	await once();
	const samples = [await once(), await once(), await once()];
	const sorted = samples.map((sample) => sample.ms).sort((left, right) => left - right);
	const median = sorted[1] ?? Number.NaN;
	const sample = samples[1] ?? samples[0];
	if (sample === undefined) throw new Error('微基准没有采样结果');
	return {
		files: paths.length,
		medianMs: median,
		itemsVisited: sample.items,
		listItemsCalls: sample.calls,
	};
}
