/**
 * @file src/worker/index.ts
 * @description Worker 线程入口 — 接收主线程消息并委托给 handler
 * @module worker/index
 * @depends types, ./handler
 *
 * 硬约束:
 * - 严禁 `import 'obsidian'`
 * - 不发 HTTP 请求(Embedding / LLM 调用都在主线程)
 * - 与主线程通过 `postMessage` 单向通信
 */

import type { WorkerRequest, WorkerResponse } from '../types';
import { handleMessage } from './handler';

// 关键路径:Worker 全局 `self` 即宿主;`onmessage` 注册入口
self.onmessage = async (e: MessageEvent) => {
	const msg = e.data as WorkerRequest & { _requestId?: string };
	const requestId = msg._requestId;

	try {
		const response = await handleMessage(msg);
		if (requestId) {
			(response as Record<string, unknown>)._requestId = requestId;
		}
		self.postMessage(response);
	} catch (err) {
		// 修复:任何未捕获异常都返回结构化错误响应,主线程据此 reject Promise
		const errorResponse: WorkerResponse = {
			type: 'error',
			payload: {
				code: 'WORKER_ERROR',
				message: err instanceof Error ? err.message : String(err),
			},
		};
		if (requestId) {
			(errorResponse as Record<string, unknown>)._requestId = requestId;
		}
		self.postMessage(errorResponse);
	}
};
