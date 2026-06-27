/**
 * @file tests/worker/embedding-worker.test.ts
 * @description embedding-worker.ts Worker 入口行为 — init/embed/error
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 关键路径:mock EmbeddingOnnx,避免在 jsdom 中真实加载词表与 ONNX 模型。
// Worker 入口的行为是"收到 init → 构造 + init → 回 ready",EmbeddingOnnx 内部细节由其自身测试覆盖。
// 关键路径:用 class 而非箭头函数,因为 Worker 入口里走 `new EmbeddingOnnx(...)`,箭头函数不能作构造器。
vi.mock('../../src/adapters/embedding-onnx', () => ({
	EmbeddingOnnx: class MockEmbeddingOnnx {
		init = vi.fn().mockResolvedValue(undefined);
		embed = vi.fn().mockResolvedValue([[0.1, 0.2]]);
	},
}));

describe('embedding-worker', () => {
	let postMessageSpy: ReturnType<typeof vi.fn>;
	let messages: Array<(e: MessageEvent) => void>;
	let originalPostMessage: unknown;
	let originalOnmessage: unknown;

	beforeEach(() => {
		// 关键路径:每个用例前重置模块缓存,确保 embedding-worker.ts 重新执行
		// (重新触发 self.onmessage = ...),否则第二个用例拿不到 onmessage。
		vi.resetModules();

		postMessageSpy = vi.fn();
		messages = [];
		originalPostMessage = (self as any).postMessage;
		originalOnmessage = (self as any).onmessage;
		(self as any).postMessage = postMessageSpy;
		// 关键路径:用 set/get 拦截 self.onmessage 赋值,捕获 Worker 入口注册的回调。
		Object.defineProperty(self, 'onmessage', {
			set: (fn: (e: MessageEvent) => void) => messages.push(fn),
			get: () => messages[messages.length - 1],
			configurable: true,
		});
	});

	afterEach(() => {
		(self as any).postMessage = originalPostMessage;
		(self as any).onmessage = originalOnmessage;
	});

	it('init - 收到 init 消息后回复 ready', async () => {
		// 动态 import(确保 mock 与 onmessage 拦截器生效)
		await import('../../src/worker/embedding-worker');

		// 模拟主线程发 init 消息
		const initEvent = {
			data: {
				type: 'init',
				deps: {
					vocabContent: '',
					modelBuffer: new ArrayBuffer(0),
					wasmBinary: new ArrayBuffer(0),
				},
				dimensions: 512,
				maxBatchSize: 16,
			},
		} as MessageEvent;

		const onmessage = (self as any).onmessage;
		if (typeof onmessage === 'function') {
			await onmessage(initEvent);
		}

		// 关键路径:init 后应 postMessage ready
		expect(postMessageSpy).toHaveBeenCalledWith({ type: 'ready' });
	});

	it('embed - 未 init 时回复 error', async () => {
		await import('../../src/worker/embedding-worker');

		// 关键路径:未 init 直接发 embed
		const embedEvent = {
			data: { type: 'embed', texts: ['hello'], requestId: 'req_1' },
		} as MessageEvent;

		const onmessage = (self as any).onmessage;
		if (typeof onmessage === 'function') {
			await onmessage(embedEvent);
		}

		// 关键路径:应回复 error,带 requestId 让主线程降级
		expect(postMessageSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				requestId: 'req_1',
			}),
		);
	});
});
