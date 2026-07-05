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

	it('onmessage - embed 成功 - 返回向量', async () => {
		// 关键路径:覆盖 embed 成功路径 — init 后发 embed,验证 postMessage 返回 embed:result
		await import('../../src/worker/embedding-worker');

		// 步骤 1:先发 init 让 Worker 就绪
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
		const onmessageInit = (self as any).onmessage;
		if (typeof onmessageInit === 'function') {
			await onmessageInit(initEvent);
		}
		// 关键路径:init 后应回复 ready
		expect(postMessageSpy).toHaveBeenCalledWith({ type: 'ready' });

		// 步骤 2:发 embed 请求
		const embedEvent = {
			data: { type: 'embed', texts: ['hello world'], requestId: 'req_embed_ok' },
		} as MessageEvent;
		const onmessageEmbed = (self as any).onmessage;
		if (typeof onmessageEmbed === 'function') {
			await onmessageEmbed(embedEvent);
		}

		// 关键路径:应回复 embed:result,带 requestId + vectors(mock 默认返回 [[0.1, 0.2]])
		expect(postMessageSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'embed:result',
				requestId: 'req_embed_ok',
				vectors: [[0.1, 0.2]],
			}),
		);
	});

	it('onmessage - init 失败 - 返回错误', async () => {
		// 关键路径:覆盖 init 失败路径 — mock EmbeddingOnnx.init 抛错,验证 postMessage 返回 error(无 requestId)
		// 重新 mock EmbeddingOnnx,让 init 抛错
		vi.doMock('../../src/adapters/embedding-onnx', () => ({
			EmbeddingOnnx: class FailInitEmbeddingOnnx {
				init = vi.fn().mockRejectedValue(new Error('ONNX 模型文件损坏'));
				embed = vi.fn();
			},
		}));
		vi.resetModules();

		await import('../../src/worker/embedding-worker');

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

		// 关键路径:init 失败应回复 error(无 requestId),error 含"初始化失败"
		expect(postMessageSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				error: expect.stringContaining('初始化失败'),
			}),
		);
		// 关键路径:error 消息不带 requestId(广播式,主线程 ready reject)
		const errorCall = postMessageSpy.mock.calls.find(
			(call: unknown[]) => (call[0] as { type: string }).type === 'error',
		);
		expect(errorCall).toBeDefined();
		expect((errorCall![0] as { requestId?: string }).requestId).toBeUndefined();
	});
});
