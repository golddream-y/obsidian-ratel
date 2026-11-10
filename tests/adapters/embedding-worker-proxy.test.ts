/**
 * @file tests/adapters/embedding-worker-proxy.test.ts
 * @description EmbeddingWorkerProxy 行为 — 惰性创建 / 空闲回收 / 崩溃重建 / embed / error / terminate
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingWorkerProxy, FALLBACK_DEAD_THRESHOLD, IDLE_TERMINATE_MS } from '../../src/adapters/embedding-worker-proxy';

/**
 * Mock Worker — 模拟 Web Worker 的 postMessage/onmessage 行为。
 *
 * 关键路径:真实 Worker 的 addEventListener 支持多 listener 并存,
 * 这里用数组保存所有 message/error listener,onmessage/onerror 作为广播入口。
 */
class MockWorker {
	private messageListeners: Array<(e: MessageEvent) => void> = [];
	private errorListeners: Array<(e: ErrorEvent) => void> = [];

	// 关键路径:onmessage/onerror 作为广播入口 — 测试调用时分发给所有 addEventListener 注册的 listener
	onmessage: ((e: MessageEvent) => void) | null = (e: MessageEvent) => {
		for (const fn of this.messageListeners) fn(e);
	};
	onerror: ((e: ErrorEvent) => void) | null = (e: ErrorEvent) => {
		for (const fn of this.errorListeners) fn(e);
	};
	postMessage = vi.fn((data: unknown) => {
		// 模拟 Worker 异步响应
		setTimeout(() => {
			if (this.onmessage === null) return;
			const msg = data as { type: string };
			if (msg.type === 'init') {
				this.onmessage({ data: { type: 'ready' } } as MessageEvent);
			}
		}, 0);
	});
	terminate = vi.fn(() => {
		// 关键路径:清空 listener,避免同一 mock 实例被二次 new Worker 时旧 handler 重复计数
		this.messageListeners = [];
		this.errorListeners = [];
	});
	addEventListener = vi.fn((event: string, listener: (e: any) => void) => {
		if (event === 'message') this.messageListeners.push(listener);
		if (event === 'error') this.errorListeners.push(listener);
	});
	removeEventListener = vi.fn();
}

function emptyDeps() {
	return { vocabContent: '', modelBuffer: new ArrayBuffer(8), wasmBinary: new ArrayBuffer(8) };
}

function workerCallCount(): number {
	return (global.Worker as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

/** Worker 构造参数 — 用于断言回退后实际创建的脚本 URL 与加载类型。 */
function workerCtorCalls(): unknown[][] {
	return (global.Worker as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

function findLastEmbedCall(worker: MockWorker): { requestId: string } {
	const embedCalls = worker.postMessage.mock.calls.filter(
		(c: unknown[]) => (c[0] as { type: string }).type === 'embed',
	);
	expect(embedCalls.length).toBeGreaterThan(0);
	return embedCalls[embedCalls.length - 1]![0] as { requestId: string };
}

// 关键路径:mock global.Worker
const originalWorker = global.Worker;

describe('EmbeddingWorkerProxy', () => {
	let mockWorker: MockWorker;

	beforeEach(() => {
		mockWorker = new MockWorker();
		// 关键路径:vi.fn 实现必须用 function/class 才能被 new 调用(箭头函数无 [[Construct]])。
		// 每次 new Worker 换新实例,避免崩溃重建时 listener 累积在同一 mock 上。
		(global as any).Worker = vi.fn(function (this: unknown) {
			mockWorker = new MockWorker();
			return mockWorker;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		(global as any).Worker = originalWorker;
	});

	it('init - 收到 ready 后 embed 可用', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			emptyDeps(),
			512,
		);

		// 关键路径:ready 之前 embed 会 await;Worker 在首次 embed 时才创建
		const embedPromise = proxy.embed(['hello']);
		await new Promise((r) => setTimeout(r, 10));

		const embedCall = mockWorker.postMessage.mock.calls.find(
			(call: unknown[]) => (call[0] as { type: string }).type === 'embed',
		);
		expect(embedCall).toBeDefined();

		const requestId = (embedCall![0] as { requestId: string }).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.1, 0.2, 0.3]] },
		} as MessageEvent);

		const vectors = await embedPromise;
		expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
		proxy.terminate();
	});

	it('embed - 空数组不创建 Worker', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			emptyDeps(),
			512,
		);

		const result = await proxy.embed([]);
		expect(result).toEqual([]);
		expect(global.Worker).not.toHaveBeenCalled();
		proxy.terminate();
	});

	it('terminate - Worker 被 terminate', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			emptyDeps(),
			512,
		);
		const embedPromise = proxy.embed(['x']);
		await new Promise((r) => setTimeout(r, 10));
		const requestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.1]] },
		} as MessageEvent);
		await embedPromise;

		proxy.terminate();
		expect(mockWorker.terminate).toHaveBeenCalled();
	});

	it('terminate - 请求结算后清理超时计时器，卸载时清零空闲计时器', async () => {
		vi.useFakeTimers();
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			emptyDeps(),
			512,
		);
		const embedPromise = proxy.embed(['x']);
		// 让 mock 的 init 回 ready，但不要推进到请求超时。
		await vi.advanceTimersByTimeAsync(0);
		const requestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.1]] },
		} as MessageEvent);
		await embedPromise;
		// 清掉 MockWorker.postMessage 自己排的 0ms 回调，只观察代理持有的计时器。
		await vi.advanceTimersByTimeAsync(1);
		// 请求超时计时器已随结算撤掉，仅剩空闲回收时钟。
		expect(vi.getTimerCount()).toBe(1);
		proxy.terminate();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('Worker onerror - pending 请求被 reject', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			emptyDeps(),
			512,
		);

		const embedPromise = proxy.embed(['test']);
		await new Promise((r) => setTimeout(r, 10));

		mockWorker.onerror?.(new ErrorEvent('error', { message: 'WASM crash' }));

		await expect(embedPromise).rejects.toThrow('WASM crash');
		proxy.terminate();
	});

	it('init - Worker 初始化失败 - 抛 explicit error', async () => {
		const failMockWorker = new MockWorker();
		failMockWorker.postMessage = vi.fn((data: unknown) => {
			setTimeout(() => {
				if (failMockWorker.onmessage === null) return;
				const msg = data as { type: string };
				if (msg.type === 'init') {
					failMockWorker.onmessage({
						data: { type: 'error', error: 'ONNX 初始化失败:模型文件损坏' },
					} as MessageEvent);
				}
			}, 0);
		});
		(global as any).Worker = vi.fn(function (this: unknown) {
			return failMockWorker;
		});

		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			emptyDeps(),
			512,
		);

		await expect(proxy.embed(['test'])).rejects.toThrow('ONNX 初始化失败:模型文件损坏');
		proxy.terminate();
	});

	it('embed - Worker 业务错误 - 抛 explicit error 不静默降级', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			emptyDeps(),
			512,
		);

		const embedPromise = proxy.embed(['hello']);
		await new Promise((r) => setTimeout(r, 10));

		const embedCall = mockWorker.postMessage.mock.calls.find(
			(call: unknown[]) => (call[0] as { type: string }).type === 'embed',
		);
		expect(embedCall).toBeDefined();
		const requestId = (embedCall![0] as { requestId: string }).requestId;

		mockWorker.onmessage?.({
			data: { type: 'error', requestId, error: 'ONNX session.run 失败:输入维度不匹配' },
		} as MessageEvent);

		await expect(embedPromise).rejects.toThrow('ONNX session.run 失败:输入维度不匹配');
		proxy.terminate();
	});

	it('embed - 并发调用 - 多请求 ID 不串扰', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			emptyDeps(),
			512,
		);

		const p1 = proxy.embed(['text1']);
		const p2 = proxy.embed(['text2']);
		const p3 = proxy.embed(['text3']);
		await new Promise((r) => setTimeout(r, 10));

		const embedCalls = mockWorker.postMessage.mock.calls.filter(
			(call: unknown[]) => (call[0] as { type: string }).type === 'embed',
		);
		expect(embedCalls).toHaveLength(3);
		const requestIds = embedCalls.map((c) => (c[0] as { requestId: string }).requestId);
		expect(new Set(requestIds).size).toBe(3);

		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId: requestIds[2]!, vectors: [[0.3]] },
		} as MessageEvent);
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId: requestIds[1]!, vectors: [[0.2]] },
		} as MessageEvent);
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId: requestIds[0]!, vectors: [[0.1]] },
		} as MessageEvent);

		const [v1, v2, v3] = await Promise.all([p1, p2, p3]);
		expect(v1).toEqual([[0.1]]);
		expect(v2).toEqual([[0.2]]);
		expect(v3).toEqual([[0.3]]);
		proxy.terminate();
	});

	it('请求超时 - 主动结算并重建 Worker - 不让后续请求排队到死', async () => {
		vi.useFakeTimers();
		const proxy = new EmbeddingWorkerProxy('mock-url', emptyDeps(), 512);
		const p = proxy.embed(['a']);
		// 只推进到 Worker 创建完成,不触发超时。
		await vi.advanceTimersByTimeAsync(0);
		mockWorker.postMessage.mockClear();
		const rejection = expect(p).rejects.toThrow(/请求超时/);
		// 关键路径:Worker 一直不回复时,120 秒后必须主动失败并重建 Worker,
		// 否则该请求会永久占住 pending,后面所有嵌入调用相继超时(线上就是这样连片的)。
		await vi.advanceTimersByTimeAsync(120_000);
		await rejection;
		expect(mockWorker.terminate).toHaveBeenCalled();
		proxy.terminate();
		vi.useRealTimers();
	});

	it('构造 - 不立即 new Worker - 直到 embed', async () => {
		vi.useFakeTimers();
		const proxy = new EmbeddingWorkerProxy('mock-url', emptyDeps(), 512);
		expect(global.Worker).not.toHaveBeenCalled();
		const p = proxy.embed(['a']);
		// 关键路径:此用例只验证「懒创建」,不能 runAllTimers —— 请求级超时也在定时器里,
		// 全部推进会把请求判超时,断言就跑偏了。
		await vi.advanceTimersByTimeAsync(0);
		const embedCall = mockWorker.postMessage.mock.calls.find(
			(c: unknown[]) => (c[0] as { type: string }).type === 'embed',
		);
		const requestId = (embedCall![0] as { requestId: string }).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.1]] },
		} as MessageEvent);
		await p;
		expect(global.Worker).toHaveBeenCalledTimes(1);
		proxy.terminate();
		vi.useRealTimers();
	});

	it('空闲 5 分钟无挂起 - terminate Worker', async () => {
		vi.useFakeTimers();
		const lifecycle: string[] = [];
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			async () => emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
		);
		const p = proxy.embed(['a']);
		await vi.advanceTimersByTimeAsync(1);
		const embedCall = mockWorker.postMessage.mock.calls.find(
			(c: unknown[]) => (c[0] as { type: string }).type === 'embed',
		);
		const requestId = (embedCall![0] as { requestId: string }).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.2]] },
		} as MessageEvent);
		await p;
		expect(mockWorker.terminate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(IDLE_TERMINATE_MS);
		expect(mockWorker.terminate).toHaveBeenCalled();
		expect(lifecycle).toContain('idle-terminate');
		proxy.terminate();
		vi.useRealTimers();
	});

	it('error 后下一次 embed - 再 new Worker', async () => {
		vi.useFakeTimers();
		const lifecycle: string[] = [];
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			async () => emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
		);
		const first = proxy.embed(['a']);
		await vi.advanceTimersByTimeAsync(1);
		mockWorker.onerror?.(new ErrorEvent('error', { message: 'WASM crash' }));
		await expect(first).rejects.toThrow('WASM crash');
		expect(lifecycle).toContain('crash');
		const workersBefore = workerCallCount();
		const second = proxy.embed(['b']);
		await vi.advanceTimersByTimeAsync(1);
		expect(workerCallCount()).toBeGreaterThan(workersBefore);
		const requestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.3]] },
		} as MessageEvent);
		await second;
		proxy.terminate();
		vi.useRealTimers();
	});

	it('init postMessage 抛错 - 对象 deps 空闲后再 embed - 不挂死且下次仍 new Worker', async () => {
		vi.useFakeTimers();
		const deps = emptyDeps();
		const proxy = new EmbeddingWorkerProxy('mock-url', deps, 512);

		const first = proxy.embed(['a']);
		await vi.advanceTimersByTimeAsync(1);
		const requestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.1]] },
		} as MessageEvent);
		await first;

		await vi.advanceTimersByTimeAsync(IDLE_TERMINATE_MS);
		expect(mockWorker.terminate).toHaveBeenCalled();

		// 关键路径:对象 deps 的 ArrayBuffer 已被 transfer，再次 init 会 DataCloneError
		let throwNextInit = true;
		(global as unknown as { Worker: unknown }).Worker = vi.fn(function (this: unknown) {
			mockWorker = new MockWorker();
			const inner = mockWorker;
			const origPost = inner.postMessage;
			inner.postMessage = vi.fn((data: unknown) => {
				const msg = data as { type: string };
				if (msg.type === 'init' && throwNextInit) {
					throwNextInit = false;
					const err = new Error('could not be cloned');
					err.name = 'DataCloneError';
					throw err;
				}
				return origPost.call(inner, data);
			});
			return inner;
		});

		const second = proxy.embed(['b']);
		const secondOutcome = Promise.race([
			second.then(
				() => 'resolved' as const,
				() => 'rejected' as const,
			),
			new Promise<'hung'>((resolve) => {
				setTimeout(() => resolve('hung'), 100);
			}),
		]);
		await vi.advanceTimersByTimeAsync(100);
		expect(await secondOutcome).toBe('rejected');
		await expect(second).rejects.toThrow();

		const workersAfterThrow = workerCallCount();
		expect(workersAfterThrow).toBe(1);

		const third = proxy.embed(['c']);
		await vi.advanceTimersByTimeAsync(100);
		// 不挂死:worker 已清空,再次 new Worker,而不是卡在未结算的 readyPromise
		expect(workerCallCount()).toBeGreaterThan(workersAfterThrow);
		const rid = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId: rid, vectors: [[0.2]] },
		} as MessageEvent);
		const thirdOutcome = Promise.race([
			third.then(
				() => 'resolved' as const,
				() => 'rejected' as const,
			),
			new Promise<'hung'>((resolve) => {
				setTimeout(() => resolve('hung'), 100);
			}),
		]);
		await vi.advanceTimersByTimeAsync(100);
		expect(await thirdOutcome).toBe('resolved');
		await third;
		proxy.terminate();
		vi.useRealTimers();
	});

	it('连续两次 init 失败 - dead 后 embed 直接抛错不再 new Worker', async () => {
		vi.useFakeTimers();
		const failWorker = new MockWorker();
		failWorker.postMessage = vi.fn((data: unknown) => {
			queueMicrotask(() => {
				const msg = data as { type: string };
				if (msg.type === 'init') {
					failWorker.onmessage?.({
						data: { type: 'error', error: 'ONNX 初始化失败' },
					} as MessageEvent);
				}
			});
		});
		(global as unknown as { Worker: unknown }).Worker = vi.fn(function (this: unknown) {
			return failWorker;
		});
		const proxy = new EmbeddingWorkerProxy('mock-url', async () => emptyDeps(), 512);
		await expect(proxy.embed(['a'])).rejects.toThrow();
		await expect(proxy.embed(['b'])).rejects.toThrow();
		expect(workerCallCount()).toBe(2);
		const callsAfterDead = workerCallCount();
		await expect(proxy.embed(['c'])).rejects.toThrow();
		expect(workerCallCount()).toBe(callsAfterDead);
		proxy.terminate();
		vi.useRealTimers();
	});

	it('ensureReady - 尚未 embed - 创建 Worker 等到 init 且不发推理', async () => {
		vi.useFakeTimers();
		const lifecycle: string[] = [];
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			async () => emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
		);
		const ready = proxy.ensureReady();
		await vi.advanceTimersByTimeAsync(1);
		await ready;
		expect(global.Worker).toHaveBeenCalledTimes(1);
		expect(lifecycle).toEqual(['create']);
		const embedCalls = mockWorker.postMessage.mock.calls.filter(
			(c: unknown[]) => (c[0] as { type: string }).type === 'embed',
		);
		expect(embedCalls).toHaveLength(0);
		proxy.terminate();
		vi.useRealTimers();
	});

	it('ensureReady - 空闲 5 分钟 - terminate 且 lifecycle 含 idle-terminate', async () => {
		vi.useFakeTimers();
		const lifecycle: string[] = [];
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			async () => emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
		);
		const ready = proxy.ensureReady();
		await vi.advanceTimersByTimeAsync(1);
		await ready;
		expect(mockWorker.terminate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(IDLE_TERMINATE_MS);
		expect(mockWorker.terminate).toHaveBeenCalled();
		expect(lifecycle).toContain('idle-terminate');
		proxy.terminate();
		vi.useRealTimers();
	});

	it('ensureReady - dead 后 - 抛错且不再 new Worker', async () => {
		vi.useFakeTimers();
		const failWorker = new MockWorker();
		failWorker.postMessage = vi.fn((data: unknown) => {
			queueMicrotask(() => {
				const msg = data as { type: string };
				if (msg.type === 'init') {
					failWorker.onmessage?.({
						data: { type: 'error', error: 'ONNX 初始化失败' },
					} as MessageEvent);
				}
			});
		});
		(global as unknown as { Worker: unknown }).Worker = vi.fn(function (this: unknown) {
			return failWorker;
		});
		const proxy = new EmbeddingWorkerProxy('mock-url', async () => emptyDeps(), 512);
		await expect(proxy.embed(['a'])).rejects.toThrow();
		await expect(proxy.embed(['b'])).rejects.toThrow();
		const callsAfterDead = workerCallCount();
		await expect(proxy.ensureReady()).rejects.toThrow('Embedding Worker 不可用');
		expect(workerCallCount()).toBe(callsAfterDead);
		proxy.terminate();
		vi.useRealTimers();
	});
});

describe('EmbeddingWorkerProxy — T5 批次活动、取消与运行时重置', () => {
	let mockWorker: MockWorker;

	beforeEach(() => {
		mockWorker = new MockWorker();
		(global as any).Worker = vi.fn(function (this: unknown) {
			mockWorker = new MockWorker();
			return mockWorker;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		(global as any).Worker = originalWorker;
	});

	it('embed - 批次活动 - 按 request ID 转发且其他请求不串扰', async () => {
		const proxy = new EmbeddingWorkerProxy('mock-url', emptyDeps(), 512);
		const batches: Array<[number, number]> = [];
		const pending = proxy.embed(['a', 'b', 'c'], { onBatchComplete: (done, total) => batches.push([done, total]) });
		await new Promise((r) => setTimeout(r, 10));
		const { requestId } = findLastEmbedCall(mockWorker);
		mockWorker.onmessage?.({ data: { type: 'embed:progress', requestId, done: 1, total: 3 } } as MessageEvent);
		// 关键路径:其他请求 ID 的进度不得串扰本次回调。
		mockWorker.onmessage?.({ data: { type: 'embed:progress', requestId: 'other', done: 3, total: 3 } } as MessageEvent);
		mockWorker.onmessage?.({ data: { type: 'embed:progress', requestId, done: 3, total: 3 } } as MessageEvent);
		mockWorker.onmessage?.({ data: { type: 'embed:result', requestId, vectors: [[0.1], [0.2], [0.3]] } } as MessageEvent);
		await expect(pending).resolves.toEqual([[0.1], [0.2], [0.3]]);
		expect(batches).toEqual([[1, 3], [3, 3]]);
		proxy.terminate();
	});

	it('embed - 信号中止 - 发送 cancel 消息、按 AbortError 结束且迟到结果被忽略', async () => {
		const proxy = new EmbeddingWorkerProxy('mock-url', emptyDeps(), 512);
		const controller = new AbortController();
		const pending = proxy.embed(['a'], { signal: controller.signal });
		const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await new Promise((r) => setTimeout(r, 10));
		const { requestId } = findLastEmbedCall(mockWorker);
		controller.abort();
		await rejected;
		// 关键路径:AbortSignal 不跨 Worker,取消经消息表达。
		expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'cancel', requestId });
		// 关键路径:不为取消单项任务终止共享 Worker。
		expect(mockWorker.terminate).not.toHaveBeenCalled();
		// 迟到结果被忽略,且请求已从 pending 中摘除。
		mockWorker.onmessage?.({ data: { type: 'embed:result', requestId, vectors: [[9]] } } as MessageEvent);
		const next = proxy.embed(['b']);
		await new Promise((r) => setTimeout(r, 10));
		const nextRequestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({ data: { type: 'embed:result', requestId: nextRequestId, vectors: [[0.5]] } } as MessageEvent);
		await expect(next).resolves.toEqual([[0.5]]);
		proxy.terminate();
	});

	it('embed - 已中止的信号 - 不创建 Worker 直接按 AbortError 结束', async () => {
		const proxy = new EmbeddingWorkerProxy('mock-url', emptyDeps(), 512);
		const controller = new AbortController();
		controller.abort();
		await expect(proxy.embed(['a'], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
		expect(global.Worker).not.toHaveBeenCalled();
		proxy.terminate();
	});

	it('resetRuntime - 永久挂起 - 全部 pending 按真实失败结束且随后可重建 Worker', async () => {
		const proxy = new EmbeddingWorkerProxy('mock-url', emptyDeps(), 512);
		const first = expect(proxy.embed(['a'])).rejects.toThrow('运行时暂不可用');
		const second = expect(proxy.embed(['b'])).rejects.toThrow('运行时暂不可用');
		await new Promise((r) => setTimeout(r, 10));
		proxy.resetRuntime('运行时暂不可用');
		await Promise.all([first, second]);
		expect(mockWorker.terminate).toHaveBeenCalled();
		// 关键路径:重置不是 dead —— 下一次 embed 重新创建 Worker。
		const workersBefore = workerCallCount();
		const third = proxy.embed(['c']);
		await new Promise((r) => setTimeout(r, 10));
		expect(workerCallCount()).toBeGreaterThan(workersBefore);
		const requestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({ data: { type: 'embed:result', requestId, vectors: [[0.7]] } } as MessageEvent);
		await expect(third).resolves.toEqual([[0.7]]);
		proxy.terminate();
	});
});

describe('EmbeddingWorkerProxy — 运行期失败回退与上限', () => {
	let mockWorker: MockWorker;

	beforeEach(() => {
		mockWorker = new MockWorker();
		(global as any).Worker = vi.fn(function (this: unknown) {
			mockWorker = new MockWorker();
			return mockWorker;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		(global as any).Worker = originalWorker;
	});

	/** 推进一次「Worker 不回复 → 请求超时」的完整周期。 */
	async function timeoutOnce(proxy: EmbeddingWorkerProxy, text: string): Promise<void> {
		const pending = proxy.embed([text]);
		await vi.advanceTimersByTimeAsync(0);
		const rejected = expect(pending).rejects.toThrow(/请求超时/);
		await vi.advanceTimersByTimeAsync(120_000);
		await rejected;
	}

	it('连续两次请求超时 - 回退 WASM 并回写后端 - 下一次创建使用 WASM 脚本', async () => {
		vi.useFakeTimers();
		const lifecycle: string[] = [];
		const onBackend = vi.fn();
		const proxy = new EmbeddingWorkerProxy(
			'gpu-url',
			async () => emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
			'module',
			undefined,
			120_000,
			{ fallback: () => ({ workerUrl: 'wasm-url', workerType: 'classic' }), onBackend },
		);

		// 第一次失败只重建，不改变执行路径。
		await timeoutOnce(proxy, 'a');
		expect(onBackend).not.toHaveBeenCalled();
		expect(lifecycle).not.toContain('fallback');

		// 第二次失败达到上限：必须切 WASM 并回写后端，不能继续按同一 GPU 路径重建。
		await timeoutOnce(proxy, 'b');
		expect(onBackend).toHaveBeenCalledWith('wasm');
		expect(lifecycle).toContain('fallback');

		const next = proxy.embed(['c']);
		await vi.advanceTimersByTimeAsync(0);
		const lastCall = workerCtorCalls().at(-1);
		expect(lastCall?.[0]).toBe('wasm-url');
		expect(lastCall?.[1]).toEqual({ type: 'classic' });
		const requestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({ data: { type: 'embed:result', requestId, vectors: [[0.5]] } } as MessageEvent);
		await expect(next).resolves.toEqual([[0.5]]);
		proxy.terminate();
	});

	it('GPU 设备丢失 - 无需累计立即回退 WASM - 在途请求按真实失败结束', async () => {
		const lifecycle: string[] = [];
		const onBackend = vi.fn();
		const proxy = new EmbeddingWorkerProxy(
			'gpu-url',
			emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
			'module',
			undefined,
			120_000,
			{ fallback: () => ({ workerUrl: 'wasm-url', workerType: 'classic' }), onBackend },
		);
		const pending = proxy.embed(['a']);
		await new Promise((r) => setTimeout(r, 10));
		const rejected = expect(pending).rejects.toThrow(/GPU 设备丢失/);
		mockWorker.onmessage?.({ data: { type: 'gpu:lost', reason: 'device-lost' } } as MessageEvent);
		await rejected;
		// 关键路径:设备已丢失，不能再等 120 秒；徽标必须立即跟随真实执行路径。
		expect(onBackend).toHaveBeenCalledWith('wasm');
		expect(lifecycle).toContain('fallback');

		const before = workerCallCount();
		const next = proxy.embed(['b']);
		await new Promise((r) => setTimeout(r, 10));
		expect(workerCallCount()).toBeGreaterThan(before);
		expect(workerCtorCalls().at(-1)?.[0]).toBe('wasm-url');
		const requestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({ data: { type: 'embed:result', requestId, vectors: [[0.6]] } } as MessageEvent);
		await expect(next).resolves.toEqual([[0.6]]);
		proxy.terminate();
	});

	it('回退 WASM 后仍连续失败 - 达到上限进入 dead - 后续请求快速失败不再创建 Worker', async () => {
		vi.useFakeTimers();
		const lifecycle: string[] = [];
		const proxy = new EmbeddingWorkerProxy(
			'gpu-url',
			async () => emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
			'module',
			undefined,
			120_000,
			{ fallback: () => ({ workerUrl: 'wasm-url', workerType: 'classic' }), onBackend: vi.fn() },
		);

		// 先经设备丢失立即回退到 WASM。
		const lost = proxy.embed(['a']);
		await vi.advanceTimersByTimeAsync(0);
		const lostRejected = expect(lost).rejects.toThrow(/GPU 设备丢失/);
		mockWorker.onmessage?.({ data: { type: 'gpu:lost', reason: 'gone' } } as MessageEvent);
		await lostRejected;

		for (let i = 0; i < FALLBACK_DEAD_THRESHOLD; i += 1) {
			await timeoutOnce(proxy, `fail-${i}`);
		}
		expect(lifecycle).toContain('dead');

		// 关键路径:dead 之后必须快速失败，让索引进入失败态，而不是长期停在「索引中」。
		const callsAfterDead = workerCallCount();
		await expect(proxy.embed(['z'])).rejects.toThrow('Embedding Worker 不可用');
		expect(workerCallCount()).toBe(callsAfterDead);
		proxy.terminate();
	});

	it('预热实例终止后 - 不被再次接管 - 下一次 embed 重新创建 Worker', async () => {
		vi.useFakeTimers();
		const prewarmed = new MockWorker();
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			async () => emptyDeps(),
			512,
			16,
			undefined,
			'classic',
			prewarmed as unknown as Worker,
		);
		await proxy.ensureReady();
		proxy.terminate();

		// 关键路径:预热实例已被终止,若仍保留引用，下次会接管死实例并等满超时。
		const before = workerCallCount();
		const pending = proxy.embed(['a']);
		await vi.advanceTimersByTimeAsync(0);
		expect(workerCallCount()).toBe(before + 1);
		const requestId = findLastEmbedCall(mockWorker).requestId;
		mockWorker.onmessage?.({ data: { type: 'embed:result', requestId, vectors: [[0.1]] } } as MessageEvent);
		await expect(pending).resolves.toEqual([[0.1]]);
		proxy.terminate();
	});
});
