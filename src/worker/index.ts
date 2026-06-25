/**
 * @file src/worker/index.ts
 * @description Worker 线程入口 — 接收主线程消息并委托给 handler
 * @module worker/index
 * @depends types, ./handler, worker_threads
 *
 * 硬约束:
 * - 严禁 `import 'obsidian'`
 * - 不发 HTTP 请求(Embedding / LLM 调用都在主线程)
 * - 与主线程通过 `postMessage` 单向通信
 * - Worker 启动时从 workerData 读取 indexDir + embeddings 配置,自行初始化 embeddings
 */

import type { WorkerRequest, WorkerResponse } from '../types';
import { handleMessage } from './handler';
import { workerData } from 'worker_threads';

// 关键路径:Worker 启动时若有 workerData,立即初始化 embeddings 与索引。
// embeddings 对象不能跨线程序列化,必须在 Worker 线程内部构造。
// 当前 Obsidian 渲染进程不支持 Worker Threads,实际走 InlineWorker(主线程内运行),
// 因此 Worker 入口不再自己构造 embeddings;真正的 Worker Threads 场景需主线程后续扩展协议传入。
async function bootstrapWorker(): Promise<void> {
	if (!workerData || typeof workerData.indexDir !== 'string') return;

	// 关键路径:若未来 Worker Threads 可用,需要主线程传入 modelDir + vocabPath 才能构造 EmbeddingOnnx。
	// 目前直接抛出明确错误,避免静默失败。
	throw new Error(
		'Worker Threads 场景下暂未实现 embeddings 注入,请使用 InlineWorker 模式',
	);
}

/**
 * 构造一个无论收到什么请求都返回固定错误的 onmessage 处理函数。
 * 用于 bootstrap 失败兜底,避免主线程请求永远悬挂。
 *
 * @param errorMessage - 返回给主线程的错误文本。
 * @returns onmessage 处理函数。
 */
function createErrorHandler(errorMessage: string): (e: MessageEvent) => void {
	return (e: MessageEvent) => {
		const msg = e.data as WorkerRequest & { _requestId?: string };
		const errorResponse: WorkerResponse = {
			type: 'error',
			payload: {
				code: 'WORKER_INIT_FAILED',
				message: errorMessage,
			},
		};
		if (msg._requestId) {
			(errorResponse as Record<string, unknown>)._requestId = msg._requestId;
		}
		self.postMessage(errorResponse);
	};
}

// 关键路径:先启动,再注册 onmessage;避免消息在 bootstrap 完成前到达。
// bootstrap 失败时也要注册一个返回错误的 onmessage,防止主线程请求悬挂。
void bootstrapWorker().then(
	() => {
		self.onmessage = async (e: MessageEvent) => {
			const msg = e.data as WorkerRequest & { _requestId?: string };
			const requestId = msg._requestId;

			// 关键路径:postEvent 直接转发到 self.postMessage,进度事件不带 _requestId,
			// 主线程 WorkerManager 会自动区分请求响应(requestId)和事件(无 requestId)。
			const postEvent = (eventMsg: WorkerResponse) => self.postMessage(eventMsg);

			try {
				const response = await handleMessage(msg, postEvent);
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
	},
	(err) => {
		const message = err instanceof Error ? err.message : String(err);
		const errorResponse: WorkerResponse = {
			type: 'error',
			payload: {
				code: 'WORKER_INIT_FAILED',
				message,
			},
		};
		self.postMessage(errorResponse);
		self.onmessage = createErrorHandler(message);
	},
);
