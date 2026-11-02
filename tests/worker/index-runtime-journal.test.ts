/**
 * @file tests/worker/index-runtime-journal.test.ts
 * @description 索引线程内日志 — 写权撤销、提交登记与完成记录真实落盘
 * @module tests/worker/index-runtime-journal
 *
 * 关键路径:用真实临时目录与真实 Vectra 存储走 prepare/commit,断言读回完成记录;
 * 撤销后写入口必须立即失败,而不是靠调用方自觉不写。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { createWorkerJournal, WorkerJournalOwner, WorkerOwnerError } from '../../src/worker/index-runtime-journal';

const DIMENSIONS = 8;
const GENERATION_ID = 'gen-worker';
const FINGERPRINT = 'a'.repeat(64);

let root = '';
let storage: AtomicIndexStorage;
let store: VectraStore;

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-worker-journal-'));
	storage = new AtomicIndexStorage({ generationRoot: root });
	store = new VectraStore(root, { storage });
	await store.init();
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true });
});

/** 建一条完整的替换请求。 */
function replaceInput(filePath: string, commitId: string) {
	return {
		path: filePath,
		operation: 'replace' as const,
		inputHash: 'b'.repeat(64),
		revision: 1,
		previousCommitId: null,
		previousRevision: 0,
		blocks: [{
			id: `${filePath}#chunk-0`,
			vector: Array.from({ length: DIMENSIONS }, () => 0.1),
			metadata: { path: filePath, chunkIndex: 0, commitId },
		}],
	};
}

describe('索引线程内文件日志', () => {
	it('写权正常 - prepare/commit 成功 - 完成记录可读回', async () => {
		const owner = new WorkerJournalOwner(1);
		const journal = createWorkerJournal({
			generationRoot: root, generationId: GENERATION_ID, configFingerprint: FINGERPRINT,
			store, owner, expectedDimension: DIMENSIONS, storage,
		});
		const prepared = await journal.prepare(replaceInput('a.md', 'commit-1'));
		const committed = await journal.commit(prepared.transactionId);
		expect(committed.commit.chunkCount).toBe(1);
		const receipt = await journal.readReceipt('a.md');
		expect(receipt?.path).toBe('a.md');
		expect(receipt?.chunkCount).toBe(1);
		expect(owner.inflightCommits).toBe(0);
		expect(await journal.listPendingPaths()).toEqual([]);
	});

	it('撤销写权 - 新写入立即失败 - 错误码可识别', async () => {
		const owner = new WorkerJournalOwner(1);
		const journal = createWorkerJournal({
			generationRoot: root, generationId: GENERATION_ID, configFingerprint: FINGERPRINT,
			store, owner, expectedDimension: DIMENSIONS, storage,
		});
		owner.revoke('用户暂停');
		await expect(journal.prepare(replaceInput('b.md', 'commit-2'))).rejects.toBeInstanceOf(WorkerOwnerError);
		expect(() => owner.assertWritable()).toThrow(WorkerOwnerError);
	});

	it('提交登记 - 嵌套结算只减一次 - 撤销后拒绝新登记', () => {
		const owner = new WorkerJournalOwner(3);
		const first = owner.beginCommit();
		const second = owner.beginCommit();
		expect(owner.inflightCommits).toBe(2);
		first.settle();
		first.settle();
		expect(owner.inflightCommits).toBe(1);
		second.settle();
		expect(owner.inflightCommits).toBe(0);
		owner.revoke('交接');
		expect(() => owner.beginCommit()).toThrow(WorkerOwnerError);
	});
});
