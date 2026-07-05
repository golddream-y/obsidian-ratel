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

	it('init - Worker 初始化失败 - 抛 explicit error', async () => {
		// 关键路径:覆盖 init 失败路径 — Worker 返回 error(无 requestId)时 readyPromise 应 reject
		// 用自定义 mock Worker,init 时返回 error 而非 ready
		const failMockWorker = new MockWorker();
		failMockWorker.postMessage = vi.fn((data: unknown) => {
			setTimeout(() => {
				if (failMockWorker.onmessage === null) return;
				const msg = data as { type: string };
				if (msg.type === 'init') {
					// 关键路径:init 失败 — 返回 error 且不带 requestId(触发 ready reject)
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
			{ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);

		// 关键路径:ready 应 reject,不静默降级(AGENTS.md 关键约束)
		await expect(proxy.ready).rejects.toThrow('ONNX 初始化失败:模型文件损坏');

		// embed 也应失败(因 ready 已 reject)
		await expect(proxy.embed(['test'])).rejects.toThrow();
	});

	it('embed - Worker 业务错误 - 抛 explicit error 不静默降级', async () => {
		// 关键路径:覆盖 embed 业务错误路径 — Worker 返回 error 带 requestId 时对应请求应 reject
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);
		await new Promise((r) => setTimeout(r, 10)); // 等 init ready

		const embedPromise = proxy.embed(['hello']);
		await new Promise((r) => setTimeout(r, 10)); // 等 postMessage

		// 找到 embed 请求的 requestId
		const embedCall = mockWorker.postMessage.mock.calls.find(
			(call: unknown[]) => (call[0] as { type: string }).type === 'embed',
		);
		expect(embedCall).toBeDefined();
		const requestId = (embedCall![0] as { requestId: string }).requestId;

		// 关键路径:模拟 Worker 推理失败,返回 error 带 requestId
		mockWorker.onmessage?.({
			data: { type: 'error', requestId, error: 'ONNX session.run 失败:输入维度不匹配' },
		} as MessageEvent);

		// 关键路径:不应静默降级,应显式抛错(AGENTS.md:Web Worker 失败必须抛 explicit errors)
		await expect(embedPromise).rejects.toThrow('ONNX session.run 失败:输入维度不匹配');
	});

	it('embed - 并发调用 - 多请求 ID 不串扰', async () => {
		// 关键路径:覆盖并发场景 — 3 个并发 embed 请求,requestId 自增,响应按 requestId 路由不串扰
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabContent: '', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);
		await new Promise((r) => setTimeout(r, 10)); // 等 init ready

		// 关键路径:并发发起 3 个 embed 请求
		const p1 = proxy.embed(['text1']);
		const p2 = proxy.embed(['text2']);
		const p3 = proxy.embed(['text3']);
		await new Promise((r) => setTimeout(r, 10)); // 等 3 个 postMessage

		// 找到 3 个 embed 请求的 requestId(应自增 embed_1, embed_2, embed_3)
		const embedCalls = mockWorker.postMessage.mock.calls.filter(
			(call: unknown[]) => (call[0] as { type: string }).type === 'embed',
		);
		expect(embedCalls).toHaveLength(3);
		const requestIds = embedCalls.map((c) => (c[0] as { requestId: string }).requestId);
		// 关键路径:requestId 唯一且自增
		expect(new Set(requestIds).size).toBe(3);

		// 关键路径:乱序返回响应(p3 先回,p1 后回),验证结果不串扰
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
	});
});
