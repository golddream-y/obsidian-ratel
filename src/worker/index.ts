/**
 * @file src/worker/index.ts
 * @description Worker 线程入口 — CPU 密集型任务(分块、向量计算)的消息分发
 * @module worker/index
 * @depends types
 *
 * 硬约束:
 * - 严禁 `import 'obsidian'`
 * - 不发 HTTP 请求(Embedding / LLM 调用都在主线程)
 * - 与主线程通过 `postMessage` 单向通信
 */

import type { WorkerRequest, WorkerResponse } from '../types';

// 关键路径:Worker 全局 `self` 即宿主;`onmessage` 注册入口。
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
		// 修复:任何未捕获异常都返回结构化错误响应,主线程据此 reject Promise。
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

/**
 * 消息分发 — 按 `msg.type` 路由到对应处理器。
 *
 * W1 阶段:仅 `index.status` 返回硬编码占位响应,其余返回 `NOT_IMPLEMENTED`。
 * W2 阶段:vectra 索引、文本分块、向量计算接入。
 *
 * @param msg - 主线程发来的请求(含可选 `_requestId`)。
 * @returns 异步响应载荷。
 */
async function handleMessage(msg: WorkerRequest & { _requestId?: string }): Promise<WorkerResponse> {
	switch (msg.type) {
		case 'index.status': {
			return {
				type: 'index.status.result',
				payload: { totalDocs: 0, lastIndexTime: 0 },
			};
		}

		case 'index.full':
		case 'index.incremental':
		case 'index.delete':
		case 'vector.search':
		case 'vector.upsert':
		case 'vector.delete': {
			// 占位:W2 接入 vectra 后替换为真实实现。
			return {
				type: 'error',
				payload: {
					code: 'NOT_IMPLEMENTED',
					message: `${msg.type} will be implemented in W2`,
				},
			};
		}

		default: {
			return {
				type: 'error',
				payload: {
					code: 'UNKNOWN_REQUEST',
					message: `Unknown request type: ${(msg as WorkerRequest).type}`,
				},
			};
		}
	}
}
