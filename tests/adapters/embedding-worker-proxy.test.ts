/**
 * @file tests/adapters/embedding-worker-proxy.test.ts
 * @description EmbeddingWorkerProxy 行为 — 惰性创建 / 空闲回收 / 崩溃重建 / embed / error / terminate
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingWorkerProxy, IDLE_TERMINATE_MS } from '../../src/adapters/embedding-worker-proxy';

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

	it('构造 - 不立即 new Worker - 直到 embed', async () => {
		vi.useFakeTimers();
		const proxy = new EmbeddingWorkerProxy('mock-url', emptyDeps(), 512);
		expect(global.Worker).not.toHaveBeenCalled();
		const p = proxy.embed(['a']);
		await vi.runAllTimersAsync();
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
});
