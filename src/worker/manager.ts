/**
 * @file src/worker/manager.ts
 * @description Worker 请求关联、活动超时与共享索引写通道
 * @module worker/manager
 * @depends types
 */
import type { WorkerRequest, WorkerResponse } from '../types';
import { tNow } from '../i18n';
export interface WorkerLike {
	postMessage(message: unknown): void;
	on(event: 'message', listener: (data: WorkerResponse & {
		_requestId?: string;
	}) => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'exit', listener: (code: number) => void): void;
	terminate(): void;
}
interface PendingRequest {
	resolve: (response: WorkerResponse) => void;
	reject: (error: Error) => void;
	timer: number;
	timedOut: boolean;
	activityTimeout: boolean;
	lastDone: number;
	arm: () => void;
}
interface QueuedOperation {
	start: () => void;
	reject: (error: Error) => void;
}
/** 默认十分钟无进展才超时；普通请求仍使用固定超时。 */
const REQUEST_TIMEOUT_MS = 600_000;
export interface WorkerManagerOptions {
	timeoutMs?: number;
	onProgress?: (done: number, total: number) => void;
}
/**
 * 共享索引的串行入口。超时只结束调用方等待，底层写入占用直到真实终态才释放。
 * stalled 期间拒绝后续调用，避免无法中断的任务使排队 Promise 永久挂起。
 */
export class WorkerManager {
	private pending = new Map<string, PendingRequest>();
	private queue: QueuedOperation[] = [];
	private busy = false;
	private stalled = false;
	private closed = false;
	private requestCounter = 0;
	private timeoutMs: number;
	private onProgress?: (done: number, total: number) => void;
	private activeExclusiveReject?: (error: Error) => void;

	constructor(private worker: WorkerLike, options: WorkerManagerOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.onProgress = options.onProgress;
		worker.on('message', data => {
			const pending = data._requestId ? this.pending.get(data._requestId) : undefined;
			// 修复:进度同样携带请求 ID，但永远不能当成最终响应。
			if (data.type === 'index.progress') {
				if (pending && !pending.timedOut && pending.activityTimeout &&
					Number.isInteger(data.payload.done) && Number.isInteger(data.payload.total) &&
					data.payload.done > pending.lastDone && data.payload.total > 0 && data.payload.done <= data.payload.total) {
					pending.lastDone = data.payload.done;
					pending.arm();
					this.onProgress?.(data.payload.done, data.payload.total);
				}
				return;
			}
			if (!pending || !data._requestId)
				return;
			window.clearTimeout(pending.timer);
			this.pending.delete(data._requestId);
			const { _requestId, ...response } = data;
			void _requestId;
			if (!pending.timedOut)
				pending.resolve(response);
			this.stalled = false;
			this.release();
		});
		worker.on('error', error => this.close(new Error(`Worker error: ${error.message}`)));
		worker.on('exit', code => this.close(new Error(`Worker exited with code ${code}`)));
	}

	/** 发出请求；排队时间不计入执行超时，索引请求按所属进度续期。 */
	request(req: WorkerRequest): Promise<WorkerResponse> {
		return new Promise((resolve, reject) => {
			this.enqueue({
				reject,
				start: () => {
					const requestId = `req_${++this.requestCounter}_${Date.now()}`;
					const pending: PendingRequest = {
						resolve, reject, timer: 0, timedOut: false, lastDone: 0,
						activityTimeout: req.type === 'index.full' || req.type === 'index.batch' || req.type === 'index.incremental',
						arm: () => {
							window.clearTimeout(pending.timer);
							pending.timer = window.setTimeout(() => {
								pending.timedOut = true;
								this.stalled = true;
								const error = new Error(`Worker request timeout: ${req.type}`);
								reject(error);
								// 关键路径:仍保留 pending 和 busy；迟到终态只解锁，不报告成功。
								this.rejectQueue(error);
							}, this.timeoutMs);
						},
					};
					this.pending.set(requestId, pending);
					pending.arm();
					try {
						this.worker.postMessage({ ...req, _requestId: requestId });
					}
					catch (err) {
						window.clearTimeout(pending.timer);
						this.pending.delete(requestId);
						reject(err instanceof Error ? err : new Error(String(err)));
						this.release();
					}
				},
			});
		});
	}

	/** 将直接访问共享索引的操作（如 dropIndex）纳入同一通道；回调不可递归 request。 */
	runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			this.enqueue({
				reject,
				start: () => {
					this.activeExclusiveReject = reject;
					void (async () => {
						try {
							resolve(await operation());
						}
						catch (err) {
							reject(err instanceof Error ? err : new Error(String(err)));
						}
						finally {
							this.activeExclusiveReject = undefined;
							this.release();
						}
					})();
				},
			});
		});
	}

	/** 动态绑定索引进度。 */
	setProgressCallback(cb: (done: number, total: number) => void): void {
		this.onProgress = cb;
	}

	/** 清除本轮展示回调。 */
	clearProgressCallback(): void {
		this.onProgress = undefined;
	}

	/** 卸载时拒绝全部调用并清理计时器与监听器。 */
	destroy(): void {
		this.close(new Error('Worker destroyed'));
		this.worker.terminate();
	}
	private enqueue(operation: QueuedOperation): void {
		if (this.closed || this.stalled) {
			operation.reject(new Error(this.closed ? 'Worker destroyed' : tNow('notice.indexStillRunning')));
			return;
		}
		if (this.busy)
			this.queue.push(operation);
		else {
			this.busy = true;
			operation.start();
		}
	}
	private release(): void {
		this.busy = false;
		if (this.closed || this.stalled)
			return;
		const next = this.queue.shift();
		if (next) {
			this.busy = true;
			next.start();
		}
	}
	private rejectQueue(error: Error): void {
		for (const operation of this.queue.splice(0))
			operation.reject(error);
	}
	private close(error: Error): void {
		this.closed = true;
		this.onProgress = undefined;
		for (const pending of this.pending.values()) {
			window.clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.activeExclusiveReject?.(error);
		this.rejectQueue(error);
	}
}
