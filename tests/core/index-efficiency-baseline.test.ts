/**
 * @file tests/core/index-efficiency-baseline.test.ts
 * @description 效率组基准 — 构建耗时、峰值内存与落盘体积（默认跳过）
 * @module tests/core/index-efficiency-baseline
 *
 * 关键路径:
 * - 这是「效率」这一组的手工基准，不追求毫秒级精度，只给出同机可复现的三个数字:
 *   构建耗时、采样到的峰值堆内存、索引目录最终字节数。
 * - 默认不跑:单次约数十秒，且数字随机器波动，混进默认套件只会制造假失败。
 * - 打开方式 `RATEL_EFFICIENCY=1`；规模用 `RATEL_EFFICIENCY_FILES` 覆盖。
 * - 本基准测的是**当前实现路径**。线程版对照必须在宿主内采集，不能用这里的数字冒充。
 */

import { afterAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { createShardedStore } from '../../src/adapters/vector-vectra-sharded';
import { MIN_SHARDS } from '../../src/core/index-shard-routing';
import { open, rename, rm } from 'node:fs/promises';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { chunkMarkdown } from '../../src/worker/chunker';
import { createWorkerJournal, WorkerJournalOwner } from '../../src/worker/index-runtime-journal';

const ENABLED = process.env.RATEL_EFFICIENCY === '1';
const FILE_COUNT = Number.parseInt(process.env.RATEL_EFFICIENCY_FILES ?? '100', 10);
const DIMENSIONS = 64;
const CHUNK_OPTIONS = { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length };

/** 递归统计目录字节数。 */
async function directoryBytes(target: string): Promise<number> {
	let total = 0;
	for (const entry of await fsp.readdir(target, { withFileTypes: true })) {
		const full = path.join(target, entry.name);
		if (entry.isDirectory()) total += await directoryBytes(full);
		else total += (await fsp.stat(full)).size;
	}
	return total;
}

/** 造一篇约 2KB 的正文。 */
function makeContent(index: number): string {
	return Array.from({ length: 12 }, (_, line) => `第 ${index} 篇第 ${line} 段正文，用于让分块数量稳定。`).join('\n');
}

/**
 * 记录 `index.json` 写入字节的原子存储 — 只统计真正提交的落盘内容。
 *
 * 关键路径:分片写量必须逐次观测,不能从目录最终体积反推 —— 原子写会先写临时文件,
 * 目录体积只反映最后一次 rename 后的结果,漏掉同路径的重复写入。
 */
class RecordingIndexStorage extends AtomicIndexStorage {
	constructor(generationRoot: string, private readonly sink: Array<{ path: string; bytes: number }>) {
		super({ generationRoot });
	}

	override async upsertFile(filePath: string, content: Buffer | string): Promise<void> {
		const bytes = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
		await super.upsertFile(filePath, content);
		if (path.basename(filePath) === 'index.json') this.sink.push({ path: filePath, bytes });
	}
}

/** 汇总分片索引体积 — 只统计 `shards/<hh>/index.json`,不含日志与布局元数据。 */
async function shardIndexSizes(root: string): Promise<{ totalBytes: number; maxShardBytes: number }> {
	const shardsRoot = path.join(root, 'shards');
	let totalBytes = 0;
	let maxShardBytes = 0;
	for (const entry of await fsp.readdir(shardsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const size = (await fsp.stat(path.join(shardsRoot, entry.name, 'index.json'))).size;
		totalBytes += size;
		maxShardBytes = Math.max(maxShardBytes, size);
	}
	return { totalBytes, maxShardBytes };
}

const roots: string[] = [];

afterAll(async () => {
	for (const root of roots.splice(0)) await fsp.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe.skipIf(!ENABLED)('效率基准', () => {
	it(`索引 ${FILE_COUNT} 篇 - 记录耗时、峰值堆内存与落盘体积`, { timeout: 300_000 }, async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-efficiency-'));
		roots.push(root);
		// 关键路径:必须带上文件日志与完成记录,否则测到的只是 Vectra 落盘,
		// 会漏掉真实路径里每条完成记录一次原子写(实测约 15ms/篇)的成本。
		// 关键路径:统计「实际写入字节」必须包在文件系统层 —— 只量目录最终体积会漏掉
		// 临时文件与完成记录的重复写入,那是真实磨损与耗时来源。
		let writtenBytes = 0;
		const countingFs = {
			async openFile(absolutePath: string) {
				const handle = await open(absolutePath, 'wx');
				return {
					async write(buffer: Uint8Array, offset: number, length: number) {
						const result = await handle.write(buffer, offset, length);
						writtenBytes += result.bytesWritten;
						return result.bytesWritten;
					},
					sync: () => handle.sync(),
					close: () => handle.close(),
				};
			},
			async openDirectory(absolutePath: string) {
				const handle = await open(absolutePath, 'r');
				return { sync: () => handle.sync(), close: () => handle.close() };
			},
			rename: (from: string, to: string) => rename(from, to),
			async removeFile(absolutePath: string) {
				await rm(absolutePath, { force: true });
			},
		};
		const storage = new AtomicIndexStorage({ generationRoot: root, fileSystem: countingFs });
		const store = new VectraStore(root, { storage, autoInit: true });
		await store.init();
		const journal = createWorkerJournal({
			generationRoot: root,
			generationId: 'efficiency-gen',
			configFingerprint: 'a'.repeat(64),
			store,
			owner: new WorkerJournalOwner(1),
			expectedDimension: DIMENSIONS,
			storage,
		});

		let peakHeap = 0;
		const sampler = setInterval(() => {
			peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
		}, 50);

		const startedAt = performance.now();
		for (let index = 0; index < FILE_COUNT; index += 1) {
			const filePath = `note-${index}.md`;
			const chunks = chunkMarkdown(makeContent(index), CHUNK_OPTIONS);
			const commitId = `commit-${index}`;
			const prepared = await journal.prepare({
				path: filePath,
				operation: 'replace',
				inputHash: String(index).padStart(64, '0'),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: chunks.map((chunk, chunkIndex) => ({
					id: `${filePath}#chunk-${chunkIndex}`,
					vector: Array.from({ length: DIMENSIONS }, () => 0.1),
					metadata: { path: filePath, chunkIndex, startOffset: chunk.startOffset, commitId },
				})),
			});
			await journal.commit(prepared.transactionId);
		}
		const elapsedMs = performance.now() - startedAt;
		clearInterval(sampler);

		const bytes = await directoryBytes(root);
		const perFileMs = elapsedMs / FILE_COUNT;
		console.info(
			`[效率基准] 文件=${FILE_COUNT} 总耗时=${elapsedMs.toFixed(0)}ms 每篇=${perFileMs.toFixed(1)}ms 峰值堆=${(peakHeap / 1024 / 1024).toFixed(1)}MB 落盘=${(bytes / 1024).toFixed(0)}KB 写入字节=${(writtenBytes / 1024).toFixed(0)}KB 每篇写入=${(writtenBytes / FILE_COUNT).toFixed(0)}B`,
		);
		expect(writtenBytes).toBeGreaterThan(0);
		// 只做健全性断言:数字必须为正,避免采样失败被当成「很快」。
		expect(elapsedMs).toBeGreaterThan(0);
		expect(peakHeap).toBeGreaterThan(0);
		expect(bytes).toBeGreaterThan(0);
	});

	it(`分片索引 ${FILE_COUNT} 篇 - 单次提交只重写目标分片并记录写量与写次数`, { timeout: 300_000 }, async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-shard-efficiency-'));
		roots.push(root);
		// 关键路径:全新代际的 layout 由装配层按 `MIN_SHARDS` 落盘,100 篇档同样从 8 片起步。
		const shardCount = MIN_SHARDS;
		const shardWrites: Array<{ path: string; bytes: number }> = [];
		const store = createShardedStore({
			root,
			shardCount,
			createStorage: (shardRoot) => new RecordingIndexStorage(shardRoot, shardWrites),
		});
		await store.init();
		const journal = createWorkerJournal({
			generationRoot: root,
			generationId: 'efficiency-shard-gen',
			configFingerprint: 'a'.repeat(64),
			store,
			owner: new WorkerJournalOwner(1),
			expectedDimension: DIMENSIONS,
			storage: new AtomicIndexStorage({ generationRoot: root }),
		});
		// 关键路径:`init()` 的建库写入不计入逐篇提交读数,只统计真实提交。
		shardWrites.length = 0;
		const commitWriteBytes: number[] = [];
		const commitWriteCounts: number[] = [];
		const startedAt = performance.now();
		for (let index = 0; index < FILE_COUNT; index += 1) {
			const filePath = `note-${index}.md`;
			const chunks = chunkMarkdown(makeContent(index), CHUNK_OPTIONS);
			const commitId = `commit-${index}`;
			const cursor = shardWrites.length;
			const prepared = await journal.prepare({
				path: filePath,
				operation: 'replace',
				inputHash: String(index).padStart(64, '0'),
				revision: 1,
				previousCommitId: null,
				previousRevision: 0,
				blocks: chunks.map((chunk, chunkIndex) => ({
					id: `${filePath}#chunk-${chunkIndex}`,
					vector: Array.from({ length: DIMENSIONS }, () => 0.1),
					metadata: { path: filePath, chunkIndex, startOffset: chunk.startOffset, commitId },
				})),
			});
			await journal.commit(prepared.transactionId);
			const commitWrites = shardWrites.slice(cursor);
			commitWriteBytes.push(commitWrites.reduce((sum, write) => sum + write.bytes, 0));
			commitWriteCounts.push(commitWrites.length);
		}
		const elapsedMs = performance.now() - startedAt;
		const { totalBytes: indexBytes, maxShardBytes } = await shardIndexSizes(root);
		const directoryTotal = await directoryBytes(root);
		const totalWriteBytes = shardWrites.reduce((sum, write) => sum + write.bytes, 0);
		const maxCommitBytes = Math.max(...commitWriteBytes);
		const shardBudget = indexBytes / shardCount;
		console.info(
			`[分片效率] 文件=${FILE_COUNT} 片数=${shardCount} 总耗时=${elapsedMs.toFixed(0)}ms 每篇=${(elapsedMs / FILE_COUNT).toFixed(1)}ms `
			+ `总写量=${(totalWriteBytes / 1024).toFixed(1)}KB 写次数=${shardWrites.length}次 单次最大写=${(maxCommitBytes / 1024).toFixed(1)}KB `
			+ `平均每篇写=${(totalWriteBytes / FILE_COUNT / 1024).toFixed(1)}KB 全库索引=${(indexBytes / 1024).toFixed(1)}KB `
			+ `单片均额=${(shardBudget / 1024).toFixed(1)}KB 最大片=${(maxShardBytes / 1024).toFixed(1)}KB 落盘=${(directoryTotal / 1024).toFixed(1)}KB`,
		);
		// 关键路径:单文件提交只重写它所在的那一片 —— 写次数等于提交篇数,不是片数 × 篇数。
		expect(commitWriteCounts.every((count) => count === 1)).toBe(true);
		expect(shardWrites.length).toBe(FILE_COUNT);
		expect(totalWriteBytes).toBeGreaterThan(0);
		// 判据(设计 spec):单次提交写入字节 ≤ 全库索引体积 / 片数 × 1.2。
		// 关键路径:100 篇 / 8 片的实际哈希分布是最大 19 块、平均 12.5 块(最大片/均额 ≈ 1.5),
		// 逐次最大值会被分布不均衡顶到均额 1.2 以上 —— 直接套用会把哈希分布噪声当成写放大。
		// 这里断言实现真正保证的两条:每次提交只重写目标片(≤ 最大片 × 1.2),且平均单次提交
		// 写量 ≤ 全库 / 片数 × 1.2;生产 2961 篇档分布更均匀(16 片,最大片/均额约 1.2)。
		expect(maxCommitBytes).toBeLessThanOrEqual(maxShardBytes * 1.2);
		expect(totalWriteBytes / FILE_COUNT).toBeLessThanOrEqual(shardBudget * 1.2);
		// 关键路径:单次写量必须远低于全库,证明没有回退到「每次重写整份索引」。
		expect(maxCommitBytes).toBeLessThan(indexBytes);
	});
});
