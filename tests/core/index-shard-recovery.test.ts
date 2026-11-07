/**
 * @file tests/core/index-shard-recovery.test.ts
 * @description 分片布局下的崩溃恢复 — 块已落盘但未写完成记录、单片写入中断两种现场
 * @module tests/core/index-shard-recovery
 *
 * 关键路径:
 * - 用真实临时目录、真实 journal 与真实分片存储,只替换线程边界与嵌入模型;
 * - 断言落在「块集合、完成记录与嵌入调用次数」,而不是「调用过某个方法」;
 * - 「重启」= 丢弃写会话,按 `session.open` 重新装配(迁移 + 读 layout + 分片存储)。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIndexSessionHandlers } from '../../src/worker/index-runtime-session';
import { createWorkerJournal, WorkerJournalOwner } from '../../src/worker/index-runtime-journal';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { createShardedStore } from '../../src/adapters/vector-vectra-sharded';
import { ensureShardLayout, readShardLayout } from '../../src/core/index-shard-migration';
import { sha256 } from '../../src/utils/hash';
import type { RuntimeHandlerContext } from '../../src/worker/index-runtime-worker';

const CHUNK_OPTIONS = { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length };
const DIMENSIONS = 8;
const FINGERPRINT = 'a'.repeat(64);
const GENERATION_ID = 'gen-shard-recovery';

let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-shard-recovery-'));
});

afterEach(async () => {
	await fsp.rm(root, { recursive: true, force: true });
});

/** 可控嵌入通道 — 恢复必须零调用,这里只负责如实记录。 */
function makeEmbedContext(): { ctx: RuntimeHandlerContext; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		ctx: {
			async callHost(_method, payload) {
				const texts = (payload as { texts?: string[] }).texts ?? [];
				calls.push(texts);
				return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
			},
		},
	};
}

/**
 * 造一个分片布局的根并写入一篇种子笔记。
 *
 * 关键路径(2026-11-07):迁移能力已移除,这里直接按新布局建库,
 * 不再借「写旧单份索引再迁移」构造现场。
 */
async function seedMigratedRoot(): Promise<number> {
	const shardCount = 8;
	await ensureShardLayout(root, shardCount);
	const store = await openShardedStore(shardCount);
	await store.replaceFile({
		path: 'seed.md',
		commitId: 'seed-commit',
		blocks: [{
			id: 'seed.md#chunk-0',
			vector: Array.from({ length: DIMENSIONS }, () => 0.1),
			metadata: { path: 'seed.md', chunkIndex: 0, commitId: 'seed-commit' },
		}],
	});
	return shardCount;
}

/** 按 layout 片数装配一份独立分片存储,用于构造崩溃现场与事后核对。 */
async function openShardedStore(shardCount: number) {
	const store = createShardedStore({ root, shardCount });
	await store.init();
	return store;
}

/** 统计全部分片里属于某路径的块数 — 用于验证「同一路径只落一片」。 */
async function countShardItemsForPath(relativePath: string): Promise<number> {
	const shardsRoot = path.join(root, 'shards');
	const entries = await fsp.readdir(shardsRoot, { withFileTypes: true });
	let total = 0;
	for (const entry of entries.filter((item) => item.isDirectory())) {
		const file = path.join(shardsRoot, entry.name, 'index.json');
		const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { items?: Array<{ metadata?: Record<string, unknown> }> };
		total += (parsed.items ?? []).filter((item) => item.metadata?.['path'] === relativePath).length;
	}
	return total;
}

/** 重启后按会话装配方式打开(迁移一次 + 读 layout + 分片存储)。 */
async function reopenSession() {
	const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 2 });
	await handlers['session.open']!({ generationId: GENERATION_ID, configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
	return handlers;
}

/** 事后核对记录用的独立 journal — 只读,不参与恢复。 */
function createVerifier(shardCount: number) {
	const storePromise = openShardedStore(shardCount);
	return (async () => {
		const store = await storePromise;
		const storage = new AtomicIndexStorage({ generationRoot: root });
		const journal = createWorkerJournal({
			generationRoot: root,
			generationId: GENERATION_ID,
			configFingerprint: FINGERPRINT,
			store,
			owner: new WorkerJournalOwner(3),
			expectedDimension: DIMENSIONS,
			storage,
		});
		return { store, journal };
	})();
}

describe('分片布局崩溃恢复', () => {
	it('分片批量写后未写完成记录 - 重启补写记录且零嵌入', async () => {
		const shardCount = await seedMigratedRoot();
		const layout = await readShardLayout(root);
		expect(layout?.shardCount).toBe(shardCount);

		const content = '批量写入时崩溃的正文'.repeat(20);
		const inputHash = await sha256(content);
		// 进程 A:日志 prepare + 块落盘,但停在「完成记录」之前。
		const crashedStore = await openShardedStore(shardCount);
		const crashedJournal = createWorkerJournal({
			generationRoot: root,
			generationId: GENERATION_ID,
			configFingerprint: FINGERPRINT,
			store: crashedStore,
			owner: new WorkerJournalOwner(1),
			expectedDimension: DIMENSIONS,
			storage: new AtomicIndexStorage({ generationRoot: root }),
		});
		const prepared = await crashedJournal.prepare({
			path: 'batch.md',
			operation: 'replace',
			inputHash,
			revision: 1,
			previousCommitId: null,
			previousRevision: 0,
			blocks: [
				{
					id: 'batch.md#chunk-0',
					vector: Array.from({ length: DIMENSIONS }, () => 0.2),
					metadata: { path: 'batch.md', chunkIndex: 0, commitId: 'pending' },
				},
				{
					id: 'batch.md#chunk-1',
					vector: Array.from({ length: DIMENSIONS }, () => 0.3),
					metadata: { path: 'batch.md', chunkIndex: 1, commitId: 'pending' },
				},
			],
		});
		await crashedJournal.applyBlocks(prepared.transactionId);
		// 崩溃窗口:块已经在分片里,完成记录还没写。
		expect(await crashedStore.inspectFile('batch.md')).toHaveLength(2);
		expect(await crashedJournal.readReceipt('batch.md')).toBeNull();

		// 进程 B:丢弃会话后重新装配,按当前内容恢复。
		const restarted = await reopenSession();
		const embedding = makeEmbedContext();
		const report = await restarted['session.recover']!(
			{ inputs: [{ path: 'batch.md', hash: inputHash }] },
			embedding.ctx,
		) as { pending: number; decisions: number; failures: number };
		expect(report).toMatchObject({ pending: 1, decisions: 1, failures: 0 });
		// 关键路径:恢复只补完成记录,不再调用嵌入模型。
		expect(embedding.calls).toHaveLength(0);

		// 记录与块集合一致:chunkCount、commitId 与磁盘块逐项对齐。
		const verifier = await createVerifier(shardCount);
		expect(await verifier.journal.listPendingPaths()).toEqual([]);
		const receipt = await verifier.journal.readReceipt('batch.md');
		expect(receipt?.inputHash).toBe(inputHash);
		expect(receipt?.chunkCount).toBe(2);
		const blocks = await verifier.store.inspectFile('batch.md');
		expect(blocks.map((block) => block.id).sort()).toEqual(['batch.md#chunk-0', 'batch.md#chunk-1']);
		expect(new Set(blocks.map((block) => block.metadata['commitId']))).toEqual(new Set([receipt?.commitId]));
		await restarted['session.close']!({});
	});

	it('单片写入中断 - 重启后块集合与完成记录一致', async () => {
		const shardCount = await seedMigratedRoot();
		const content = '单片写入中断的正文'.repeat(10);
		const inputHash = await sha256(content);

		// 进程 A:只完成 prepare;块还没进分片就被杀掉。
		const crashedStore = await openShardedStore(shardCount);
		const crashedJournal = createWorkerJournal({
			generationRoot: root,
			generationId: GENERATION_ID,
			configFingerprint: FINGERPRINT,
			store: crashedStore,
			owner: new WorkerJournalOwner(1),
			expectedDimension: DIMENSIONS,
			storage: new AtomicIndexStorage({ generationRoot: root }),
		});
		const prepared = await crashedJournal.prepare({
			path: 'single.md',
			operation: 'replace',
			inputHash,
			revision: 1,
			previousCommitId: null,
			previousRevision: 0,
			blocks: [
				{
					id: 'single.md#chunk-0',
					vector: Array.from({ length: DIMENSIONS }, () => 0.4),
					metadata: { path: 'single.md', chunkIndex: 0, commitId: 'pending' },
				},
				{
					id: 'single.md#chunk-1',
					vector: Array.from({ length: DIMENSIONS }, () => 0.5),
					metadata: { path: 'single.md', chunkIndex: 1, commitId: 'pending' },
				},
			],
		});
		// 单片写入中断:分片里没有该路径的块,也没有完成记录。
		expect(await crashedStore.inspectFile('single.md')).toEqual([]);
		expect(await crashedJournal.readReceipt('single.md')).toBeNull();
		// 同一路径的所有块落在同一片:中断只影响这一片,重放也只写这一片。
		const shardId = crashedStore.shardIdOf('single.md');

		// 进程 B:重新装配后按日志分片重放。
		const restarted = await reopenSession();
		const embedding = makeEmbedContext();
		const report = await restarted['session.recover']!(
			{ inputs: [{ path: 'single.md', hash: inputHash }] },
			embedding.ctx,
		) as { pending: number; decisions: number; failures: number };
		expect(report).toMatchObject({ pending: 1, decisions: 1, failures: 0 });
		expect(embedding.calls).toHaveLength(0);

		// 块集合与完成记录一致,且只出现在该路径所属分片。
		const verifier = await createVerifier(shardCount);
		expect(await verifier.journal.listPendingPaths()).toEqual([]);
		const blocks = await verifier.store.inspectFile('single.md');
		const receipt = await verifier.journal.readReceipt('single.md');
		expect(receipt).not.toBeNull();
		expect(blocks).toHaveLength(2);
		expect(receipt?.chunkCount).toBe(blocks.length);
		expect(receipt?.commitId).toBe(blocks[0]?.metadata['commitId']);
		expect(await countShardItemsForPath('single.md')).toBe(2);
		expect(crashedStore.shardDirectoryOf(shardId)).toBe(verifier.store.shardDirectoryOf(verifier.store.shardIdOf('single.md')));
		await restarted['session.close']!({});
	});
});
