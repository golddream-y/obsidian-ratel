/**
 * @file tests/worker/index-init.test.ts
 * @description Worker 入口自初始化测试 — 验证 Worker Threads 场景下 bootstrap 明确报错
 * @module tests/worker/index-init
 * @depends worker/index, worker_threads
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';

const TMP_WORKER_INIT_DIR = path.join(__dirname, '../tmp/worker-init-test');

// 关键路径:mock worker_threads 的 workerData,让 Worker 入口以为身处真实 Worker 线程。
vi.mock('worker_threads', () => ({
	workerData: { indexDir: TMP_WORKER_INIT_DIR },
}));

describe('Worker self init', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('Worker 入口 - Worker Threads 场景下返回明确错误', async () => {
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

		// 模拟主线程发来 index.status 请求,应返回 WORKER_INIT_FAILED。
		messageHandler!({ data: { type: 'index.status', payload: {} } } as MessageEvent);

		await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0), { timeout: 5000 });
		const response = posted[0] as { type: string; payload?: { code?: string; message?: string } };
		expect(response.type).toBe('error');
		expect(response.payload?.code).toBe('WORKER_INIT_FAILED');
		expect(response.payload?.message).toContain('Worker Threads');
	});
});
