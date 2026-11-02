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
		const storage = new AtomicIndexStorage({ generationRoot: root });
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
			`[效率基准] 文件=${FILE_COUNT} 总耗时=${elapsedMs.toFixed(0)}ms 每篇=${perFileMs.toFixed(1)}ms 峰值堆=${(peakHeap / 1024 / 1024).toFixed(1)}MB 落盘=${(bytes / 1024).toFixed(0)}KB`,
		);
		// 只做健全性断言:数字必须为正,避免采样失败被当成「很快」。
		expect(elapsedMs).toBeGreaterThan(0);
		expect(peakHeap).toBeGreaterThan(0);
		expect(bytes).toBeGreaterThan(0);
	});
});
