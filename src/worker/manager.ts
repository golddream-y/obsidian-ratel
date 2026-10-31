/**
 * @file src/worker/manager.ts
 * @description Worker 请求关联、活动/停滞看护、取消与共享索引写通道
 * @module worker/manager
 * @depends types, core/index-persistence-types, i18n
 *
 * 设计要点(T5 §4):
 * - 索引任务不依赖单条请求的 Promise 存活:无有效活动达到阈值只结束**调用方的等待**,
 *   pending 与写保护继续保留;迟到的真实终态经 `onLateTerminal` 交付,提交路径不被丢弃。
 * - 活动只认 `index.activity`(`IndexActivity.sequence` 单调递增,来自真实完成的批次/IO 步骤);
 *   `index.progress` 仍是 UI 进度,不恢复停滞,Worker 存活消息更不算活动。
 * - 写通道(索引/写入/`runExclusive`)与只读通道分离:长推理不再阻塞查询,
 *   但只读请求不得穿过提交窗口,写通道在停滞期间继续拒绝新调用。
 * - 取消:撤销单项任务并按真实失败结束调用方的等待,不终止共享 Worker;
 *   永久挂起只由显式的 `resetRuntime()` 整个运行时重置处理,所有受影响调用按真实失败结束。
 * - 跨 Worker 不传函数或 `AbortSignal`:活动与取消都经消息表达。
 *
 * 归属边界:T5 只提供状态与终态语义;用户可见文案与 i18n 映射归 T7。
 */
import type { IndexActivity } from '../core/index-persistence-types';
import { isIndexActivity } from '../core/index-persistence-types';
import { isWorkerIndexRequest, isWorkerReadRequest, isWorkerStoreWriteRequest, type WorkerRequest, type WorkerResponse } from '../types';
import { tNow } from '../i18n';
import { devLogger } from '../logging/dev-logger';

export interface WorkerLike {
	postMessage(message: unknown): void;
	on(event: 'message', listener: (data: WorkerResponse & {
		_requestId?: string;
	}) => void): void;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'exit', listener: (code: number) => void): void;
	terminate(): void;
}

/**
 * 可控时钟接缝 — 停滞阈值与请求超时都建立在它上面。
 *
 * 关键路径:时间相关行为必须能被可控时钟驱动,不能依赖真实 `setTimeout` 赛跑。
 */
export interface WorkerManagerClock {
	/** 设定一次性定时器。 */
	setTimeout(handler: () => void, timeoutMs: number): unknown;
	/** 取消定时器。 */
	clearTimeout(handle: unknown): void;
}

/** 默认时钟 — 与既有实现一致,走 `window` 定时器(测试环境由 polyfill 指向 `globalThis`)。 */
const systemClock: WorkerManagerClock = {
	setTimeout: (handler, timeoutMs) => window.setTimeout(handler, timeoutMs),
	clearTimeout: (handle) => window.clearTimeout(handle as number),
};

/**
 * 管理器错误码 — 稳定判别式,供 T7 映射用户可见文案;消息本身是中文开发向文案。
 */
export const WORKER_MANAGER_ERROR_CODES = [
	'index-stalled',
	'index-cancelled',
	'runtime-reset',
	'worker-destroyed',
	'request-blocked',
	'request-timeout',
] as const;

/** 管理器错误码。 */
export type WorkerManagerErrorCode = (typeof WORKER_MANAGER_ERROR_CODES)[number];

/** 诊断细节 — 只放阶段/数量/时长,绝不放正文、向量、路径或密钥。 */
export interface WorkerManagerErrorDetail {
	requestId?: string;
	taskId?: string | null;
	epoch?: number;
	/** 最后一次有效活动。 */
	lastActivity?: IndexActivity | null;
	/** 停滞 / 超时时长。 */
	elapsedMs?: number;
}

/** 管理器抛出的结构化错误。 */
export class WorkerManagerError extends Error {
	/** 稳定错误码。 */
	readonly code: WorkerManagerErrorCode;
	/** 诊断细节(不含正文/向量/路径/密钥)。 */
	readonly detail: WorkerManagerErrorDetail;

	constructor(code: WorkerManagerErrorCode, message: string, detail: WorkerManagerErrorDetail = {}) {
		super(message);
		this.name = 'WorkerManagerError';
		this.code = code;
		this.detail = detail;
	}
}

/** 停滞诊断 — 阶段、持续时间与已完成数量。 */
export interface IndexRequestStallInfo {
	/** 请求标识。 */
	requestId: string;
	/** 任务标识;无任务身份时为 null。 */
	taskId: string | null;
	/** 任务 epoch。 */
	epoch: number;
	/** 请求类型。 */
	type: string;
	/** 最后一次有效活动;从未有活动时为 null。 */
	lastActivity: IndexActivity | null;
	/** 判定时的无活动时长下界(等于判定阈值;看护不依赖墙上时钟)。 */
	stalledMs: number;
	/** 判定阈值。 */
	timeoutMs: number;
}

/** 恢复诊断 — 迟到有效活动让任务回到处理中。 */
export interface IndexRequestResumeInfo extends IndexRequestStallInfo {
	/** 触发恢复的活动。 */
	activity: IndexActivity;
}

interface PendingRequest {
	requestId: string;
	type: WorkerRequest['type'];
	taskId: string | null;
	epoch: number;
	isRead: boolean;
	resolve: (response: WorkerResponse) => void;
	reject: (error: Error) => void;
	timer: unknown;
	/** 调用方的等待已结束(停滞/取消/重置);真实终态改为交付 onLateTerminal。 */
	waiterSettled: boolean;
	/** 当前是否处于停滞;迟到的有效活动可清除它,之后仍可再次判定停滞。 */
	stalled: boolean;
	/** 索引请求:按有效活动续期。 */
	activityTimeout: boolean;
	/** 最近一次已展示/已确认的文件进度。 */
	lastDone: number;
	/** 最近一次已接受的活动序号。 */
	lastActivitySequence: number;
	/** 该请求已上报的完成提交数 — 用于区分「提交开始」与「提交完成」(建议 2)。 */
	lastCommitUnits: number;
	/** 最近一次已接受的活动。 */
	lastActivity: IndexActivity | null;
	/** 迟到终态回调 — 提交路径不因超时被丢弃。 */
	onLateTerminal?: (response: WorkerResponse) => void;
	/** 摘除调用方 `signal` 上的 abort 监听。 */
	detachAbort?: () => void;
	/** 重新武装无活动超时。 */
	arm: () => void;
}

interface QueuedOperation {
	start: () => void;
	reject: (error: Error) => void;
}

/** 等待派发的只读请求 — 排队等待同样有界。 */
interface QueuedRead {
	requestId: string;
	type: WorkerRequest['type'];
	/** 派发:把排队阶段就已经武装的定时器移交给 pending。 */
	send: () => void;
	reject: (error: Error) => void;
	timer: unknown;
	dispatched: boolean;
	settled: boolean;
	/** 摘除调用方 `signal` 上的 abort 监听(派发或结算后必须摘除,见 I1)。 */
	detachAbort?: () => void;
}

/** 主线程侧的请求选项。 */
export interface WorkerRequestOptions {
	/**
	 * 迟到终态回调 — 调用方等待已因停滞/取消结束后,真实终态仍在此交付一次。
	 *
	 * 关键路径:索引任务的提交路径不能因为没有调用方等待而消失。
	 */
	onLateTerminal?: (response: WorkerResponse) => void;
	/**
	 * 主线程侧取消信号 — 管理器把它转成 `index.cancel` 消息,
	 * `AbortSignal` 本身不跨 Worker 传递。
	 */
	signal?: AbortSignal;
	/** 任务标识;省略时由管理器生成。 */
	taskId?: string;
	/** 写所有权 epoch;省略时按 0 处理(0 表示不校验 epoch)。 */
	epoch?: number;
}

/** 默认十分钟无进展才判定停滞;普通查询仍使用固定超时。 */
const REQUEST_TIMEOUT_MS = 600_000;

/**
 * 活动序号单步推进上界 — Worker 每条真实完成步骤只 +1。
 *
 * 关键路径(建议 3):允许的推进幅度必须有界,否则一条畸形大序号会把 watermark
 * 推到该任务后续合法活动永远追不上的位置,等于永久屏蔽这个任务。
 */
const MAX_ACTIVITY_SEQUENCE_JUMP = 1024;

export interface WorkerManagerOptions {
	timeoutMs?: number;
	onProgress?: (done: number, total: number) => void;
	/** 时钟接缝;默认 `window` 定时器。 */
	clock?: WorkerManagerClock;
	/** 每条被接受的活动上报一次(诊断与状态同步)。 */
	onActivity?: (activity: IndexActivity) => void;
	/** 无有效活动达到阈值时回调一次。 */
	onStall?: (info: IndexRequestStallInfo) => void;
	/** 迟到有效活动让任务回到处理中时回调一次。 */
	onResume?: (info: IndexRequestResumeInfo) => void;
}

/**
 * 共享索引的串行入口。写通道超时只结束调用方等待,底层写入占用直到真实终态才释放;
 * 只读通道与写通道分离,但不得穿过提交窗口;停滞期间拒绝新的写调用,避免无法中断的任务
 * 使排队 Promise 永久挂起。
 */
export class WorkerManager {
	private pending = new Map<string, PendingRequest>();
	/** 任务标识 → 请求标识 — 活动包按 taskId 归属。 */
	private pendingByTask = new Map<string, string>();
	private queue: QueuedOperation[] = [];
	private readQueue: QueuedRead[] = [];
	private busy = false;
	private readBusy = false;
	private stalled = false;
	private closed = false;
	private requestCounter = 0;
	private taskCounter = 0;
	/** 真实持久化 IO 正在进行 — 只读请求不得穿过。 */
	private commitWindowOpen = false;
	/** 独占操作(如 dropIndex)正在进行 — 同样不得被只读请求穿过。 */
	private exclusiveActive = false;
	/** 独占操作的真实执行尚未结束(与调用方等待是否已结束无关,见 B2)。 */
	private exclusiveRunning = false;
	/** 运行时重置次数(诊断)。 */
	private runtimeResets = 0;
	private timeoutMs: number;
	private readonly clock: WorkerManagerClock;
	private onProgress?: (done: number, total: number) => void;
	private readonly onActivity?: (activity: IndexActivity) => void;
	private readonly onStall?: (info: IndexRequestStallInfo) => void;
	private readonly onResume?: (info: IndexRequestResumeInfo) => void;
	private activeExclusiveReject?: (error: Error) => void;

	constructor(private worker: WorkerLike, options: WorkerManagerOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.clock = options.clock ?? systemClock;
		this.onProgress = options.onProgress;
		this.onActivity = options.onActivity;
		this.onStall = options.onStall;
		this.onResume = options.onResume;
		worker.on('message', data => this.handleMessage(data));
		worker.on('error', error => this.close(new Error(`Worker error: ${error.message}`)));
		worker.on('exit', code => this.close(new Error(`Worker exited with code ${code}`)));
	}

	/**
	 * 发出请求;排队时间不计入执行超时,索引请求按有效活动续期。
	 *
	 * @param req - Worker 请求。
	 * @param options - 可选迟到终态回调、取消信号与任务身份。
	 * @returns Worker 响应。
	 */
	request(req: WorkerRequest, options: WorkerRequestOptions = {}): Promise<WorkerResponse> {
		if (isWorkerReadRequest(req.type)) return this.requestRead(req, options);
		return new Promise((resolve, reject) => {
			this.enqueue({
				reject,
				start: () => this.startWriteRequest(req, options, resolve, reject),
			});
		});
	}

	/** 将直接访问共享索引的操作（如 dropIndex）纳入同一写通道；回调不可递归 request。 */
	runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			this.enqueue({
				reject,
				start: () => {
					this.activeExclusiveReject = reject;
					// 关键路径:独占操作期间只读请求不得派发(可能正在替换存储视图)。
					this.exclusiveActive = true;
					// 关键路径(B2):`exclusiveRunning` 只在真实结束时清除 —— 重置运行时
					// 结束的是调用方的等待,不是这次存储操作本身。
					this.exclusiveRunning = true;
					void (async () => {
						try {
							resolve(await operation());
						}
						catch (err) {
							reject(err instanceof Error ? err : new Error(String(err)));
						}
						finally {
							this.activeExclusiveReject = undefined;
							this.exclusiveRunning = false;
							this.exclusiveActive = false;
							this.release();
							this.flushReadQueue();
						}
					})();
				},
			});
		});
	}

	/**
	 * 取消单项索引任务。
	 *
	 * 关键路径:立即按真实失败结束调用方的等待(不留永不结束的 Promise),
	 * 同时向 Worker 发 `index.cancel` 让它在批次边界停止;写保护保留到真实终态,
	 * 且**不终止共享 Worker** —— 其他查询继续可用。
	 *
	 * 关键路径(建议 1):只读请求的取消必须同步释放只读通道,否则 worker 永久挂起时
	 * 后续查询只能各自超时。
	 *
	 * @param target - 按请求 ID / 任务 ID / epoch 定位;全为 undefined 时不做任何事。
	 * @returns 是否命中一个在途任务。
	 */
	cancelIndex(target: { requestId?: string; taskId?: string; epoch?: number; reason?: string }): boolean {
		if (target.requestId === undefined && target.taskId === undefined && target.epoch === undefined) return false;
		const pending = this.findPending(target);
		if (pending === undefined) return false;
		if (!pending.waiterSettled) {
			pending.waiterSettled = true;
			pending.reject(new WorkerManagerError(
				'index-cancelled',
				target.reason ?? `索引任务已取消:${pending.type}`,
				{ requestId: pending.requestId, taskId: pending.taskId, epoch: pending.epoch, lastActivity: pending.lastActivity },
			));
		}
		this.clearTimer(pending);
		pending.detachAbort?.();
		pending.detachAbort = undefined;
		if (pending.isRead) {
			// 关键路径(建议 1):取消即终态 —— 摘除 pending 并释放只读通道,不留占位。
			this.pending.delete(pending.requestId);
			this.forgetTaskId(pending);
			this.readBusy = false;
			this.flushReadQueue();
			return true;
		}
		// 关键路径:取消经消息表达,AbortSignal 不跨 Worker 传递。
		this.worker.postMessage({
			type: 'index.cancel',
			payload: { requestId: pending.requestId, taskId: pending.taskId ?? undefined, epoch: pending.epoch },
		});
		return true;
	}

	/**
	 * 整个索引运行时重置 — 永久挂起时的唯一出口。
	 *
	 * 关键路径:所有挂起调用(写通道、排队中、只读通道)按真实失败结束,不留永不结束的 Promise;
	 * 本方法不终止 Worker 实例,重新装配由调用方决定(T7)。
	 *
	 * @param reason - 诊断文案;不含路径、正文或密钥。
	 */
	resetRuntime(reason = '索引运行时已重置,受影响的调用按真实失败结束'): void {
		this.runtimeResets += 1;
		const error = new WorkerManagerError('runtime-reset', reason);
		for (const [requestId, pending] of [...this.pending]) {
			this.pending.delete(requestId);
			this.forgetTaskId(pending);
			this.clearTimer(pending);
			pending.detachAbort?.();
			pending.detachAbort = undefined;
			if (!pending.waiterSettled) {
				pending.waiterSettled = true;
				pending.reject(error);
			}
		}
		for (const queued of this.readQueue.splice(0)) {
			if (queued.settled) continue;
			queued.settled = true;
			queued.detachAbort?.();
			queued.detachAbort = undefined;
			this.clock.clearTimeout(queued.timer);
			queued.reject(error);
		}
		for (const operation of this.queue.splice(0)) operation.reject(error);
		// 关键路径(B2):已**启动**的独占操作(如 dropIndex)仍持有写通道与独占门。
		// 这里只结束调用方的等待(按真实失败),真实结束前保留 busy / exclusiveActive,
		// 否则新的写请求会与未结束的 dropIndex 并行进入同一份存储。
		const exclusiveInFlight = this.exclusiveRunning;
		if (exclusiveInFlight) {
			const rejectActiveExclusive = this.activeExclusiveReject;
			this.activeExclusiveReject = undefined;
			rejectActiveExclusive?.(error);
		}
		this.busy = exclusiveInFlight;
		this.readBusy = false;
		this.stalled = false;
		this.exclusiveActive = exclusiveInFlight;
		this.commitWindowOpen = false;
		devLogger.warn('worker', `索引运行时重置(第 ${this.runtimeResets} 次):${reason}`);
	}

	/** 是否处于停滞(无有效活动达到阈值)。 */
	isStalled(): boolean {
		return this.stalled;
	}

	/** 当前在途任务的诊断快照;无在途任务时为 null。不含正文/向量/路径。 */
	stallInfo(): IndexRequestStallInfo | null {
		for (const pending of this.pending.values()) {
			if (pending.isRead) continue;
			return this.describe(pending);
		}
		return null;
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

	// ==================== 消息处理 ====================

	/** 单条 Worker 消息的分流:活动 / 进度 / 终态。 */
	private handleMessage(data: WorkerResponse & { _requestId?: string }): void {
		// 关键路径:卸载后旧实例的消息不得再更新任何状态或回调(旧 UI 回调全部失效)。
		if (this.closed) return;
		if (data.type === 'index.activity') {
			this.handleActivity(data.payload);
			return;
		}
		if (data.type === 'index.progress') {
			this.handleProgress(data);
			return;
		}
		// 取消回执是纯诊断,调用方的等待已在 cancelIndex 里结束。
		if (data.type === 'index.cancel.done') return;
		const pending = data._requestId ? this.pending.get(data._requestId) : undefined;
		if (!pending || !data._requestId) return;
		this.finishPending(pending, data);
	}

	/**
	 * 处理活动包 — 只有单调递增的合法活动才算进展。
	 *
	 * 关键路径:非法/重复/旧 epoch 的活动一律忽略,不续期、不恢复停滞;
	 * 迟到的有效活动让任务回到处理中。
	 */
	private handleActivity(raw: unknown): void {
		if (!isIndexActivity(raw)) return;
		const pending = this.findPending({ requestId: raw.requestId, taskId: raw.taskId });
		if (pending === undefined) {
			// 归属不明(或任务已结算):只上报诊断,不影响任何计时。
			this.onActivity?.(raw);
			return;
		}
		// 关键路径:epoch 不一致的活动属于旧实例,不得更新新实例状态。
		if (pending.epoch !== 0 && raw.epoch !== pending.epoch) return;
		if (raw.sequence <= pending.lastActivitySequence) return;
		// 关键路径(建议 3):推进幅度必须有界 —— 一条畸形大序号若被接受,会把 watermark
		// 推高到该任务后续合法活动永远追不上的位置,等于永久屏蔽这个任务。
		if (raw.sequence - pending.lastActivitySequence > MAX_ACTIVITY_SEQUENCE_JUMP) {
			this.onActivity?.(raw);
			return;
		}
		pending.lastActivitySequence = raw.sequence;
		pending.lastActivity = raw;
		if (pending.stalled) {
			// 迟到有效活动:回到处理中,真实完成仍能提交并更新状态。
			pending.stalled = false;
			this.stalled = false;
			pending.arm();
			this.onResume?.({ ...this.describe(pending), activity: raw });
		}
		else if (pending.activityTimeout && !pending.waiterSettled) {
			pending.arm();
		}
		// 关键路径(建议 2):persist 活动的完成数未增长 = 本次提交开始(开窗);
		// 完成数增长 = 本次提交已落盘(关窗)。窗口因此由提交完成本身关闭,
		// 不再依赖「下一条非 persist 活动」或请求终态。
		if (raw.stage === 'persist') {
			if (raw.completedUnits > pending.lastCommitUnits) {
				pending.lastCommitUnits = raw.completedUnits;
				this.closeCommitWindow();
			}
			else {
				this.openCommitWindow();
			}
		}
		else {
			this.closeCommitWindow();
		}
		this.onActivity?.(raw);
	}

	/** 处理进度消息 — 仅 UI 展示与旧语义的续期,不恢复停滞。 */
	private handleProgress(data: WorkerResponse & { _requestId?: string }): void {
		const pending = data._requestId ? this.pending.get(data._requestId) : undefined;
		if (!pending || !data._requestId) return;
		if (data.type !== 'index.progress') return;
		// 修复:进度同样携带请求 ID，但永远不能当成最终响应。
		if (pending.waiterSettled || !pending.activityTimeout) return;
		if (
			Number.isInteger(data.payload.done) && Number.isInteger(data.payload.total) &&
			data.payload.done > pending.lastDone && data.payload.total > 0 && data.payload.done <= data.payload.total
		) {
			pending.lastDone = data.payload.done;
			pending.arm();
			this.onProgress?.(data.payload.done, data.payload.total);
		}
	}

	// ==================== 写通道 ====================

	/** 启动一条索引/写入请求。 */
	private startWriteRequest(
		req: WorkerRequest,
		options: WorkerRequestOptions,
		resolve: (response: WorkerResponse) => void,
		reject: (error: Error) => void,
	): void {
		const requestId = `req_${++this.requestCounter}_${Date.now()}`;
		const identity = readIndexIdentity(req);
		const taskId = options.taskId ?? identity?.taskId ?? `index_task_${++this.taskCounter}`;
		const epoch = options.epoch ?? identity?.epoch ?? 0;
		const outgoing = withIndexIdentity(req, taskId, epoch);
		const pending: PendingRequest = {
			requestId,
			type: req.type,
			taskId,
			epoch,
			isRead: false,
			resolve,
			reject,
			timer: null,
			waiterSettled: false,
			stalled: false,
			activityTimeout: isWorkerIndexRequest(req.type),
			lastDone: 0,
			lastActivitySequence: 0,
			lastCommitUnits: 0,
			lastActivity: null,
			onLateTerminal: options.onLateTerminal,
			arm: () => undefined,
		};
		pending.arm = () => this.armTimeout(pending);
		this.pending.set(requestId, pending);
		this.pendingByTask.set(taskId, requestId);
		this.bindAbort(pending, options.signal);
		pending.arm();
		// 关键路径(B1):整个请求就是一次存储事务的写请求(删除/写入)没有 `persist` 活动通道,
		// 提交窗口必须由请求自身开启,否则只读车道会穿过这些写事务。
		const storeWrite = isWorkerStoreWriteRequest(req.type);
		if (storeWrite) this.openCommitWindow();
		try {
			this.worker.postMessage({ ...outgoing, _requestId: requestId });
		}
		catch (err) {
			this.pending.delete(requestId);
			this.forgetTaskId(pending);
			this.clearTimer(pending);
			pending.detachAbort?.();
			pending.detachAbort = undefined;
			pending.waiterSettled = true;
			if (storeWrite) this.closeCommitWindow();
			reject(err instanceof Error ? err : new Error(String(err)));
			this.release();
		}
	}

	// ==================== 只读通道 ====================

	/** 启动一条只读请求 — 不排在长推理后面,但不得穿过提交窗口。 */
	private requestRead(req: WorkerRequest, options: WorkerRequestOptions): Promise<WorkerResponse> {
		return new Promise((resolve, reject) => {
			if (this.closed) {
				reject(new WorkerManagerError('worker-destroyed', 'Worker destroyed'));
				return;
			}
			const requestId = `req_${++this.requestCounter}_${Date.now()}`;
			const queued: QueuedRead = {
				requestId,
				type: req.type,
				send: () => undefined,
				reject,
				timer: null,
				dispatched: false,
				settled: false,
			};
			queued.send = () => this.startReadRequest(queued, req, options, resolve, reject);
			// 关键路径:普通查询必须有界 —— 排队等待与执行都受同一个上限约束。
			queued.timer = this.clock.setTimeout(() => this.handleReadTimeout(queued), this.timeoutMs);
			this.readQueue.push(queued);
			// 关键路径:排队期间也要尊重取消信号 —— 否则已取消的查询仍会在窗口关闭后被派发。
			this.bindReadAbort(queued, options.signal);
			if (options.signal?.aborted === true) return;
			this.flushReadQueue();
		});
	}

	/** 派发一条已放行的只读请求。 */
	private startReadRequest(
		queued: QueuedRead,
		req: WorkerRequest,
		options: WorkerRequestOptions,
		resolve: (response: WorkerResponse) => void,
		reject: (error: Error) => void,
	): void {
		const requestId = queued.requestId;
		// 关键路径(I1):派发即摘除排队期监听并标记已结算 —— 否则调用方 `signal` 上会残留一个
		// 永不触发的 abort 监听;执行期改由 pending 自己的句柄管理。
		queued.settled = true;
		queued.dispatched = true;
		queued.detachAbort?.();
		queued.detachAbort = undefined;
		const pending: PendingRequest = {
			requestId,
			type: req.type,
			taskId: options.taskId ?? null,
			epoch: options.epoch ?? 0,
			isRead: true,
			resolve,
			reject,
			timer: queued.timer,
			waiterSettled: false,
			stalled: false,
			activityTimeout: false,
			lastDone: 0,
			lastActivitySequence: 0,
			lastCommitUnits: 0,
			lastActivity: null,
			onLateTerminal: options.onLateTerminal,
			arm: () => undefined,
		};
		this.pending.set(requestId, pending);
		this.bindAbort(pending, options.signal);
		try {
			this.worker.postMessage({ ...req, _requestId: requestId });
		}
		catch (err) {
			this.pending.delete(requestId);
			this.clearTimer(pending);
			pending.detachAbort?.();
			pending.detachAbort = undefined;
			pending.waiterSettled = true;
			reject(err instanceof Error ? err : new Error(String(err)));
			this.readBusy = false;
			this.flushReadQueue();
		}
	}

	/** 绑定只读请求的取消信号 — 排队期间直接出队失败,已派发则走取消入口。 */
	private bindReadAbort(queued: QueuedRead, signal?: AbortSignal): void {
		if (signal === undefined) return;
		const onAbort = (): void => {
			if (queued.settled) return;
			const pending = this.pending.get(queued.requestId);
			if (pending !== undefined) {
				this.cancelIndex({ requestId: queued.requestId, reason: '调用方已取消查询' });
				return;
			}
			queued.settled = true;
			queued.detachAbort?.();
			queued.detachAbort = undefined;
			const index = this.readQueue.indexOf(queued);
			if (index >= 0) this.readQueue.splice(index, 1);
			this.clock.clearTimeout(queued.timer);
			queued.reject(new WorkerManagerError('index-cancelled', '调用方已取消查询', { requestId: queued.requestId }));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
		// 关键路径(I1):记录摘除句柄 —— 派发或结算时必须移除,否则监听会残留到调用方 `signal` 上。
		queued.detachAbort = () => signal.removeEventListener('abort', onAbort);
	}

	/** 只读请求排队超时:立即按真实失败结束,不让查询永久悬挂。 */
	private handleReadTimeout(queued: QueuedRead): void {
		// 关键路径(I1):已派发的请求由 pending 接管(其定时器就是这一个),不能因排队标记而跳过。
		const pending = this.pending.get(queued.requestId);
		if (pending !== undefined) {
			this.handleStall(pending);
			return;
		}
		if (queued.settled) return;
		queued.settled = true;
		queued.detachAbort?.();
		queued.detachAbort = undefined;
		const index = this.readQueue.indexOf(queued);
		if (index >= 0) this.readQueue.splice(index, 1);
		queued.reject(new WorkerManagerError('request-timeout', `只读请求排队超时:${queued.type}`));
	}

	/** 放行一条只读请求 — 提交窗口与独占操作期间不派发。 */
	private flushReadQueue(): void {
		if (this.closed || this.readBusy || this.commitWindowOpen || this.exclusiveActive) return;
		const queued = this.readQueue.shift();
		if (queued === undefined) return;
		if (queued.settled) {
			queued.detachAbort?.();
			queued.detachAbort = undefined;
			this.flushReadQueue();
			return;
		}
		this.readBusy = true;
		queued.send();
	}

	// ==================== 结算与超时 ====================

	/** 真实终态到达:正常 resolve,或(等待已结束)交付迟到终态回调。 */
	private finishPending(pending: PendingRequest, raw: WorkerResponse & { _requestId?: string }): void {
		// 关键路径:信封 `_requestId` 不进业务响应(与既有契约一致)。
		const { _requestId, ...response } = raw;
		void _requestId;
		this.pending.delete(pending.requestId);
		this.forgetTaskId(pending);
		this.clearTimer(pending);
		pending.detachAbort?.();
		pending.detachAbort = undefined;
		const late = pending.waiterSettled;
		pending.waiterSettled = true;
		pending.stalled = false;
		if (pending.isRead) {
			this.readBusy = false;
		}
		if (!late) {
			pending.resolve(response);
		}
		else if (pending.onLateTerminal !== undefined) {
			// 关键路径:迟到终态交付提交路径;回调异常不得吞掉通道释放。
			try {
				pending.onLateTerminal(response);
			}
			catch (error) {
				devLogger.warn('worker', '迟到终态回调失败', error);
			}
		}
		if (pending.isRead) {
			this.flushReadQueue();
			return;
		}
		// 写通道终态:清停滞与提交窗口,并放行下一个排队操作。
		this.stalled = false;
		this.closeCommitWindow();
		this.release();
	}

	/**
	 * 无有效活动达到阈值。
	 *
	 * 关键路径:只结束调用方的等待 —— pending 与写保护保留,迟到终态仍能提交;
	 * 只读请求超时则释放只读通道(查询必须有界)。
	 */
	private handleStall(pending: PendingRequest): void {
		// 关键路径:只读请求必须有界 —— 超时即按真实失败结束并释放只读通道,不保留等待。
		if (pending.isRead) {
			if (!pending.waiterSettled) pending.waiterSettled = true;
			pending.reject(new WorkerManagerError(
				'request-timeout',
				`查询超时:${pending.type}`,
				{ requestId: pending.requestId, elapsedMs: this.timeoutMs },
			));
			this.pending.delete(pending.requestId);
			this.forgetTaskId(pending);
			this.clearTimer(pending);
			pending.detachAbort?.();
			pending.detachAbort = undefined;
			this.readBusy = false;
			this.flushReadQueue();
			return;
		}
		// 关键路径:已经在停滞中就不重复上报;恢复后再次无进展仍可重新判定。
		if (pending.stalled) return;
		pending.stalled = true;
		this.stalled = true;
		const error = new WorkerManagerError(
			'index-stalled',
			`索引任务停滞:${pending.type} 在 ${this.timeoutMs}ms 内没有有效活动`,
			{
				requestId: pending.requestId,
				taskId: pending.taskId,
				epoch: pending.epoch,
				lastActivity: pending.lastActivity,
				elapsedMs: this.timeoutMs,
			},
		);
		if (!pending.waiterSettled) {
			pending.waiterSettled = true;
			pending.reject(error);
			// 关键路径:仍保留 pending 与 busy；迟到终态只经 onLateTerminal 交付。
			this.rejectQueue(error);
		}
		this.onStall?.(this.describe(pending));
	}

	/** 武装无活动超时。 */
	private armTimeout(pending: PendingRequest): void {
		this.clearTimer(pending);
		pending.timer = this.clock.setTimeout(() => this.handleStall(pending), this.timeoutMs);
	}

	/** 清除定时器。 */
	private clearTimer(pending: PendingRequest): void {
		if (pending.timer === null || pending.timer === undefined) return;
		this.clock.clearTimeout(pending.timer);
		pending.timer = null;
	}

	/** 绑定主线程侧取消信号;`AbortSignal` 不跨 Worker,取消经消息表达。 */
	private bindAbort(pending: PendingRequest, signal?: AbortSignal): void {
		if (signal === undefined) return;
		const onAbort = (): void => {
			this.cancelIndex({ requestId: pending.requestId, reason: '调用方已取消索引任务' });
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
		pending.detachAbort = () => signal.removeEventListener('abort', onAbort);
	}

	/** 打开提交窗口 — 真实持久化 IO 进行中。 */
	private openCommitWindow(): void {
		this.commitWindowOpen = true;
	}

	/** 关闭提交窗口并放行等待中的只读请求。 */
	private closeCommitWindow(): void {
		if (!this.commitWindowOpen) return;
		this.commitWindowOpen = false;
		this.flushReadQueue();
	}

	/** 诊断快照 — 阶段、持续时间、批次与数量;不含正文/向量/路径/密钥。 */
	private describe(pending: PendingRequest): IndexRequestStallInfo {
		return {
			requestId: pending.requestId,
			taskId: pending.taskId,
			epoch: pending.epoch,
			type: pending.type,
			lastActivity: pending.lastActivity,
			stalledMs: this.timeoutMs,
			timeoutMs: this.timeoutMs,
		};
	}

	/** 按请求 ID / 任务 ID 定位在途请求。 */
	private findPending(target: { requestId?: string; taskId?: string; epoch?: number }): PendingRequest | undefined {
		if (target.requestId !== undefined) {
			const pending = this.pending.get(target.requestId);
			if (pending !== undefined) return pending;
			// 关键路径(建议 3):显式给出 requestId 且未命中时不再按 taskId / epoch 兜底 ——
			// 否则冒名 requestId 的活动会借别人的任务身份续期、恢复或取消那个任务。
			return undefined;
		}
		if (target.taskId !== undefined) {
			const requestId = this.pendingByTask.get(target.taskId);
			if (requestId !== undefined) return this.pending.get(requestId);
		}
		if (target.epoch === undefined) return undefined;
		for (const pending of this.pending.values()) {
			if (pending.epoch === target.epoch) return pending;
		}
		return undefined;
	}

	/** 移除任务索引。 */
	private forgetTaskId(pending: PendingRequest): void {
		if (pending.taskId === null) return;
		if (this.pendingByTask.get(pending.taskId) === pending.requestId) this.pendingByTask.delete(pending.taskId);
	}

	// ==================== 通道调度 ====================

	private enqueue(operation: QueuedOperation): void {
		if (this.closed || this.stalled) {
			operation.reject(new WorkerManagerError(
				this.closed ? 'worker-destroyed' : 'request-blocked',
				this.closed ? 'Worker destroyed' : tNow('notice.indexStillRunning'),
			));
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
			this.clearTimer(pending);
			pending.detachAbort?.();
			if (pending.waiterSettled) continue;
			pending.waiterSettled = true;
			pending.reject(error);
		}
		this.pending.clear();
		this.pendingByTask.clear();
		for (const queued of this.readQueue.splice(0)) {
			if (queued.settled) continue;
			queued.settled = true;
			queued.detachAbort?.();
			queued.detachAbort = undefined;
			this.clock.clearTimeout(queued.timer);
			queued.reject(error);
		}
		this.activeExclusiveReject?.(error);
		this.rejectQueue(error);
	}
}

// ==================== 工具 ====================

/** 读取索引请求携带的任务身份。 */
function readIndexIdentity(req: WorkerRequest): { taskId?: string; epoch?: number } | null {
	switch (req.type) {
		case 'index.full':
		case 'index.batch':
		case 'index.incremental':
			return { taskId: req.payload.taskId, epoch: req.payload.epoch };
		default:
			return null;
	}
}

/** 把任务身份写进索引请求载荷 — Worker 侧据此给活动包盖章。 */
function withIndexIdentity(req: WorkerRequest, taskId: string, epoch: number): WorkerRequest {
	switch (req.type) {
		case 'index.full':
			return { type: 'index.full', payload: { ...req.payload, taskId, epoch } };
		case 'index.incremental':
			return { type: 'index.incremental', payload: { ...req.payload, taskId, epoch } };
		case 'index.batch':
			return { type: 'index.batch', payload: { ...req.payload, taskId, epoch } };
		default:
			return req;
	}
}