/**
 * @file src/worker/index.ts
 * @description Worker 线程入口 — 接收主线程消息并委托给 handler
 * @module worker/index
 * @depends types, ./handler, worker_threads, @huggingface/transformers
 *
 * 硬约束:
 * - 严禁 `import 'obsidian'`
 * - 不发 HTTP 请求(Embedding / LLM 调用都在主线程)
 * - 与主线程通过 `postMessage` 单向通信
 * - Worker 启动时从 workerData 读取 indexDir + modelId,自行初始化 embeddings
 */

import type { WorkerRequest, WorkerResponse } from '../types';
import { handleMessage, initProcessor } from './handler';
import { workerData } from 'worker_threads';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';

// 关键路径:Worker 启动时若有 workerData,立即初始化 embeddings 与索引。
// embeddings 对象不能跨线程序列化,必须在 Worker 线程内部构造。
async function bootstrapWorker(): Promise<void> {
	if (!workerData || typeof workerData.indexDir !== 'string') return;
	if (typeof workerData.modelId !== 'string' || workerData.modelId.length === 0) return;

	const { indexDir, modelId } = workerData as { indexDir: string; modelId: string };

	// 关键路径:外部化(external)的 transformers,运行时由 Worker 线程自己 require。
	const { pipeline } = await import('@huggingface/transformers');
	const extractor = (await pipeline('feature-extraction', modelId, {
		dtype: 'q8',
	})) as (texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;

	const embeddings: EmbeddingsModel = {
		maxTokens: 8192,
		async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
			const arr = Array.isArray(inputs) ? inputs : [inputs];
			const output = await extractor(arr, { pooling: 'mean', normalize: true });
			return { status: 'success', output: output.tolist() };
		},
	};

	initProcessor(indexDir, embeddings);
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
