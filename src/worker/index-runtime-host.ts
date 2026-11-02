/**
 * @file src/worker/index-runtime-host.ts
 * @description 索引运行时宿主 — 常驻 Worker 的生命周期、请求/响应匹配、超时取消与有界在途
 * @module src/worker/index-runtime-host
 *
 * 关键路径:
 * - 宿主只持有常驻 Worker 与请求账本;CPU、文件与存储都在 Worker 侧,本文件不碰索引目录。
 * - 每个请求恰好结算一次:超时、取消、Worker 退出都不会二次结算,迟到响应直接丢弃。
 * - 取消只结束调用方等待,在途配额要等真实终态(cancel-ack 或响应)才归还;无应答时按上限强制回收并计数。
 * - Worker 退出后不自动兜底重建:调用方显式 `start()` 才会得到新 epoch,避免旧 epoch 的迟到消息污染新运行时。
 */

import {
	INDEX_RUNTIME_PROTOCOL_VERSION,
	MAX_MESSAGE_BYTES,
	SettleOnce,
	estimatePayloadBytes,
	parseRuntimeMessage,
	type IndexRuntimeControl,
	type IndexRuntimeRequest,
} from './index-runtime-protocol';

/** 宿主可见的最小 Worker 接口;测试可注入假实现。 */
export interface RuntimeWorkerLike {
	postMessage(message: unknown): void;
	terminate(): void | Promise<number | void>;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: ((event: { message?: string }) => void) | null;
}

/** Worker 工厂。 */
export type RuntimeWorkerFactory = () => RuntimeWorkerLike;

/** 宿主选项。 */
export interface IndexRuntimeHostOptions {
	/** 创建 Worker 的工厂;生产侧用 Blob URL 常驻 Worker。 */
	createWorker: RuntimeWorkerFactory;
	/** 运行时标识;缺省随机。 */
	runtimeId?: string;
	/** 单请求超时,默认 30 秒。 */
	requestTimeoutMs?: number;
	/** 在途请求上限。 */
	maxInflight?: number;
	/** 在途载荷字节上限。 */
	maxInflightBytes?: number;
	/** Worker 反向调用的处理函数(例如请求嵌入向量)。 */
	onCall?: (method: string, payload: unknown) => unknown;
}

/** 宿主错误码。 */
export type RuntimeHostErrorCode = 'not-started' | 'aborted' | 'timeout' | 'worker-exit' | 'stopped' | 'over-budget';

/** 宿主错误。 */
export class IndexRuntimeHostError extends Error {
	constructor(readonly code: RuntimeHostErrorCode, message: string) {
		super(message);
		this.name = 'IndexRuntimeHostError';
	}
}

/** 在途条目:函数只存在于宿主本地,不进入跨线程载荷。 */
interface PendingEntry {
	readonly method: string;
	readonly bytes: number;
	readonly settled: SettleOnce;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
	hardTimer: ReturnType<typeof setTimeout> | null;
}

/** 索引运行时宿主。 */
export class IndexRuntimeHost {
	private worker: RuntimeWorkerLike | null = null;
	private epochValue = 0;
	private readonly pending = new Map<string, PendingEntry>();
	private readonly runtimeId: string;
	private readonly requestTimeoutMs: number;
	private readonly maxInflight: number;
	private readonly maxInflightBytes: number;
	private readonly onCall: ((method: string, payload: unknown) => unknown) | undefined;
	private inflightBytes = 0;
	private sequence = 0;
	private readonly createWorker: RuntimeWorkerFactory;
	/** 无终态被强制回收的次数,用于观测而不是掩盖。 */
	unconfirmedDrops = 0;

	constructor(options: IndexRuntimeHostOptions) {
		this.createWorker = options.createWorker;
		this.runtimeId = options.runtimeId ?? `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.maxInflight = options.maxInflight ?? 8;
		this.maxInflightBytes = options.maxInflightBytes ?? MAX_MESSAGE_BYTES;
		this.onCall = options.onCall;
	}

	/** 当前 epoch;0 表示尚未启动。 */
	get epoch(): number {
		return this.epochValue;
	}

	/** 是否已启动。 */
	get running(): boolean {
		return this.worker !== null;
	}

	/** 在途请求数(含已超时但未确认终态)。 */
	get inflight(): number {
		return this.pending.size;
	}

	/** 在途载荷字节。 */
	get inflightPayloadBytes(): number {
		return this.inflightBytes;
	}

	/**
	 * 启动常驻 Worker;已启动时返回当前 epoch。
	 * @returns 新 epoch
	 */
	start(): number {
		if (this.worker !== null) return this.epochValue;
		const worker = this.createWorker();
		worker.onmessage = (event) => this.handleMessage(event.data);
		worker.onerror = (event) => {
			// 关键路径:崩溃后清空句柄,否则 restart 会误判仍在运行并沿用旧 epoch。
			if (this.worker === worker) this.worker = null;
			this.failAll('worker-exit', event.message ?? '索引线程异常');
		};
		this.worker = worker;
		this.epochValue += 1;
		return this.epochValue;
	}

	/**
	 * 停止运行时:先撤销,再终止。
	 * @param reason 停止原因
	 */
	async stop(reason = 'stopped'): Promise<void> {
		const worker = this.worker;
		if (worker === null) return;
		this.postControl('revoke', reason);
		this.worker = null;
		this.failAll('stopped', reason);
		await worker.terminate();
	}

	/**
	 * 发送一次请求。
	 * @param method Worker 侧方法名
	 * @param payload 可结构化克隆的载荷
	 * @param signal 取消信号
	 */
	request<T = unknown>(method: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
		const worker = this.worker;
		if (worker === null) {
			return Promise.reject(new IndexRuntimeHostError('not-started', '索引线程未启动'));
		}
		if (this.pending.size >= this.maxInflight) {
			return Promise.reject(new IndexRuntimeHostError('over-budget', '在途请求已达上限'));
		}
		const bytes = estimatePayloadBytes(payload);
		if (this.inflightBytes + bytes > this.maxInflightBytes) {
			return Promise.reject(new IndexRuntimeHostError('over-budget', '在途载荷超过预算'));
		}

		const requestId = `req-${++this.sequence}`;
		const request: IndexRuntimeRequest = {
			kind: 'request',
			protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
			runtimeId: this.runtimeId,
			epoch: this.epochValue,
			requestId,
			method,
			payload,
		};

		return new Promise<T>((resolve, reject) => {
			const entry: PendingEntry = {
				method,
				bytes,
				settled: new SettleOnce(),
				resolve: (value) => resolve(value as T),
				reject,
				timer: null,
				hardTimer: null,
			};
			this.pending.set(requestId, entry);
			this.inflightBytes += bytes;

			entry.timer = setTimeout(() => {
				// 关键路径:超时只结束调用方等待,配额等真实终态;同时发取消。
				entry.settled.settle(() => reject(new IndexRuntimeHostError('timeout', `请求超时: ${method}`)));
				this.postControl('cancel', `timeout:${requestId}`, requestId);
				entry.hardTimer = setTimeout(() => this.dropEntry(requestId, true), this.requestTimeoutMs);
			}, this.requestTimeoutMs);

			if (signal !== undefined) {
				if (signal.aborted) {
					entry.settled.settle(() => reject(new IndexRuntimeHostError('aborted', '请求已取消')));
					this.dropEntry(requestId, true);
					return;
				}
				signal.addEventListener('abort', () => {
					entry.settled.settle(() => reject(new IndexRuntimeHostError('aborted', '请求已取消')));
					this.postControl('cancel', 'aborted', requestId);
				}, { once: true });
			}

			try {
				worker.postMessage(request);
			} catch (error) {
				entry.settled.settle(() => reject(error instanceof Error ? error : new Error(String(error))));
				this.dropEntry(requestId, true);
			}
		});
	}

	/**
	 * 发送一帧非请求消息(例如 init 授权)。
	 * @param message 已构造好的协议帧
	 */
	send(message: unknown): void {
		this.worker?.postMessage(message);
	}

	/** 处理入站消息。 */
	private handleMessage(data: unknown): void {
		const message = parseRuntimeMessage(data);
		if (message === null) return;
		if (message.runtimeId !== this.runtimeId) return;
		if (message.epoch !== this.epochValue) return;

		if (message.kind === 'response') {
			const entry = this.pending.get(message.requestId);
			if (entry === undefined) return;
			entry.settled.settle(() => {
				if (message.ok) entry.resolve(message.result);
				else entry.reject(new IndexRuntimeHostError('worker-exit', message.error ?? '索引线程返回错误'));
			});
			this.dropEntry(message.requestId, false);
			return;
		}
		if (message.kind === 'call') {
			void this.answerCall(message);
			return;
		}
		if (message.kind === 'control' && message.control === 'cancel-ack' && message.requestId !== undefined) {
			// 关键路径:确认取消后才归还配额,避免取消风暴反复扩大在途。
			this.dropEntry(message.requestId, false);
		}
	}

	/** 应答 Worker 的反向调用;未注册处理器时明确失败,不让对方悬挂。 */
	private async answerCall(message: { callId: string; method: string; payload?: unknown }): Promise<void> {
		const worker = this.worker;
		if (worker === null) return;
		let ok = true;
		let result: unknown;
		let error: string | undefined;
		if (this.onCall === undefined) {
			ok = false;
			error = `未注册反向调用处理器: ${message.method}`;
		} else {
			try {
				result = await this.onCall(message.method, message.payload);
			} catch (failure) {
				ok = false;
				error = failure instanceof Error ? failure.message : String(failure);
			}
		}
		try {
			worker.postMessage({
				kind: 'call-result',
				protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
				runtimeId: this.runtimeId,
				epoch: this.epochValue,
				callId: message.callId,
				ok,
				result,
				error,
			});
		} catch {
			// 端口已关闭:对方随 Worker 退出收敛。
		}
	}

	/** 回收条目并归还配额。 */
	private dropEntry(requestId: string, forced: boolean): void {
		const entry = this.pending.get(requestId);
		if (entry === undefined) return;
		this.pending.delete(requestId);
		this.inflightBytes = Math.max(0, this.inflightBytes - entry.bytes);
		if (entry.timer !== null) clearTimeout(entry.timer);
		if (entry.hardTimer !== null) clearTimeout(entry.hardTimer);
		if (forced) this.unconfirmedDrops += 1;
	}

	/** 所有在途请求以同一原因失败。 */
	private failAll(code: RuntimeHostErrorCode, message: string): void {
		for (const [requestId, entry] of [...this.pending]) {
			entry.settled.settle(() => entry.reject(new IndexRuntimeHostError(code, message)));
			this.dropEntry(requestId, false);
		}
	}

	/** 发送控制消息。 */
	private postControl(control: IndexRuntimeControl['control'], reason?: string, requestId?: string): void {
		const worker = this.worker;
		if (worker === null) return;
		const message: IndexRuntimeControl = {
			kind: 'control',
			protocolVersion: INDEX_RUNTIME_PROTOCOL_VERSION,
			runtimeId: this.runtimeId,
			epoch: this.epochValue,
			control,
			requestId,
			reason,
		};
		try {
			worker.postMessage(message);
		} catch {
			// 控制消息失败不改变调用方结算;Worker 退出会由 onerror 收敛。
		}
	}
}
