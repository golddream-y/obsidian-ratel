/**
 * @file src/worker/manager.ts
 * @description Worker 线程的主线程侧管理 — 请求/响应关联 + 超时控制
 * @module worker/manager
 * @depends types
 */

import type { WorkerRequest, WorkerResponse } from '../types';

/**
 * 待响应请求的内部结构。
 *
 * - `resolve` / `reject`:Promise 控制器,收到响应时调用。
 * - `timer`:超时定时器句柄,用于在响应/销毁时清掉。
 */
interface PendingRequest {
	resolve: (response: WorkerResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Worker 请求默认超时 — 30s 适用于全量索引;W2 可针对单文件调整为更短。 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Worker 通信管理器。
 *
 * 设计要点:
 * - 把 `postMessage` 包成 Promise,调用方写 `await manager.request({...})` 即可。
 * - 用自增计数器 + 时间戳生成 `requestId`,把响应回绑到对应 Promise。
 * - 30 秒超时防止 Worker 假死把主线程 hang 住。
 * - `destroy()` 主动 terminate Worker,清空所有 pending Promise。
 *
 * @example
 *   const manager = new WorkerManager(worker);
 *   const res = await manager.request({ type: 'index.status', payload: {} });
 *   manager.destroy();
 */
export class WorkerManager {
	private pending = new Map<string, PendingRequest>();
	private requestCounter = 0;

	constructor(private worker: Worker) {
		this.worker.onmessage = (e: MessageEvent) => {
			const data = e.data as WorkerResponse & { _requestId?: string };
			if (data._requestId) {
				const pending = this.pending.get(data._requestId);
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(data._requestId);
					const { _requestId, ...response } = data;
					void _requestId;
					pending.resolve(response as WorkerResponse);
				}
			}
		};

		this.worker.onerror = (e: ErrorEvent) => {
			// 关键路径:Worker 整个挂掉时,所有挂起的请求一并拒绝,避免永久悬挂。
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(new Error(`Worker error: ${e.message}`));
			}
		};
	}

	/**
	 * 向 Worker 发起请求并等待响应。
	 *
	 * @param req - WorkerRequest(不含 `_requestId`,由本方法注入)。
	 * @returns 异步解析为 WorkerResponse。
	 * @throws 请求超时时抛出;Worker 整体错误时所有挂起请求一并 reject。
	 */
	request(req: WorkerRequest): Promise<WorkerResponse> {
		return new Promise<WorkerResponse>((resolve, reject) => {
			const requestId = `req_${++this.requestCounter}_${Date.now()}`;
			const timer = setTimeout(() => {
				// 修复:超时清理必须在 map 中移除,避免悬挂 Promise 累积。
				this.pending.delete(requestId);
				reject(new Error(`Worker request timeout: ${req.type}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(requestId, { resolve, reject, timer });
			this.worker.postMessage({ ...req, _requestId: requestId });
		});
	}

	/**
	 * 销毁 Worker — 终止线程、拒绝所有挂起请求、清空状态。
	 *
	 * 关键路径:必须在插件 `onunload` 中调用,否则 Worker 进程残留。
	 */
	destroy(): void {
		this.worker.terminate();
		for (const [, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error('Worker destroyed'));
		}
		this.pending.clear();
	}
}
