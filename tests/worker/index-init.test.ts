/**
 * @file tests/worker/index-init.test.ts
 * @description Worker 入口自初始化测试 — 验证 workerData 驱动下 bootstrap 会初始化 embeddings 与索引
 * @module tests/worker/index-init
 * @depends worker/index, worker/handler, worker_threads, @huggingface/transformers
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';

const TMP_WORKER_INIT_DIR = path.join(__dirname, '../tmp/worker-init-test');

// 关键路径:mock worker_threads 的 workerData,让 Worker 入口以为身处真实 Worker 线程。
vi.mock('worker_threads', () => ({
	workerData: { indexDir: TMP_WORKER_INIT_DIR, modelId: 'Xenova/bge-small-zh-v1.5' },
}));

// 关键路径:mock transformers pipeline,避免测试时下载真实模型。
// extractor 必须是一个 callable,与实现中 `await extractor(inputs, options)` 保持一致。
vi.mock('@huggingface/transformers', () => ({
	pipeline: vi.fn().mockResolvedValue(async (texts: string[]) => ({
		tolist: () => texts.map(() => [0.1, 0.2, 0.3]),
	})),
}));

describe('Worker self init', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('Worker 入口 - 存在 workerData 时调用 initProcessor', async () => {
		if (fs.existsSync(TMP_WORKER_INIT_DIR)) {
			fs.rmSync(TMP_WORKER_INIT_DIR, { recursive: true });
		}

		// 模拟 Worker 全局 self:提供 postMessage 与 onmessage 存根。
		const posted: unknown[] = [];
		let messageHandler: ((e: MessageEvent) => void) | null = null;
		const selfMock = {
			postMessage: vi.fn((msg: unknown) => posted.push(msg)),
			get onmessage() {
				return messageHandler;
			},
			set onmessage(handler) {
				messageHandler = handler;
			},
		};

		// @ts-expect-error Node 测试环境没有真实 Worker 全局 self
		vi.stubGlobal('self', selfMock);

		// 关键路径:使用查询参数绕过模块缓存,让每次测试都重新执行入口的 bootstrap。
		await import('../../src/worker/index?worker-init-test=' + Date.now());

		// 等待 bootstrap 完成并注册 onmessage。
		await vi.waitFor(() => expect(messageHandler).not.toBeNull(), { timeout: 5000 });

		// 模拟主线程发来 index.status 请求。
		messageHandler!({ data: { type: 'index.status', payload: {} } } as MessageEvent);

		await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0), { timeout: 5000 });
		const response = posted[0] as { type: string };
		expect(response.type).toBe('index.status.result');
	});
});
