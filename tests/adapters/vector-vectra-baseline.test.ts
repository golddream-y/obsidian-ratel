/**
 * @file tests/adapters/vector-vectra-baseline.test.ts
 * @description T0 基线采集 — 生产链路耗时/内存、等价事务循环写入量、增量路径落盘次数
 * @module tests/adapters/vector-vectra-baseline
 * @depends adapters/vector-vectra, worker/index-processor, vectra, tests/helpers/index-reliability-production
 *
 * 关键路径(口径必须与证据文件一致,不能混为一个):
 * - 耗时、峰值 heap/RSS、嵌入调用次数:来自生产链路 `runProductionIndex`
 *   (`VectraStore` + `InlineWorker` + `PersistentIndexBackend` + `IndexManager`,与 `src/main.ts` 同序装配)。
 * - 写入次数与字节数:来自 `LocalDocumentIndex` + `AtomicTestFileStorage` 的等价事务循环
 *   (`measureWriteAmplification`)。生产 `VectraStore` 没有 storage 注入点,这一列不是生产链路
 *   直接测得的数字,只代表 vectra 的持久化行为;引用时不能与耗时写成同一口径。
 * - 向量维度默认 64(生产为 512,见 `src/adapters/embedding-onnx.ts`),字节量相对生产低估约 8 倍;
 *   「512 维约为 64 维 8 倍」由 `RATEL_T0_DIM512=1` 门控用例单独复现。
 * - 大样本(1000/3000)由 `RATEL_T0_BASELINE=1` 门控,默认不跑。
 */

import { describe, it, expect, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LocalFileStorage } from 'vectra';
import { chunkMarkdown } from '../../src/worker/chunker';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { IndexProcessor } from '../../src/worker/index-processor';
import {
	AtomicTestFileStorage,
	FakeEmbeddingPort,
	T0_CHUNK_OPTIONS,
	blockMetadata,
	createDocumentIndex,
	createTempWorkspace,
	formatBytes,
	generateSyntheticNotes,
	median,
	seedStoreBlocks,
	writeNotesToDisk,
	type MemoryPeaks,
} from '../helpers/index-reliability-fixture';
import { runProductionIndex } from '../helpers/index-reliability-production';

/** 基线使用的向量维度 — 64 维让 3000 篇样本的磁盘写入量可控,报告中注明实际取值。 */
const BASELINE_DIMENSIONS = 64;
/** 大样本(1000/3000)需要显式开启,避免默认测试运行过久。 */
const BASELINE_LARGE = process.env.RATEL_T0_BASELINE === '1';
/** 512 维对比需要显式开启:它只为复现「字节量约为 64 维 8 倍」这一结论。 */
const BASELINE_DIM512 = process.env.RATEL_T0_DIM512 === '1';

/**
 * 用注入存储的等价事务循环统计写入次数与字节数。
 *
 * 关键路径:`VectraStore` 没有 storage 注入点,因此这里用 `LocalDocumentIndex` +
 * 与 `IndexProcessor.indexFull` 相同的「每文件一个事务」循环统计写入量;
 * 写入次数与字节数由 vectra 的持久化行为决定,与生产链路一致,
 * 但**耗时与内存不来自这里** —— 两组数字不得混为同一口径。
 *
 * @param noteCount - 笔记数量。
 * @param dimensions - 向量维度。
 * @returns 索引/目录/外置 metadata 的写入次数与字节数。
 */
async function measureWriteAmplification(
	noteCount: number,
	dimensions: number,
): Promise<{ indexWrites: number; indexBytes: number; catalogWrites: number; metadataWrites: number; totalBytes: number }> {
	const ws = createTempWorkspace(`ratel-t0-writes-${noteCount}-`);
	try {
		const dir = ws.mkdir('index');
		// 关键路径:关闭 fsync 只用于统计写入量,不用于原子性验证。
		const storage = new AtomicTestFileStorage({ fsync: false });
		const index = await createDocumentIndex({ folderPath: dir, storage });
		const port = new FakeEmbeddingPort(dimensions);
		for (const note of generateSyntheticNotes(noteCount)) {
			const chunks = chunkMarkdown(note.content, T0_CHUNK_OPTIONS);
			if (chunks.length === 0) continue;
			const vectors = await port.embed(chunks.map((chunk) => chunk.embedText));
			await index.beginUpdate();
			try {
				for (const [i, chunk] of chunks.entries()) {
					await index.upsertItem({
						id: `${note.path}#chunk-${i}`,
						vector: vectors[i] ?? [],
						metadata: blockMetadata(note.path, i, { startOffset: chunk.startOffset }),
					});
				}
				await index.endUpdate();
			} catch (err) {
				index.cancelUpdate();
				throw err;
			}
		}
		return {
			indexWrites: storage.indexWriteCount(),
			indexBytes: storage.indexWriteBytes(),
			catalogWrites: storage.writes.filter((write) => write.kind === 'catalog').length,
			metadataWrites: storage.writes.filter((write) => write.kind === 'metadata').length,
			totalBytes: storage.totalWriteBytes(),
		};
	} finally {
		ws.dispose();
	}
}

/**
 * 采集并打印写入放大:每文件一个事务下的索引文件写入次数与字节数。
 *
 * @param noteCount - 笔记数量。
 * @param dimensions - 向量维度,默认基线维度。
 */
async function reportWriteAmplification(noteCount: number, dimensions = BASELINE_DIMENSIONS): Promise<void> {
	const writes = await measureWriteAmplification(noteCount, dimensions);
	console.log(
		[
			`[T0 写入放大] 样本=${noteCount} 维度=${dimensions}`,
			`索引写入=${writes.indexWrites}次/${formatBytes(writes.indexBytes)}`,
			`catalog=${writes.catalogWrites}次 外置metadata=${writes.metadataWrites}次`,
			`总写入=${formatBytes(writes.totalBytes)}`,
		].join(' | '),
	);
}

/**
 * 采集一组样本:三次全量索引 + 零变化启动 + 单文件更新 + 写入放大统计。
 *
 * @param noteCount - 笔记数量。
 * @param runs - 全量索引重复次数。
 */
async function collectBaseline(noteCount: number, runs: number): Promise<void> {
	const ws = createTempWorkspace(`ratel-t0-baseline-${noteCount}-`);
	try {
		const vaultDir = ws.mkdir('vault');
		const notePaths = writeNotesToDisk(vaultDir, generateSyntheticNotes(noteCount));
		const durations: number[] = [];
		const peaks: MemoryPeaks[] = [];
		let chunks = 0;
		let indexBytes = 0;
		let lastIndexDir = '';

		for (let run = 1; run <= runs; run++) {
			const indexDir = ws.mkdir(`index-run-${run}`);
			lastIndexDir = indexDir;
			const result = await runProductionIndex({ vaultDir, indexDir, notePaths, dimensions: BASELINE_DIMENSIONS });
			expect(result.errors).toBe(0);
			expect(result.indexed).toBe(noteCount);
			durations.push(result.elapsedMs);
			peaks.push(result.peaks);
			chunks = result.embedTexts;
			indexBytes = result.indexBytes;
		}

		// 零变化启动:同一索引目录重建全部对象,应零嵌入。
		const zeroChange = await runProductionIndex({
			vaultDir,
			indexDir: lastIndexDir,
			notePaths,
			dimensions: BASELINE_DIMENSIONS,
		});
		expect(zeroChange.indexed).toBe(0);
		expect(zeroChange.embedCalls).toBe(0);

		// 单文件更新:改一篇文件后重建,应只嵌入该文件。
		const updatedPath = notePaths[0];
		if (updatedPath) {
			await fsp.appendFile(path.join(vaultDir, updatedPath), '\n## 追加\n追加内容用于单文件更新基线。\n', 'utf8');
		}
		const singleUpdate = await runProductionIndex({
			vaultDir,
			indexDir: lastIndexDir,
			notePaths,
			dimensions: BASELINE_DIMENSIONS,
		});
		expect(singleUpdate.indexed).toBe(1);
		expect(singleUpdate.embedCalls).toBe(1);

		const peakHeap = Math.max(...peaks.map((peak) => peak.peakHeapUsed));
		const peakRss = Math.max(...peaks.map((peak) => peak.peakRss));

		console.log(
			[
				`[T0 基线] 样本=${noteCount} 维度=${BASELINE_DIMENSIONS} 块数=${chunks}`,
				`耗时(ms)=${durations.map((value) => value.toFixed(0)).join('/')} 中位=${median(durations).toFixed(0)}`,
				`峰值heap=${formatBytes(peakHeap)} 峰值rss=${formatBytes(peakRss)}`,
				`索引文件=${formatBytes(indexBytes)}`,
				`零变化启动=${zeroChange.elapsedMs.toFixed(0)}ms 嵌入调用=${zeroChange.embedCalls}`,
				`单文件更新=${singleUpdate.elapsedMs.toFixed(0)}ms 嵌入调用=${singleUpdate.embedCalls} 文本=${singleUpdate.embedTexts}`,
			].join(' | '),
		);
		// 关键路径:写入量单独成组(可单独复跑),避免大样本重复跑三次全量。
		if (noteCount <= 100) await reportWriteAmplification(noteCount);
	} finally {
		ws.dispose();
	}
}

describe('基线采集 - 现有成功路径', () => {
	it('100 篇 - 三次全量 + 零变化启动 + 单文件更新 - 记录耗时与写入量', async () => {
		await collectBaseline(100, 3);
	}, 600_000);
});

describe.skipIf(!BASELINE_DIM512)('基线采集 - 512 维写入量（RATEL_T0_DIM512=1）', () => {
	it('100 篇 - 512 维与 64 维写入字节对比 - 约为 8 倍', async () => {
		// 关键路径:同一份合成数据、同一套分块与事务循环,只改向量维度;
		// 比值证明「64 维基线字节量低估约 8 倍」,而不是把 512 维当成另一套口径。
		const low = await measureWriteAmplification(100, BASELINE_DIMENSIONS);
		const high = await measureWriteAmplification(100, 512);
		const ratio = high.indexBytes / low.indexBytes;
		console.log(
			[
				`[T0 512 维] 样本=100`,
				`64维=${formatBytes(low.indexBytes)}`,
				`512维=${formatBytes(high.indexBytes)}`,
				`比值=${ratio.toFixed(2)}`,
			].join(' | '),
		);
		// 关键路径:向量载荷占绝对多数,但块 ID 与 metadata 不随维度增长,
		// 因此比值稳定在 8 以下(本机实测 7.25);区间同时排除「没写向量」与「维度没生效」两种退化。
		expect(ratio).toBeGreaterThan(6.5);
		expect(ratio).toBeLessThan(9.5);
	}, 600_000);
});

describe('增量路径写入计量', () => {
	it('单文件更新 - reembedFile 先删后写 - 索引文件落盘 2 次', async () => {
		// 关键路径:reembedFile 先调 deleteByPath(事务外,deleteItems 自行 begin/end 提交一次),
		// 再 beginFileUpdate/endFileUpdate(提交一次),因此单文件增量实际落盘 2 次。
		// 计数方式:拦截 vectra `LocalFileStorage.upsertFile` 原型方法并调用原实现,
		// 只观察真实落盘,不改变行为、不访问私有字段。
		const ws = createTempWorkspace('ratel-t0-incremental-writes-');
		try {
			const dir = ws.mkdir('index');
			const store = new VectraStore(dir);
			await store.isIndexCreated();
			await seedStoreBlocks(store, 'notes/target.md', 6, 512);

			const indexWrites: string[] = [];
			const originalUpsertFile = LocalFileStorage.prototype.upsertFile;
			const spy = vi.spyOn(LocalFileStorage.prototype, 'upsertFile').mockImplementation(function (
				this: LocalFileStorage,
				filePath: string,
				content: Buffer | string,
			): Promise<void> {
				if (path.basename(filePath) === 'index.json') indexWrites.push(filePath);
				return originalUpsertFile.call(this, filePath, content);
			});
			try {
				// 阶段 1:事务外删除一次,deleteItems 自行提交 —— 落盘 1 次。
				const deleted = await store.deleteByPath('notes/target.md');
				expect(deleted).toBe(6);
				expect(indexWrites).toHaveLength(1);

				// 阶段 2:重新播种后走生产 indexBatch(reembedFile = 先删后写)。
				await seedStoreBlocks(store, 'notes/target.md', 6, 512);
				indexWrites.length = 0;

				const note = generateSyntheticNotes(1)[0];
				expect(note).toBeDefined();
				const processor = new IndexProcessor(store, new FakeEmbeddingPort(512), T0_CHUNK_OPTIONS);
				const result = await processor.indexBatch([{ path: 'notes/target.md', content: note?.content ?? '' }]);
				expect(result.errors).toBe(0);
				expect(indexWrites).toHaveLength(2);
			} finally {
				spy.mockRestore();
			}
		} finally {
			ws.dispose();
		}
	}, 60_000);
});

describe.skipIf(!BASELINE_LARGE)('基线采集 - 写入放大（RATEL_T0_BASELINE=1）', () => {
	it('1000 篇 - 每文件一个事务 - 统计索引写入次数与字节', async () => {
		await reportWriteAmplification(1000);
	}, 900_000);

	it('3000 篇 - 每文件一个事务 - 统计索引写入次数与字节', async () => {
		await reportWriteAmplification(3000);
	}, 1_800_000);
});

describe.skipIf(!BASELINE_LARGE)('基线采集 - 大样本（RATEL_T0_BASELINE=1）', () => {
	it('1000 篇 - 三次全量 + 零变化启动 + 单文件更新 - 记录耗时与写入量', async () => {
		await collectBaseline(1000, 3);
	}, 1_800_000);

	it('3000 篇 - 三次全量 + 零变化启动 + 单文件更新 - 记录耗时与写入量', async () => {
		await collectBaseline(3000, 3);
	}, 3_600_000);
});
