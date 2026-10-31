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
import { isWorkerReadRequest, isWorkerStoreWriteRequest } from '../types';
import { handleMessage, cancelIndexRun, WorkerMessageLane } from './handler';
import { workerData } from 'worker_threads';

// 关键路径:Worker 启动时若有 workerData,立即初始化 embeddings 与索引。
// embeddings 对象不能跨线程序列化,必须在 Worker 线程内部构造。
// 当前 Obsidian 渲染进程不支持 Worker Threads,实际走 InlineWorker(主线程内运行),
// 因此 Worker 入口不再自己构造 embeddings;真正的 Worker Threads 场景需主线程后续扩展协议传入。
async function bootstrapWorker(): Promise<void> {
	// 关键路径:workerData 是 any(worker_threads),断言后访问避免 no-unsafe-member-access。
	const data = workerData as { indexDir?: string } | null | undefined;
	if (!data || typeof data.indexDir !== 'string') return;

	// 关键路径:此分支为未来扩展预留,当前 Obsidian 渲染进程不支持 Worker Threads(见 ADR-002)。
	// 所有 Worker 实际走 InlineWorker 模式(主线程模拟),不进入此分支。
	// 若未来 Obsidian 支持 Worker Threads,需在此实现 embeddings 注入:
	//   主线程需传入 modelDir + vocabContent,Worker 内部构造 EmbeddingOnnx。
	throw new Error(
		'Worker Threads 路径不可达:当前 Obsidian 不支持 Worker Threads,请使用 InlineWorker 模式',
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
		// 关键路径(T5):与 InlineWorker 共用分道规则 —— 索引串行、只读并行(提交窗口内延后)、
		// 取消越过队列立即生效。
		const lane = new WorkerMessageLane();
		const handle = async (msg: WorkerRequest & { _requestId?: string }): Promise<void> => {
			const requestId = msg._requestId;
			const isRead = isWorkerReadRequest(msg.type);
			// 关键路径(B1):整个请求就是一次存储事务的写请求没有 `persist` 活动通道,
			// 提交窗口由请求本身开启,并在请求结束时关闭。
			if (isWorkerStoreWriteRequest(msg.type)) lane.openCommitWindow();

			// 关键路径:进度、活动与终态都绑定所属请求 ID，主线程先按消息类型区分。
			const postEvent = (eventMsg: WorkerResponse) => {
				if (!isRead) lane.observeEvent(eventMsg);
				const forwarded = eventMsg.type === 'index.activity' ? eventMsg : { ...eventMsg, _requestId: requestId };
				self.postMessage(forwarded);
			};

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
			finally {
				if (!isRead) lane.closeCommitWindow();
			}
		};

		self.onmessage = (e: MessageEvent) => {
			const msg = e.data as WorkerRequest & { _requestId?: string };
			if (msg.type === 'index.cancel') {
				// 关键路径:取消不能在索引串行队列尾部排队。
				const cancelled = cancelIndexRun(msg.payload);
				self.postMessage({ type: 'index.cancel.done', payload: { cancelled } });
				return;
			}
			const task = (): Promise<void> => handle(msg).catch(() => { /* 单条消息失败不能阻断后续消息 */ });
			if (isWorkerReadRequest(msg.type)) lane.scheduleRead(task);
			else lane.scheduleIndex(task);
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
