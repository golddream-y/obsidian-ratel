/**
 * @file tests/worker/index-runtime-session.test.ts
 * @description 索引会话 — 打开、单文件提交、旧块替换、推理失败保留与关闭语义
 * @module tests/worker/index-runtime-session
 *
 * 关键路径:用真实 Vectra 存储与真实临时目录,只把嵌入换成可控替身;
 * 断言落在「块数变化」而不是「调用过某个方法」,确保替换语义真的生效。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIndexSessionHandlers } from '../../src/worker/index-runtime-session';
import { createWorkerJournal, WorkerJournalOwner } from '../../src/worker/index-runtime-journal';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { sha256 } from '../../src/utils/hash';
import type { RuntimeHandlerContext } from '../../src/worker/index-runtime-worker';

const CHUNK_OPTIONS = { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length };
const DIMENSIONS = 8;

/** 超过单个块预算的长正文,保证切出多块。 */
const LONG_TEXT = Array.from({ length: 5 }, (_, index) => `段落${index}`.repeat(80)).join('\n');

/** 可控嵌入通道。 */
function makeContext(options: { fail?: boolean } = {}): { ctx: RuntimeHandlerContext; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		ctx: {
			async callHost(_method, payload) {
				const texts = (payload as { texts?: string[] }).texts ?? [];
				calls.push(texts);
				if (options.fail === true) throw new Error('模型未就绪');
				return texts.map(() => Array.from({ length: DIMENSIONS }, () => 0.1));
			},
		},
	};
}

let root = '';

beforeEach(async () => {
	root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-session-'));
});

afterEach(async () => {
	if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe('索引会话', () => {
	it('未打开 - 状态与写入都拒绝 - 不隐式建库', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await expect(handlers['session.status']!({})).rejects.toThrow('尚未打开');
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: 'x' }, makeContext().ctx)).rejects.toThrow('尚未打开');
	});

	it('打开后写入一篇 - 块落盘 - 状态可读', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const result = await handlers['session.upsertFile']!({ path: 'a.md', content: '第一段\n第二段' }, makeContext().ctx) as { chunkCount: number };
		expect(result.chunkCount).toBeGreaterThan(0);
		const status = await handlers['session.status']!({}) as { totalDocs: number; written: number };
		expect(status.totalDocs).toBe(result.chunkCount);
		expect(status.written).toBe(1);
	});

	it('同路径内容变短 - 旧块被替换 - 不残留幽灵块', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const ctx = makeContext().ctx;
		const first = await handlers['session.upsertFile']!({ path: 'a.md', content: LONG_TEXT }, ctx) as { chunkCount: number };
		const second = await handlers['session.upsertFile']!({ path: 'a.md', content: '一' }, ctx) as { chunkCount: number };
		expect(first.chunkCount).toBeGreaterThan(1);
		expect(second.chunkCount).toBeLessThan(first.chunkCount);
		const status = await handlers['session.status']!({}) as { totalDocs: number };
		expect(status.totalDocs).toBe(second.chunkCount);
	});

	it('嵌入失败 - 旧版本完整保留 - 错误如实抛出', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await handlers['session.upsertFile']!({ path: 'a.md', content: LONG_TEXT }, makeContext().ctx);
		const before = (await handlers['session.status']!({}) as { totalDocs: number }).totalDocs;
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: LONG_TEXT }, makeContext({ fail: true }).ctx))
			.rejects.toThrow('模型未就绪');
		const after = (await handlers['session.status']!({}) as { totalDocs: number }).totalDocs;
		expect(after).toBe(before);
	});

	it('删除文件 - 块清零 - 其他文件不受影响', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const ctx = makeContext().ctx;
		await handlers['session.upsertFile']!({ path: 'a.md', content: '一' }, ctx);
		const b = await handlers['session.upsertFile']!({ path: 'b.md', content: '二\n三' }, ctx) as { chunkCount: number };
		await handlers['session.deleteFile']!({ path: 'a.md' });
		const status = await handlers['session.status']!({}) as { totalDocs: number };
		expect(status.totalDocs).toBe(b.chunkCount);
	});

	it('关闭后写入 - 明确拒绝 - 不写半份内容', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await handlers['session.close']!({});
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: 'x' }, makeContext().ctx)).rejects.toThrow('尚未打开');
	});

	it('嵌入条数与块数不一致 - 拒绝提交 - 不留半份', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const bad: RuntimeHandlerContext = { callHost: async () => [[0.1]] };
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: LONG_TEXT }, bad)).rejects.toThrow('不一致');
		const status = await handlers['session.status']!({}) as { totalDocs: number };
		expect(status.totalDocs).toBe(0);
	});
});

describe('会话内查询', () => {
	it('写入后可查 - 命中路径来自已提交块', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const ctx = makeContext().ctx;
		await handlers['session.upsertFile']!({ path: 'a.md', content: '关于索引的正文' }, ctx);
		const result = await handlers['session.search']!({ query: '索引', topK: 5 }, ctx) as { hits: Array<{ path: string }> };
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.hits.map((hit) => hit.path)).toContain('a.md');
	});

	it('topK 非法 - 明确拒绝 - 不返回半份结果', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await expect(handlers['session.search']!({ query: 'x', topK: 0 }, makeContext().ctx)).rejects.toThrow('topK');
		await expect(handlers['session.search']!({ query: 'x', topK: 101 }, makeContext().ctx)).rejects.toThrow('topK');
	});

	it('空库查询 - 返回空命中 - 不抛错', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const result = await handlers['session.search']!({ query: '任意' }, makeContext().ctx) as { hits: unknown[] };
		expect(result.hits).toEqual([]);
	});
});

describe('会话内日志提交', () => {
	const FINGERPRINT = 'c'.repeat(64);

	it('带日志授权打开 - 写入产生完成记录 - 提交后可读回', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1 });
		const opened = await handlers['session.open']!({ generationId: 'gen-a', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS }) as { journal: boolean };
		expect(opened.journal).toBe(true);
		const written = await handlers['session.upsertFile']!({ path: 'a.md', content: '一段正文' }, makeContext().ctx) as { chunkCount: number };
		expect(written.chunkCount).toBeGreaterThan(0);
		// 再次写入同一路径:revision 递增,旧块被替换。
		const second = await handlers['session.upsertFile']!({ path: 'a.md', content: '另一段正文' }, makeContext().ctx) as { chunkCount: number };
		expect(second.chunkCount).toBeGreaterThan(0);
		const status = await handlers['session.status']!({}) as { totalDocs: number; written: number };
		expect(status.written).toBe(2);
	});

	it('关闭会话 - 写权撤销 - 后续写入失败', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1 });
		await handlers['session.open']!({ generationId: 'gen-a', configFingerprint: FINGERPRINT });
		const closed = await handlers['session.close']!({}) as { closed: boolean; inflight: number };
		expect(closed).toEqual({ closed: true, inflight: 0 });
		await expect(handlers['session.upsertFile']!({ path: 'a.md', content: 'x' }, makeContext().ctx)).rejects.toThrow('尚未打开');
	});

	it('不带日志授权 - 退回纯存储写入 - 不产生完成记录依赖', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		const opened = await handlers['session.open']!({}) as { journal: boolean };
		expect(opened.journal).toBe(false);
		const written = await handlers['session.upsertFile']!({ path: 'b.md', content: '正文' }, makeContext().ctx) as { chunkCount: number };
		expect(written.chunkCount).toBeGreaterThan(0);
	});
});

describe('会话内清单读写', () => {
	const MANIFEST = {
		schemaVersion: 1,
		entries: { 'a.md': { path: 'a.md', hash: 'd'.repeat(64), mtime: 0, chunkCount: 2 } },
	};

	it('保存后可读回 - 数据一致', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await handlers['session.manifest.save']!({ manifest: MANIFEST });
		const loaded = await handlers['session.manifest.load']!({}) as { manifest: { entries: Record<string, { chunkCount: number }> } | null };
		expect(loaded.manifest?.entries['a.md']?.chunkCount).toBe(2);
	});

	it('清单缺失 - 读回 null - 不抛错', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		const loaded = await handlers['session.manifest.load']!({}) as { manifest: unknown };
		expect(loaded.manifest).toBeNull();
	});

	it('载荷不是对象 - 拒绝保存 - 不覆盖已有清单', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await handlers['session.manifest.save']!({ manifest: MANIFEST });
		await expect(handlers['session.manifest.save']!({ manifest: [1, 2, 3] })).rejects.toThrow('清单载荷不合法');
		const loaded = await handlers['session.manifest.load']!({}) as { manifest: { entries: Record<string, unknown> } | null };
		expect(Object.keys(loaded.manifest?.entries ?? {})).toEqual(['a.md']);
	});

	it('未打开 - 读写清单都拒绝', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await expect(handlers['session.manifest.load']!({})).rejects.toThrow('尚未打开');
		await expect(handlers['session.manifest.save']!({ manifest: MANIFEST })).rejects.toThrow('尚未打开');
	});
});

describe('会话内崩溃恢复', () => {
	const FINGERPRINT = 'e'.repeat(64);

	it('无未决事务 - 恢复为空操作 - 不触碰存储', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1 });
		await handlers['session.open']!({ generationId: 'gen-r', configFingerprint: FINGERPRINT });
		const report = await handlers['session.recover']!({ inputs: [] }) as { pending: number; decisions: number };
		expect(report).toEqual({ pending: 0, decisions: 0, failures: 0, cleanupPending: 0 });
	});

	it('未启用日志 - 恢复被拒绝 - 不假装成功', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await expect(handlers['session.recover']!({ inputs: [] })).rejects.toThrow('未启用日志');
	});

	it('恢复输入不合法 - 明确拒绝', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1 });
		await handlers['session.open']!({ generationId: 'gen-r', configFingerprint: FINGERPRINT });
		await expect(handlers['session.recover']!({ inputs: [{ path: '' }] })).rejects.toThrow('path');
		await expect(handlers['session.recover']!({ inputs: [{ path: 'a.md', hash: 5 }] })).rejects.toThrow('hash');
		await expect(handlers['session.recover']!({})).rejects.toThrow('恢复输入不合法');
	});
});

describe('崩溃现场恢复（未提交事务）', () => {
	const FINGERPRINT = 'f'.repeat(64);

	it('遗留未决事务 - 输入未变则重放并产出完成记录', async () => {
		const storage = new AtomicIndexStorage({ generationRoot: root });
		const sharedStore = new VectraStore(root, { storage });
		await sharedStore.init();
		const content = '崩溃前的正文';
		const inputHash = await sha256(content);

		// 模拟上一次进程:prepare 之后没来得及 commit。
		const crashOwner = new WorkerJournalOwner(1);
		const crashJournal = createWorkerJournal({
			generationRoot: root, generationId: 'gen-c', configFingerprint: FINGERPRINT,
			store: sharedStore, owner: crashOwner, expectedDimension: DIMENSIONS, storage,
		});
		await crashJournal.prepare({
			path: 'crashed.md', operation: 'replace', inputHash, revision: 1,
			previousCommitId: null, previousRevision: 0,
			blocks: [{ id: 'crashed.md#chunk-0', vector: Array.from({ length: DIMENSIONS }, () => 0.1), metadata: { path: 'crashed.md', chunkIndex: 0, commitId: 'c1' } }],
		});
		expect(await crashJournal.listPendingPaths()).toHaveLength(1);

		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1, createStore: () => sharedStore });
		await handlers['session.open']!({ generationId: 'gen-c', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		const report = await handlers['session.recover']!({ inputs: [{ path: 'crashed.md', hash: inputHash }] }) as { pending: number; decisions: number; failures: number };
		expect(report.pending).toBe(1);
		expect(report.decisions).toBe(1);
		expect(report.failures).toBe(0);

		const verifier = createWorkerJournal({
			generationRoot: root, generationId: 'gen-c', configFingerprint: FINGERPRINT,
			store: sharedStore, owner: new WorkerJournalOwner(2), expectedDimension: DIMENSIONS, storage,
		});
		expect(await verifier.listPendingPaths()).toEqual([]);
		const receipt = await verifier.readReceipt('crashed.md');
		expect(receipt?.path).toBe('crashed.md');
		expect(receipt?.inputHash).toBe(inputHash);
	});

	it('遗留事务内容已变 - 不重放 - 旧版本不被覆盖', async () => {
		const storage = new AtomicIndexStorage({ generationRoot: root });
		const sharedStore = new VectraStore(root, { storage });
		await sharedStore.init();
		const staleHash = await sha256('旧正文');
		const crashJournal = createWorkerJournal({
			generationRoot: root, generationId: 'gen-d', configFingerprint: FINGERPRINT,
			store: sharedStore, owner: new WorkerJournalOwner(1), expectedDimension: DIMENSIONS, storage,
		});
		await crashJournal.prepare({
			path: 'stale.md', operation: 'replace', inputHash: staleHash, revision: 1,
			previousCommitId: null, previousRevision: 0,
			blocks: [{ id: 'stale.md#chunk-0', vector: Array.from({ length: DIMENSIONS }, () => 0.2), metadata: { path: 'stale.md', chunkIndex: 0, commitId: 'c1' } }],
		});

		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1, createStore: () => sharedStore });
		await handlers['session.open']!({ generationId: 'gen-d', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		// 当前内容已不同:hash 不匹配,不得重放。
		await handlers['session.recover']!({ inputs: [{ path: 'stale.md', hash: await sha256('新正文') }] });

		const verifier = createWorkerJournal({
			generationRoot: root, generationId: 'gen-d', configFingerprint: FINGERPRINT,
			store: sharedStore, owner: new WorkerJournalOwner(2), expectedDimension: DIMENSIONS, storage,
		});
		expect(await verifier.readReceipt('stale.md')).toBeNull();
		expect(await verifier.listPendingPaths()).toEqual([]);
	});
});

describe('按向量查询', () => {
	it('写入后按向量查 - 命中带路径与块号', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await handlers['session.upsertFile']!({ path: 'a.md', content: '一段正文' }, makeContext().ctx);
		const result = await handlers['session.searchVector']!({ vector: Array.from({ length: DIMENSIONS }, () => 0.1), topK: 5 }) as {
			hits: Array<{ docId: string; path: string; chunkIndex: number | null }>;
		};
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.hits[0]).toMatchObject({ docId: 'a.md', path: 'a.md' });
	});

	it('向量或 topK 不合法 - 明确拒绝', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await expect(handlers['session.searchVector']!({ vector: [], topK: 5 })).rejects.toThrow('查询向量不合法');
		await expect(handlers['session.searchVector']!({ vector: [0.1], topK: 0 })).rejects.toThrow('topK');
		await expect(handlers['session.searchVector']!({ vector: [0.1], topK: 501 })).rejects.toThrow('topK');
	});
});

describe('可信完成记录列表', () => {
	const FINGERPRINT = 'd'.repeat(64);

	it('写入后 - 列表包含该路径 - 状态为 present', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1 });
		await handlers['session.open']!({ generationId: 'gen-l', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		await handlers['session.upsertFile']!({ path: 'a.md', content: '正文' }, makeContext().ctx);
		const listed = await handlers['session.listCommitted']!({}) as { records: Array<{ path: string; state: string }> };
		expect(listed.records.map((record) => record.path)).toContain('a.md');
		expect(listed.records[0]?.state).toBe('present');
	});

	it('未启用日志 - 明确拒绝 - 不返回空集冒充无记录', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS });
		await handlers['session.open']!({});
		await expect(handlers['session.listCommitted']!({})).rejects.toThrow('未启用日志');
	});
});

describe('未变内容不重复嵌入', () => {
	const FINGERPRINT = 'e'.repeat(64);

	it('同一内容写两次 - 第二次跳过 - 嵌入只调用一次', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1 });
		await handlers['session.open']!({ generationId: 'gen-skip', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		const context = makeContext();
		const first = await handlers['session.upsertFile']!({ path: 'a.md', content: '同样的正文' }, context.ctx) as { chunkCount: number; skipped?: boolean };
		const second = await handlers['session.upsertFile']!({ path: 'a.md', content: '同样的正文' }, context.ctx) as { chunkCount: number; skipped?: boolean };
		expect(first.skipped).toBeUndefined();
		expect(second).toMatchObject({ skipped: true, chunkCount: first.chunkCount });
		// 嵌入调用次数 = 上下文里的调用记录条数。
		expect(context.calls).toHaveLength(1);
	});

	it('内容变化 - 重新嵌入 - 不跳过', async () => {
		const handlers = createIndexSessionHandlers({ root, chunkOptions: CHUNK_OPTIONS, epoch: 1 });
		await handlers['session.open']!({ generationId: 'gen-skip2', configFingerprint: FINGERPRINT, expectedDimension: DIMENSIONS });
		const context = makeContext();
		await handlers['session.upsertFile']!({ path: 'a.md', content: '第一版' }, context.ctx);
		const second = await handlers['session.upsertFile']!({ path: 'a.md', content: '第二版内容' }, context.ctx) as { skipped?: boolean };
		expect(second.skipped).toBeUndefined();
		expect(context.calls).toHaveLength(2);
	});
});
