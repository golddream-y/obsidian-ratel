/**
 * @file tests/adapters/embedding-worker-proxy.test.ts
 * @description EmbeddingWorkerProxy 行为 — init/ready/embed/error/terminate
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingWorkerProxy } from '../../src/adapters/embedding-worker-proxy';

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
	terminate = vi.fn();
	addEventListener = vi.fn((event: string, listener: (e: any) => void) => {
		if (event === 'message') this.messageListeners.push(listener);
		if (event === 'error') this.errorListeners.push(listener);
	});
	removeEventListener = vi.fn();
}

// 关键路径:mock global.Worker
const originalWorker = global.Worker;

describe('EmbeddingWorkerProxy', () => {
	let mockWorker: MockWorker;

	beforeEach(() => {
		mockWorker = new MockWorker();
		// 关键路径:vi.fn 实现必须用 function/class 才能被 new 调用(箭头函数无 [[Construct]])。
		(global as any).Worker = vi.fn(function (this: unknown) {
			return mockWorker;
		});
	});

	afterEach(() => {
		(global as any).Worker = originalWorker;
	});

	it('init - 收到 ready 后 embed 可用', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);

		// 关键路径:ready 之前 embed 会 await
		// 模拟 Worker 收到 embed 请求后返回向量
		const embedPromise = proxy.embed(['hello']);
		// 等一个 macrotask 让 postMessage 被调用
		await new Promise((r) => setTimeout(r, 10));

		// 找到 embed 请求的 postMessage 调用
		const embedCall = mockWorker.postMessage.mock.calls.find(
			(call: unknown[]) => (call[0] as { type: string }).type === 'embed',
		);
		expect(embedCall).toBeDefined();

		const requestId = (embedCall![0] as { requestId: string }).requestId;
		// 模拟 Worker 返回向量
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.1, 0.2, 0.3]] },
		} as MessageEvent);

		const vectors = await embedPromise;
		expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
	});

	it('embed - 空数组不调 postMessage', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);
		await new Promise((r) => setTimeout(r, 10)); // 等 init

		const result = await proxy.embed([]);
		expect(result).toEqual([]);
		// 只有 init 的 postMessage,没有 embed 的
		expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
	});

	it('terminate - Worker 被 terminate', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);
		await new Promise((r) => setTimeout(r, 10));

		proxy.terminate();
		expect(mockWorker.terminate).toHaveBeenCalled();
	});

	it('Worker onerror - pending 请求被 reject', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);
		await new Promise((r) => setTimeout(r, 10));

		const embedPromise = proxy.embed(['test']);
		await new Promise((r) => setTimeout(r, 10));

		// 模拟 Worker 崩溃
		mockWorker.onerror?.(new ErrorEvent('error', { message: 'WASM crash' }));

		await expect(embedPromise).rejects.toThrow('WASM crash');
	});
});
