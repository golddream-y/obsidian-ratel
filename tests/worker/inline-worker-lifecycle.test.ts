/**
 * @file tests/worker/inline-worker-lifecycle.test.ts
 * @description 直接消息入口串行化与异常恢复
 * @module tests/worker/inline-worker-lifecycle
 * @depends worker/inline-worker, worker/handler
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WorkerResponse } from '../../src/types';
import { InlineWorker } from '../../src/worker/inline-worker';
import { IndexProcessor } from '../../src/worker/index-processor';
import { setProcessorForTest, initProcessorWithStore } from '../../src/worker/handler';
import type { VectraStore } from '../../src/adapters/vector-vectra';
import type { EmbeddingPort } from '../../src/ports/embedding';
import { createEmbedAbortError } from '../../src/ports/embedding';
describe('InlineWorker 串行入口', () => {
	afterEach(() => setProcessorForTest(null));
	it('异步消息 - 全量未结束时收到下一条 - 每文件单次事务写入且进度关联原请求', async () => {
		let releaseEmbed!: () => void;
		let releaseWrite!: () => void;
		// 关键路径(新存储契约):`reembedFile` 走 `replaceFile` 一个事务完成删除 + 插入,
		// 因此「写入」的观测点从旧的 beginFileUpdate/endFileUpdate 挪到 replaceFile。
		let writesInFlight = 0;
		let maxWritesInFlight = 0;
		const replaceCalls: string[] = [];
		const order: string[] = [];
		const processor = new IndexProcessor({
			replaceFile: async (input: { path: string }) => {
				replaceCalls.push(input.path);
				writesInFlight++;
				maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
				// 关键路径:首个文件的提交故意挂起,若入口未串行,第二条消息的提交会并发进入。
				if (replaceCalls.length === 1) await new Promise<void>(resolve => { releaseWrite = resolve; });
				writesInFlight--;
			},
			isReloadRequired: () => false,
			reload: async () => undefined,
		} as unknown as VectraStore, {
			modelId: 'test', dimensions: 3,
			embed: async (texts) => { order.push(texts[0]!); if (order.length === 1)
				await new Promise<void>(r => { releaseEmbed = r; }); return texts.map(() => [1, 0, 0]); },
		}, { maxTokens: 100, overlapTokens: 0, count: text => text.length });
		setProcessorForTest(processor);
		const worker = new InlineWorker();
		const messages: Array<{
			type: string;
			_requestId?: string;
		}> = [];
		worker.on('message', (message: WorkerResponse & {
			_requestId?: string;
		}) => messages.push(message));
		try {
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'a.md', content: 'first' }] }, _requestId: 'first' });
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'b.md', content: 'second' }] }, _requestId: 'second' });
			await vi.waitFor(() => expect(order).toHaveLength(1));
			releaseEmbed();
			await vi.waitFor(() => expect(replaceCalls).toHaveLength(1));
			// 关键路径:第一个文件的提交仍挂起时,第二条消息不得并发进入写入路径。
			expect(maxWritesInFlight).toBe(1);
			releaseWrite();
			await vi.waitFor(() => expect(messages.filter(message => message.type === 'index.done')).toHaveLength(2));
			// 关键路径:每个文件恰好一次事务写入,顺序与请求顺序一致。
			expect(replaceCalls).toEqual(['a.md', 'b.md']);
			expect(maxWritesInFlight).toBe(1);
			expect(messages.filter(message => message.type === 'index.progress').map(message => message._requestId)).toEqual(['first', 'second']);
		}
		finally {
			worker.terminate();
		}
	});
});

describe('InlineWorker 消息分道与取消(T5)', () => {
	afterEach(() => setProcessorForTest(null));

	it('只读查询 - 索引推理进行中 - 不排在索引队列后并先返回', async () => {
		let releaseEmbed!: () => void;
		const events: string[] = [];
		const store = {
			replaceFile: async () => undefined,
			search: async () => {
				events.push('search');
				return [];
			},
			status: async () => ({ totalDocs: 0, lastIndexTime: 0 }),
			isReloadRequired: () => false,
			reload: async () => undefined,
		};
		const port = {
			modelId: 'test', dimensions: 3,
			embed: async (texts: string[]) => {
				events.push('embed-start');
				await new Promise<void>(resolve => { releaseEmbed = resolve; });
				events.push('embed-end');
				return texts.map(() => [1, 0, 0]);
			},
		};
		// 关键路径:必须走真实装配入口 —— 活动上报与提交/查询互斥门都在那里注入。
		initProcessorWithStore(store as unknown as VectraStore, port as unknown as EmbeddingPort);
		const worker = new InlineWorker();
		const responses: string[] = [];
		worker.on('message', (message: WorkerResponse & { _requestId?: string }) => {
			const msg = message;
			// 关键路径:只统计终态响应,进度与活动不是终态。
			if (msg._requestId && msg.type !== 'index.progress' && msg.type !== 'index.activity') {
				responses.push(`${msg._requestId}:${msg.type}`);
			}
		});
		try {
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'a.md', content: 'x' }] }, _requestId: 'idx' });
			await vi.waitFor(() => expect(events).toContain('embed-start'));
			worker.postMessage({ type: 'vector.search', payload: { queryVector: [1, 0, 0], topK: 1 }, _requestId: 'q1' });
			// 关键路径:查询在索引仍在推理时就返回,不等待整轮索引结束。
			await vi.waitFor(() => expect(responses).toContain('q1:vector.search.result'));
			expect(events).not.toContain('embed-end');
			expect(responses.some(response => response.startsWith('idx:'))).toBe(false);
			releaseEmbed();
			await vi.waitFor(() => expect(responses).toContain('idx:index.done'));
			expect(events.indexOf('search')).toBeLessThan(events.indexOf('embed-end'));
		}
		finally {
			worker.terminate();
		}
	});

	it('提交窗口 - 查询不读事务中间状态 - 提交与查询不重叠且两个提交不重叠', async () => {
		const events: string[] = [];
		const replaceCalls: string[] = [];
		let writesInFlight = 0;
		let maxWritesInFlight = 0;
		let searchEnteredDuringWrite = 0;
		let releaseFirstWrite!: () => void;
		let releaseSecondWrite!: () => void;
		const store = {
			replaceFile: async (input: { path: string }) => {
				writesInFlight += 1;
				maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
				replaceCalls.push(input.path);
				events.push(`write-start:${input.path}`);
				if (replaceCalls.length === 1) await new Promise<void>(resolve => { releaseFirstWrite = resolve; });
				if (replaceCalls.length === 2) await new Promise<void>(resolve => { releaseSecondWrite = resolve; });
				events.push(`write-end:${input.path}`);
				writesInFlight -= 1;
			},
			search: async () => {
				// 关键路径:查询落在提交窗口内就是「读到事务中间状态」的直接证据。
				searchEnteredDuringWrite = Math.max(searchEnteredDuringWrite, writesInFlight);
				events.push('search');
				return [];
			},
			status: async () => ({ totalDocs: 0, lastIndexTime: 0 }),
			isReloadRequired: () => false,
			reload: async () => undefined,
		};
		const port = {
			modelId: 'test', dimensions: 3,
			embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
		};
		initProcessorWithStore(store as unknown as VectraStore, port as unknown as EmbeddingPort);
		const worker = new InlineWorker();
		const responses: string[] = [];
		worker.on('message', (message: WorkerResponse & { _requestId?: string }) => {
			const msg = message;
			if (msg._requestId && msg.type !== 'index.progress' && msg.type !== 'index.activity') {
				responses.push(`${msg._requestId}:${msg.type}`);
			}
		});
		try {
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'a.md', content: 'x' }] }, _requestId: 'w1' });
			await vi.waitFor(() => expect(replaceCalls).toHaveLength(1));
			// 提交未结束时发出查询与第二个索引请求:两者都不得开始。
			worker.postMessage({ type: 'vector.search', payload: { queryVector: [1, 0, 0], topK: 1 }, _requestId: 'q-during-write' });
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'b.md', content: 'y' }] }, _requestId: 'w2' });
			expect(events).toEqual(['write-start:a.md']);
			expect(maxWritesInFlight).toBe(1);
			releaseFirstWrite();
			await vi.waitFor(() => expect(replaceCalls).toHaveLength(2));
			expect(maxWritesInFlight).toBe(1);
			expect(searchEnteredDuringWrite).toBe(0);
			releaseSecondWrite();
			await vi.waitFor(() => expect(responses).toHaveLength(3));
			expect(responses).toContain('q-during-write:vector.search.result');
			expect(maxWritesInFlight).toBe(1);
			expect(searchEnteredDuringWrite).toBe(0);
		}
		finally {
			worker.terminate();
		}
	});

	it('提交窗口 - 多步写事务(deleteByPath)在途 - 查询不得进入且窗口关闭后可进入(B1)', async () => {
		// 关键路径(B1):与生产同构的替身 —— `VectraStore.deleteByPath` 是
		// `beginTransaction → deleteItems → endUpdate` 的多步事务,不经 `replaceFile`,
		// 因此它同样必须落在共享访问门之内。
		let writesInFlight = 0;
		let maxWritesInFlight = 0;
		let searchEnteredDuringWrite = 0;
		let searchCalls = 0;
		const order: string[] = [];
		let releaseDelete!: () => void;
		const store = {
			replaceFile: async () => undefined,
			deleteByPath: async (filePath: string) => {
				writesInFlight += 1;
				maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
				order.push(`delete-start:${filePath}`);
				await new Promise<void>(resolve => { releaseDelete = resolve; });
				order.push(`delete-end:${filePath}`);
				writesInFlight -= 1;
				return 1;
			},
			search: async () => {
				searchCalls += 1;
				searchEnteredDuringWrite = Math.max(searchEnteredDuringWrite, writesInFlight);
				order.push('search');
				return [];
			},
			status: async () => ({ totalDocs: 0, lastIndexTime: 0 }),
			isReloadRequired: () => false,
			reload: async () => undefined,
		};
		const port = {
			modelId: 'test', dimensions: 3,
			embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
		};
		initProcessorWithStore(store as unknown as VectraStore, port as unknown as EmbeddingPort);
		const worker = new InlineWorker();
		const responses: string[] = [];
		worker.on('message', (message: WorkerResponse & { _requestId?: string }) => {
			const msg = message;
			if (msg._requestId && msg.type !== 'index.progress' && msg.type !== 'index.activity') {
				responses.push(`${msg._requestId}:${msg.type}`);
			}
		});
		try {
			worker.postMessage({ type: 'index.delete', payload: { filePath: 'a.md' }, _requestId: 'd1' });
			await vi.waitFor(() => expect(order).toContain('delete-start:a.md'));
			// 写事务在途:查询不得进入存储。
			worker.postMessage({ type: 'vector.search', payload: { queryVector: [1, 0, 0], topK: 1 }, _requestId: 'q-during-delete' });
			// 关键路径:这是事件循环检查点 —— 查询的派发回调先于本检查点注册(同延迟定时器按注册顺序),
			// 所以它不是墙上时钟赛跑,而是确定性的顺序判决。
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(order).toEqual(['delete-start:a.md']);
			expect(searchEnteredDuringWrite).toBe(0);
			releaseDelete();
			await vi.waitFor(() => expect(responses).toContain('d1:vector.delete.done'));
			await vi.waitFor(() => expect(responses).toContain('q-during-delete:vector.search.result'));
			expect(maxWritesInFlight).toBe(1);
			expect(searchEnteredDuringWrite).toBe(0);

			// 正向对照:写事务结束(窗口关闭)后,查询确实可以进入存储。
			worker.postMessage({ type: 'vector.search', payload: { queryVector: [1, 0, 0], topK: 1 }, _requestId: 'q-after' });
			await vi.waitFor(() => expect(responses).toContain('q-after:vector.search.result'));
			expect(searchCalls).toBe(2);
			expect(searchEnteredDuringWrite).toBe(0);
		}
		finally {
			worker.terminate();
		}
	});

	it('在途查询 - 提交开始前查询未结束 - 提交等待查询读完才进入', async () => {
		let releaseEmbed!: () => void;
		let releaseSearch!: () => void;
		const events: string[] = [];
		const store = {
			replaceFile: async () => {
				events.push('write-start');
			},
			search: async () => {
				events.push('search-start');
				await new Promise<void>(resolve => { releaseSearch = resolve; });
				events.push('search-end');
				return [];
			},
			status: async () => ({ totalDocs: 0, lastIndexTime: 0 }),
			isReloadRequired: () => false,
			reload: async () => undefined,
		};
		const port = {
			modelId: 'test', dimensions: 3,
			embed: async (texts: string[]) => {
				events.push('embed');
				await new Promise<void>(resolve => { releaseEmbed = resolve; });
				return texts.map(() => [1, 0, 0]);
			},
		};
		initProcessorWithStore(store as unknown as VectraStore, port as unknown as EmbeddingPort);
		const worker = new InlineWorker();
		const responses: string[] = [];
		const activities: string[] = [];
		worker.on('message', (message: WorkerResponse & { _requestId?: string }) => {
			const msg = message;
			// 关键路径(I5):提交尝试开始的唯一可观察正向信号是 `persist` 活动 ——
			// 它在访问门等待之前上报,因此「已尝试提交」不再靠墙上时钟推断。
			if (msg.type === 'index.activity') activities.push(msg.payload.stage);
			if (msg._requestId && msg.type !== 'index.progress' && msg.type !== 'index.activity') {
				responses.push(`${msg._requestId}:${msg.type}`);
			}
		});
		try {
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'a.md', content: 'x' }] }, _requestId: 'idx' });
			await vi.waitFor(() => expect(events).toContain('embed'));
			// 推理阶段发出查询:此时没有提交窗口,查询立即开始并挂起。
			worker.postMessage({ type: 'vector.search', payload: { queryVector: [1, 0, 0], topK: 1 }, _requestId: 'q' });
			await vi.waitFor(() => expect(events).toContain('search-start'));
			// 索引随后进入提交:必须先等在途查询读完,不能与查询重叠。
			releaseEmbed();
			// 关键路径(I5):等「提交已尝试开始」这一正向信号,而不是等一段真实时间;
			// 信号到达时若门失效,write-start 早已在同一条微任务链上发生,断言因此可失败。
			await vi.waitFor(() => expect(activities).toContain('persist'));
			expect(events).toContain('search-start');
			expect(events).not.toContain('write-start');
			expect(events).not.toContain('search-end');
			releaseSearch();
			await vi.waitFor(() => expect(events).toContain('write-start'));
			expect(events.indexOf('search-end')).toBeLessThan(events.indexOf('write-start'));
			await vi.waitFor(() => expect(responses).toHaveLength(2));
		}
		finally {
			worker.terminate();
		}
	});

	it('取消 - 索引运行收到 index.cancel - 推理按真实失败结束且 Worker 与其他请求继续可用', async () => {
		const signals: AbortSignal[] = [];
		const replaceCalls: string[] = [];
		const store = {
			replaceFile: async (input: { path: string }) => { replaceCalls.push(input.path); },
			status: async () => ({ totalDocs: 3, lastIndexTime: 5 }),
			isReloadRequired: () => false,
			reload: async () => undefined,
		};
		const port = {
			modelId: 'test', dimensions: 3,
			embed: async (texts: string[], options?: { signal?: AbortSignal }) => {
				const signal = options?.signal;
				if (signal) signals.push(signal);
				await new Promise<never>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(createEmbedAbortError());
						return;
					}
					signal?.addEventListener('abort', () => reject(createEmbedAbortError()));
				});
				return texts.map(() => [1, 0, 0]);
			},
		};
		initProcessorWithStore(store as unknown as VectraStore, port as unknown as EmbeddingPort);
		const worker = new InlineWorker();
		const terminate = vi.spyOn(worker, 'terminate');
		const responses: Array<{ type: string; _requestId?: string; payload?: { indexed?: number; errors?: number } }> = [];
		worker.on('message', (message: WorkerResponse & { _requestId?: string }) => {
			const msg = message as { type: string; _requestId?: string; payload?: { indexed?: number; errors?: number } };
			if (msg._requestId && msg.type !== 'index.progress' && msg.type !== 'index.activity') responses.push(msg);
		});
		try {
			worker.postMessage({ type: 'index.full', payload: { files: [{ path: 'a.md', content: 'x' }] }, _requestId: 'idx' });
			await vi.waitFor(() => expect(signals).toHaveLength(1));
			worker.postMessage({ type: 'index.cancel', payload: { requestId: 'idx' } });
			await vi.waitFor(() => expect(responses.some(response => response.type === 'index.done')).toBe(true));
			const done = responses.find(response => response.type === 'index.done');
			// 关键路径:取消按真实失败结束,且不提交任何向量。
			expect(done?.payload?.indexed).toBe(0);
			expect(done?.payload?.errors).toBe(1);
			expect(replaceCalls).toEqual([]);
			// 关键路径:共享 Worker 不为单项任务取消而终止;其他请求继续可用。
			expect(terminate).not.toHaveBeenCalled();
			worker.postMessage({ type: 'index.status', payload: {}, _requestId: 'st1' });
			await vi.waitFor(() => expect(responses.some(response => response._requestId === 'st1')).toBe(true));
		}
		finally {
			terminate.mockRestore();
			worker.terminate();
		}
	});
});
