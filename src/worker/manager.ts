/**
 * @file src/worker/manager.ts
 * @description Worker 线程的主线程侧管理 — 请求/响应关联 + 超时控制 + 事件分发
 * @module worker/manager
 * @depends types
 */

import type { WorkerRequest, WorkerResponse } from '../types';

/**
 * 与 WorkerManager 兼容的 Worker 抽象接口。
 *
 * 设计要点:
 * - 同时适配 Node.js Worker Threads 和 InlineWorker(主线程内模拟)。
 * - Obsidian 渲染进程不支持 Worker Threads,InlineWorker 作为降级实现。
 */
export interface WorkerLike {
	postMessage(message: unknown): void;
	on(event: 'message', listener: (data: WorkerResponse & { _requestId?: string }) => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'exit', listener: (code: number) => void): void;
	terminate(): void;
}

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

/** Worker 请求默认超时 — 10 分钟;WASM 推理 + 全量索引在主线程可能很慢。 */
const REQUEST_TIMEOUT_MS = 600_000;

/**
 * WorkerManager 构造选项。
 *
 * - `timeoutMs`:请求超时毫秒数,默认 600_000(10 分钟)。超时后 reject Promise 但不 terminate Worker。
 * - `onProgress`:索引进度回调,Worker 推送 `index.progress` 事件时触发(无 _requestId 的广播消息)。
 */
export interface WorkerManagerOptions {
	timeoutMs?: number;
	onProgress?: (done: number, total: number) => void;
}

/**
 * Worker 通信管理器。
 *
 * 设计要点:
 * - 把 `postMessage` 包成 Promise,调用方写 `await manager.request({...})` 即可。
 * - 用自增计数器 + 时间戳生成 `requestId`,把响应回绑到对应 Promise。
 * - 10 分钟超时防止 Worker 假死把主线程 hang 住;超时只 reject 当前请求,不 terminate Worker
 *   (InlineWorker 在主线程执行 ONNX 推理,无法真正中断,terminate 会清空监听器导致永久失效)。
 * - Worker 主动推送的事件消息(无 _requestId,如 `index.progress`)通过 `onProgress` 回调分发。
 * - `destroy()` 主动 terminate Worker,清空所有 pending Promise。
 *
 * @example
 *   const manager = new WorkerManager(worker, { onProgress: (d, t) => devLogger.info('worker', `${d}/${t}`) });
 *   const res = await manager.request({ type: 'index.status', payload: {} });
 *   manager.destroy();
 */
export class WorkerManager {
	private pending = new Map<string, PendingRequest>();
	private requestCounter = 0;
	private timeoutMs: number;
	private onProgress?: (done: number, total: number) => void;

	constructor(private worker: WorkerLike, options: WorkerManagerOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.onProgress = options.onProgress;
		// 关键路径:Node Worker Threads 通过 'message' 事件返回数据,数据本身就是响应对象。
		this.worker.on('message', (data: WorkerResponse & { _requestId?: string }) => {
			// 关键路径:无 _requestId 的消息是 Worker 主动推送的事件(如 index.progress),
			// 不是对某个请求的响应,派发到事件回调。
			if (!data._requestId) {
				if (data.type === 'index.progress' && this.onProgress) {
					this.onProgress(data.payload.done, data.payload.total);
				}
				return;
			}

			const pending = this.pending.get(data._requestId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(data._requestId);
				const { _requestId, ...response } = data;
				void _requestId;
				pending.resolve(response as WorkerResponse);
			}
		});

		this.worker.on('error', (err: Error) => {
			// 关键路径:Worker 整个挂掉时,所有挂起的请求一并拒绝,避免永久悬挂。
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(new Error(`Worker error: ${err.message}`));
			}
		});

		this.worker.on('exit', (code: number) => {
			// 关键路径:Worker 进程异常退出(如崩溃或 process.exit)时不一定先触发 'error',
			// 必须拒绝所有挂起请求,避免调用方永远等待。
			for (const [id, pending] of this.pending) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(new Error(`Worker exited with code ${code}`));
			}
		});
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
				// 关键路径:超时仅 reject 当前请求,不 terminate Worker。
				// 原因:InlineWorker 在主线程执行 ONNX 推理,无法真正中断;
				// terminate 会清空监听器导致后续所有请求永久失败。
				// 真正的 Worker Threads 若挂死,用户可通过 reload 插件恢复。
				this.pending.delete(requestId);
				reject(new Error(`Worker request timeout: ${req.type}`));
			}, this.timeoutMs);
			this.pending.set(requestId, { resolve, reject, timer });
			this.worker.postMessage({ ...req, _requestId: requestId });
		});
	}

	/**
	 * 更新进度回调(用于在请求发起后动态绑定)。
	 */
	setProgressCallback(cb: (done: number, total: number) => void): void {
		this.onProgress = cb;
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
