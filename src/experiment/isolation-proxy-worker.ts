/**
 * @file src/experiment/isolation-proxy-worker.ts
 * @description 隔离代理测量 — 在 Node worker 线程内跑同一条索引提交链
 * @module src/experiment/isolation-proxy-worker
 *
 * 关键路径:
 * - 这里**不是**产品路径,只为在没有宿主驱动的情况下取得「同一份工作放进独立线程后
 *   主线程还卡不卡」的对照数字;宿主内读数仍必须在 Obsidian 里采。
 * - 与产品会话共用同一套存储、日志与分块实现,避免「量的不是同一件事」。
 */

import { parentPort, workerData } from 'node:worker_threads';
import { AtomicIndexStorage } from '../adapters/atomic-index-storage';
import { VectraStore } from '../adapters/vector-vectra';
import { createWorkerJournal, WorkerJournalOwner } from '../worker/index-runtime-journal';
import { chunkMarkdown } from '../worker/chunker';

const DIMENSIONS = 64;
const CHUNK_OPTIONS = { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length };

/** 与效率基准同规模的正文。 */
function makeContent(index: number): string {
	return Array.from({ length: 12 }, (_, line) => `第 ${index} 篇第 ${line} 段正文，用于让分块数量稳定。`).join('\n');
}

/** 执行索引提交。 */
export async function runIndexing(root: string, fileCount: number, generationId: string): Promise<number> {
	const storage = new AtomicIndexStorage({ generationRoot: root });
	const store = new VectraStore(root, { storage, autoInit: true });
	await store.init();
	const journal = createWorkerJournal({
		generationRoot: root,
		generationId,
		configFingerprint: 'a'.repeat(64),
		store,
		owner: new WorkerJournalOwner(1),
		expectedDimension: DIMENSIONS,
		storage,
	});
	for (let index = 0; index < fileCount; index += 1) {
		const filePath = `note-${index}.md`;
		const commitId = `commit-${index}`;
		const prepared = await journal.prepare({
			path: filePath,
			operation: 'replace',
			inputHash: String(index).padStart(64, '0'),
			revision: 1,
			previousCommitId: null,
			previousRevision: 0,
			blocks: chunkMarkdown(makeContent(index), CHUNK_OPTIONS).map((chunk, chunkIndex) => ({
				id: `${filePath}#chunk-${chunkIndex}`,
				vector: Array.from({ length: DIMENSIONS }, () => 0.1),
				metadata: { path: filePath, chunkIndex, startOffset: chunk.startOffset, commitId },
			})),
		});
		await journal.commit(prepared.transactionId);
	}
	return fileCount;
}

interface ProxyData {
	root: string;
	fileCount: number;
}

void (async () => {
	const data = workerData as ProxyData;
	try {
		await runIndexing(data.root, data.fileCount, 'proxy-worker');
		parentPort?.postMessage({ ok: true });
	} catch (error) {
		parentPort?.postMessage({ ok: false, error: String((error as Error)?.message ?? error) });
	}
})();
