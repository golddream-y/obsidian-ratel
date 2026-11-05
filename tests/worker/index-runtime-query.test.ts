/**
 * @file tests/worker/index-runtime-query.test.ts
 * @description 独立索引会话的查询/提交调度 — 推理并行、提交互斥与排队查询优先
 * @module tests/worker/index-runtime-query
 *
 * 关键路径:使用真实会话处理器与可控存储接缝,让嵌入和提交的完成顺序可重复;
 * 断言落在 `store.search`/`store.replaceFile` 的实际进入顺序,而不是仅检查调用次数。
 */

import { describe, expect, it, vi } from 'vitest';
import { createIndexSessionHandlers } from '../../src/worker/index-runtime-session';
import type { RuntimeHandlerContext, RuntimeHandlers } from '../../src/worker/index-runtime-worker';
import type { VectraStore } from '../../src/adapters/vector-vectra';

const CHUNK_OPTIONS = { maxTokens: 500, overlapTokens: 100, count: (text: string) => text.length };

/** 可控异步步骤。 */
interface Deferred {
	promise: Promise<void>;
	release: () => void;
}

function deferred(): Deferred {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

/** 让已就绪的嵌入及后续异步任务到达存储调度点;只让出事件循环,不依赖固定等待时长。 */
async function drainAsyncTasks(): Promise<void> {
	await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/** 生成按文本条数返回向量的可控宿主嵌入通道。 */
function embeddingContext(name: string, events: string[], gate?: Deferred): RuntimeHandlerContext {
	return {
		async callHost(_method, payload) {
			const request = payload as { texts: string[] };
			events.push(`${name}:embed:start`);
			if (gate !== undefined) await gate.promise;
			events.push(`${name}:embed:end`);
			return request.texts.map(() => [0.25, 0.75]);
		},
	};
}

/** 构造只替换存储接缝的真实会话;不启用日志,避免测试依赖真实磁盘时序。 */
async function openSession(store: VectraStore): Promise<RuntimeHandlers> {
	const handlers = createIndexSessionHandlers({
		root: process.cwd(),
		chunkOptions: CHUNK_OPTIONS,
		createStore: () => store,
	});
	await handlers['session.open']!({});
	return handlers;
}

/** 等待全部清理完成并暴露任何被拒绝的操作,避免清理路径吞掉真实回归。 */
async function expectAllFulfilled(promises: readonly unknown[]): Promise<void> {
	const results = await Promise.allSettled(promises.map((promise) => Promise.resolve(promise)));
	expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
}

/** 存储替身只实现本会话路径实际调用的方法。 */
function makeStore(overrides: {
	replaceFile?: VectraStore['replaceFile'];
	search?: VectraStore['search'];
	beginWriteBatch?: VectraStore['beginWriteBatch'];
	endWriteBatch?: VectraStore['endWriteBatch'];
}): VectraStore {
	return {
		init: async () => undefined,
		replaceFile: overrides.replaceFile ?? (async () => undefined),
		search: overrides.search ?? (async () => []),
		beginWriteBatch: overrides.beginWriteBatch ?? (async () => undefined),
		endWriteBatch: overrides.endWriteBatch ?? (async () => undefined),
	} as unknown as VectraStore;
}

/**
 * 折叠分片扇出 — 同一逻辑操作会按片重复记录,连续同值折叠后即逻辑事件序列。
 *
 * 关键路径:会话现在总是装配分片存储;查询向每片各发一次,提交只落到目标片。
 * 用例关心的是会话访问门的**顺序**(提交先于查询、排队查询优先),不是片内次数。
 *
 * @param events - 原始存储事件。
 * @returns 去掉连续重复后的逻辑事件序列。
 */
function collapseShardFanout(events: readonly string[]): string[] {
	const result: string[] = [];
	for (const event of events) {
		if (result.at(-1) !== event) result.push(event);
	}
	return result;
}

describe('独立索引会话查询调度', () => {
	it('查询嵌入与读取 - 索引仍在准备推理 - 不等待索引提交即可返回', async () => {
		const indexEmbedding = deferred();
		const embeddingEvents: string[] = [];
		const storageEvents: string[] = [];
		const store = makeStore({
			search: async () => {
				storageEvents.push('search');
				return [];
			},
		});
		const handlers = await openSession(store);
		const indexing = handlers['session.upsertFile']!(
			{ path: 'a.md', content: '索引正文' },
			embeddingContext('index', embeddingEvents, indexEmbedding),
		);
		await vi.waitFor(() => expect(embeddingEvents).toContain('index:embed:start'));

		const querying = handlers['session.search']!(
			{ query: '查询', topK: 5 },
			embeddingContext('query', embeddingEvents),
		);
		try {
			await expect(querying).resolves.toEqual({ hits: [] });
			expect(embeddingEvents).toContain('query:embed:end');
			expect(collapseShardFanout(storageEvents)).toEqual(['search']);
		} finally {
			indexEmbedding.release();
			await indexing;
		}
	});

	it('存储查询 - 原子提交尚未结束 - 提交完成后才进入', async () => {
		const commit = deferred();
		const embeddingEvents: string[] = [];
		const storageEvents: string[] = [];
		const store = makeStore({
			replaceFile: async () => {
				storageEvents.push('commit:start');
				await commit.promise;
				storageEvents.push('commit:end');
			},
			search: async () => {
				storageEvents.push('search');
				return [];
			},
		});
		const handlers = await openSession(store);
		const indexing = handlers['session.upsertFile']!(
			{ path: 'a.md', content: '索引正文' },
			embeddingContext('index', embeddingEvents),
		);
		await vi.waitFor(() => expect(storageEvents).toContain('commit:start'));
		const querying = handlers['session.search']!(
			{ query: '查询', topK: 5 },
			embeddingContext('query', embeddingEvents),
		);
		try {
			await vi.waitFor(() => expect(embeddingEvents).toContain('query:embed:end'));
			await drainAsyncTasks();
		} finally {
			commit.release();
			await expectAllFulfilled([indexing, querying]);
		}
		expect(collapseShardFanout(storageEvents)).toEqual(['commit:start', 'commit:end', 'search']);
	});

	it('后续索引提交 - 当前提交结束时已有排队查询 - 查询先完成再进入后续提交', async () => {
		const firstCommit = deferred();
		const queryRead = deferred();
		const embeddingEvents: string[] = [];
		const storageEvents: string[] = [];
		const store = makeStore({
			replaceFile: async (input) => {
				storageEvents.push(`commit:${input.path}:start`);
				if (input.path === 'a.md') await firstCommit.promise;
				storageEvents.push(`commit:${input.path}:end`);
			},
			search: async () => {
				storageEvents.push('search:start');
				await queryRead.promise;
				storageEvents.push('search:end');
				return [];
			},
		});
		const handlers = await openSession(store);
		const firstIndexing = handlers['session.upsertFile']!(
			{ path: 'a.md', content: '第一篇正文' },
			embeddingContext('index-a', embeddingEvents),
		);
		await vi.waitFor(() => expect(storageEvents).toContain('commit:a.md:start'));
		const querying = handlers['session.search']!(
			{ query: '查询', topK: 5 },
			embeddingContext('query', embeddingEvents),
		);
		await vi.waitFor(() => expect(embeddingEvents).toContain('query:embed:end'));
		await drainAsyncTasks();
		const secondIndexing = handlers['session.upsertFile']!(
			{ path: 'b.md', content: '第二篇正文' },
			embeddingContext('index-b', embeddingEvents),
		);
		try {
			await vi.waitFor(() => expect(embeddingEvents).toContain('index-b:embed:end'));
			await drainAsyncTasks();
			firstCommit.release();
			await vi.waitFor(() => expect(storageEvents).toContain('search:start'));
			await drainAsyncTasks();
		} finally {
			firstCommit.release();
			queryRead.release();
			await expectAllFulfilled([firstIndexing, querying, secondIndexing]);
		}
		expect(collapseShardFanout(storageEvents)).toEqual([
			'commit:a.md:start',
			'commit:a.md:end',
			'search:start',
			'search:end',
			'commit:b.md:start',
			'commit:b.md:end',
		]);
	});

	it('批量写入与向量查询 - 收尾时查询及后续提交排队 - 先收尾再查询最后提交', async () => {
		const fileCommit = deferred();
		const batchCommit = deferred();
		const queryRead = deferred();
		const embeddingEvents: string[] = [];
		const storageEvents: string[] = [];
		const store = makeStore({
			beginWriteBatch: async () => {
				storageEvents.push('batch:begin');
			},
			replaceFile: async (input) => {
				storageEvents.push(`commit:${input.path}:start`);
				if (input.path === 'a.md') await fileCommit.promise;
				storageEvents.push(`commit:${input.path}:end`);
			},
			endWriteBatch: async () => {
				storageEvents.push('batch:end:start');
				await batchCommit.promise;
				storageEvents.push('batch:end:end');
			},
			search: async () => {
				storageEvents.push('search:start');
				await queryRead.promise;
				storageEvents.push('search:end');
				return [];
			},
		});
		const handlers = await openSession(store);
		const batching = handlers['session.upsertFiles']!(
			{ files: [{ path: 'a.md', content: '批内正文' }] },
			embeddingContext('batch', embeddingEvents),
		);
		await vi.waitFor(() => expect(storageEvents).toContain('commit:a.md:start'));
		const querying = handlers['session.searchVector']!({ vector: [0.25, 0.75], topK: 5 });
		await drainAsyncTasks();
		const nextIndexing = handlers['session.upsertFile']!(
			{ path: 'b.md', content: '下一篇正文' },
			embeddingContext('next', embeddingEvents),
		);
		try {
			await vi.waitFor(() => expect(embeddingEvents).toContain('next:embed:end'));
			await drainAsyncTasks();
			fileCommit.release();
			await vi.waitFor(() => expect(storageEvents).toContain('batch:end:start'));
			await drainAsyncTasks();
			batchCommit.release();
			await vi.waitFor(() => expect(storageEvents).toContain('search:start'));
			await drainAsyncTasks();
		} finally {
			fileCommit.release();
			batchCommit.release();
			queryRead.release();
			await expectAllFulfilled([batching, querying, nextIndexing]);
		}
		expect(collapseShardFanout(storageEvents)).toEqual([
			'batch:begin',
			'commit:a.md:start',
			'commit:a.md:end',
			'batch:end:start',
			'batch:end:end',
			'search:start',
			'search:end',
			'commit:b.md:start',
			'commit:b.md:end',
		]);
	});

	it('提交失败 - 查询与后续提交均已排队 - 两者释放且查询保持优先', async () => {
		const failedCommit = deferred();
		const queryRead = deferred();
		const embeddingEvents: string[] = [];
		const storageEvents: string[] = [];
		const store = makeStore({
			replaceFile: async (input) => {
				storageEvents.push(`commit:${input.path}:start`);
				if (input.path === 'a.md') {
					await failedCommit.promise;
					storageEvents.push('commit:a.md:end');
					throw new Error('提交失败');
				}
				storageEvents.push(`commit:${input.path}:end`);
			},
			search: async () => {
				storageEvents.push('search:start');
				await queryRead.promise;
				storageEvents.push('search:end');
				return [];
			},
		});
		const handlers = await openSession(store);
		const failedIndexing = handlers['session.upsertFile']!(
			{ path: 'a.md', content: '失败正文' },
			embeddingContext('failed', embeddingEvents),
		);
		const failureAssertion = expect(failedIndexing).rejects.toThrow('提交失败');
		await vi.waitFor(() => expect(storageEvents).toContain('commit:a.md:start'));
		const querying = handlers['session.searchVector']!({ vector: [0.25, 0.75], topK: 5 });
		await drainAsyncTasks();
		const nextIndexing = handlers['session.upsertFile']!(
			{ path: 'b.md', content: '后续正文' },
			embeddingContext('next', embeddingEvents),
		);
		try {
			await vi.waitFor(() => expect(embeddingEvents).toContain('next:embed:end'));
			await drainAsyncTasks();
			failedCommit.release();
			await vi.waitFor(() => expect(storageEvents).toContain('search:start'));
			await drainAsyncTasks();
			queryRead.release();
			await failureAssertion;
			await querying;
			await nextIndexing;
		} finally {
			failedCommit.release();
			queryRead.release();
			const results = await Promise.allSettled([failedIndexing, querying, nextIndexing]);
			expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
		}
		expect(collapseShardFanout(storageEvents)).toEqual([
			'commit:a.md:start',
			'commit:a.md:end',
			'search:start',
			'search:end',
			'commit:b.md:start',
			'commit:b.md:end',
		]);
	});

	it('批量嵌入 - 宿主尚未返回向量 - 查询可先于批量存储提交完成', async () => {
		const batchEmbedding = deferred();
		const embeddingEvents: string[] = [];
		const storageEvents: string[] = [];
		const store = makeStore({
			beginWriteBatch: async () => {
				storageEvents.push('batch:begin');
			},
			replaceFile: async (input) => {
				storageEvents.push(`commit:${input.path}`);
			},
			endWriteBatch: async () => {
				storageEvents.push('batch:end');
			},
			search: async () => {
				storageEvents.push('search');
				return [];
			},
		});
		const handlers = await openSession(store);
		const batching = handlers['session.upsertFiles']!(
			{ files: [{ path: 'a.md', content: '第一篇正文' }, { path: 'b.md', content: '第二篇正文' }] },
			embeddingContext('batch', embeddingEvents, batchEmbedding),
		);
		await vi.waitFor(() => expect(embeddingEvents).toContain('batch:embed:start'));
		const querying = handlers['session.searchVector']!({ vector: [0.25, 0.75], topK: 5 });
		let queryFulfilled = false;
		void Promise.resolve(querying).then(() => { queryFulfilled = true; }, () => undefined);
		let queryFulfilledBeforeEmbedRelease = false;
		let storageEventsBeforeEmbedRelease: string[] = [];
		try {
			await drainAsyncTasks();
			queryFulfilledBeforeEmbedRelease = queryFulfilled;
			storageEventsBeforeEmbedRelease = [...storageEvents];
		} finally {
			batchEmbedding.release();
			await expectAllFulfilled([batching, querying]);
		}
		expect(queryFulfilledBeforeEmbedRelease).toBe(true);
		expect(collapseShardFanout(storageEventsBeforeEmbedRelease)).toEqual(['search']);
		expect(embeddingEvents.filter((event) => event === 'batch:embed:end')).toHaveLength(2);
		// 两篇落在不同片:批内首次写每片时各自补开批,因此按片出现两次 batch:begin。
		expect(collapseShardFanout(storageEvents)).toEqual(['search', 'batch:begin', 'commit:a.md', 'batch:begin', 'commit:b.md', 'batch:end']);
	});

	it('向量查询拒绝 - 后续提交等待在途读取 - 清理读取计数并唤醒提交', async () => {
		const queryRead = deferred();
		const embeddingEvents: string[] = [];
		const storageEvents: string[] = [];
		const store = makeStore({
			replaceFile: async (input) => {
				storageEvents.push(`commit:${input.path}:start`);
				storageEvents.push(`commit:${input.path}:end`);
			},
			search: async () => {
				storageEvents.push('search:start');
				await queryRead.promise;
				storageEvents.push('search:end');
				throw new Error('查询失败');
			},
		});
		const handlers = await openSession(store);
		const querying = handlers['session.searchVector']!({ vector: [0.25, 0.75], topK: 5 });
		const failureAssertion = expect(querying).rejects.toThrow('查询失败');
		await vi.waitFor(() => expect(storageEvents).toContain('search:start'));
		const nextIndexing = handlers['session.upsertFile']!(
			{ path: 'b.md', content: '后续正文' },
			embeddingContext('next', embeddingEvents),
		);
		let storageEventsBeforeReadRelease: string[] = [];
		try {
			await vi.waitFor(() => expect(embeddingEvents).toContain('next:embed:end'));
			await drainAsyncTasks();
			storageEventsBeforeReadRelease = [...storageEvents];
			queryRead.release();
			await failureAssertion;
			await nextIndexing;
		} finally {
			queryRead.release();
			const results = await Promise.allSettled([querying, nextIndexing]);
			expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
		}
		expect(collapseShardFanout(storageEventsBeforeReadRelease)).toEqual(['search:start']);
		expect(collapseShardFanout(storageEvents)).toEqual(['search:start', 'search:end', 'commit:b.md:start', 'commit:b.md:end']);
	});
});
