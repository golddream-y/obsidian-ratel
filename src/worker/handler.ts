/**
 * @file src/worker/handler.ts
 * @description Worker 消息分发 — 纯函数,与 self.onmessage 解耦便于单测
 * @module worker/handler
 * @depends types
 *
 * 设计要点:与 self.onmessage 解耦,便于单元测试。
 * 任何 W1/W2/W3+ 阶段新增的请求类型都在此处的 switch 里加 case。
 */

import type { WorkerRequest, WorkerResponse } from '../types';

/**
 * 处理主线程发来的 Worker 请求。
 *
 * @param msg - 含可选 `_requestId` 的请求
 * @returns 对应的响应载荷;未识别的请求类型返回 UNKNOWN_REQUEST 错误
 */
export async function handleMessage(
	msg: WorkerRequest & { _requestId?: string },
): Promise<WorkerResponse> {
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
			// 占位:W2 接入 vectra 后替换为真实实现
			return {
				type: 'error',
				payload: {
					code: 'NOT_IMPLEMENTED',
					message: `${msg.type} will be implemented in W2`,
				},
			};
		}

		default: {
			// 关键路径:未知 type 必须返回结构化错误而不是 throw,主线程
			// 才能在 catch 之外识别并 reject
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
