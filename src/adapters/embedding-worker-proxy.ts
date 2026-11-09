/**
 * @file src/adapters/embedding-worker-proxy.ts
 * @description EmbeddingWorkerProxy — Web Worker 代理,惰性创建、空闲回收、崩溃后重建
 * @module adapters/embedding-worker-proxy
 * @depends ports/embedding, adapters/embedding-onnx, logging/dev-logger
 *
 * 设计要点:
 * - 实现 EmbeddingPort 接口,对上层(IndexProcessor / SearchVault)透明。
 * - 构造时不 new Worker;首次 embed 才创建并 init。
 * - 无挂起请求且空闲 IDLE_TERMINATE_MS 后 terminate,释放 WASM 线性内存。
 * - Worker 崩溃后置空,下次 embed 重建;连续两次 init 失败进入 dead。
 * - 生命周期只走 onLifecycle 回调,不新增面包屑 phase。
 */

import type { EmbeddingPort } from '../ports/embedding';
import { createEmbedAbortError, throwIfEmbeddingAborted } from '../ports/embedding';
import type { EmbedOptions } from '../core/index-persistence-types';
import type { EmbeddingOnnxDeps } from './embedding-onnx';
import { devLogger } from '../logging/dev-logger';

/** 无挂起 embed 且距上次成功推理超过此时长则回收 Worker(5 分钟) */
export const IDLE_TERMINATE_MS = 5 * 60_000;

/** Worker 生命周期事件;装配层用 heartbeat + n=worker.* 打点,不改 lastPhase */
export type WorkerLifecycleKind = 'create' | 'idle-terminate' | 'crash';

type DepsOrFactory = EmbeddingOnnxDeps | (() => Promise<EmbeddingOnnxDeps>);

/**
 * Web Worker 消息类型 — 主线程 → Worker。
 */
interface WorkerInitMessage {
	type: 'init';
	deps: EmbeddingOnnxDeps;
	dimensions: number;
	maxBatchSize: number;
}

interface WorkerEmbedMessage {
	type: 'embed';
	texts: string[];
	requestId: string;
}

/**
 * 主线程 → Worker 的取消消息。
 *
 * 关键路径(T5):`AbortSignal` 不能跨 Worker 传递,取消必须经消息表达;
 * Worker 收到后在批次边界中止对应请求,绝不为取消单项任务终止整个运行时。
 */
interface WorkerCancelMessage {
	type: 'cancel';
	requestId: string;
}

/**
 * Web Worker 消息类型 — Worker → 主线程。
 */
interface WorkerReadyMessage {
	type: 'ready';
}

interface WorkerEmbedResultMessage {
	type: 'embed:result';
	requestId: string;
	vectors: number[][];
}

/** 批次活动 — 每个真实完成的批次上报一次,由代理按 request ID 转发给调用方。 */
interface WorkerEmbedProgressMessage {
	type: 'embed:progress';
	requestId: string;
	done: number;
	total: number;
}

interface WorkerErrorMessage {
	type: 'error';
	requestId?: string;
	error: string;
}

/** GPU 设备丢失 — 推理会静默挂起，必须在毫秒级上报。 */
interface WorkerGpuLostMessage {
	type: 'gpu:lost';
	reason: string;
}

type WorkerResponse =
	| WorkerReadyMessage
	| WorkerEmbedResultMessage
	| WorkerEmbedProgressMessage
	| WorkerErrorMessage
	| WorkerGpuLostMessage;

/** 一次挂起嵌入请求的结算与清理凭据。 */
interface PendingEmbed {
	resolve: (vectors: number[][]) => void;
	reject: (err: Error) => void;
	/** 批次活动回调 — 由代理按 request ID 转发,不跨 Worker 传函数。 */
	onBatchComplete?: (done: number, total: number) => void;
	/** 摘除 `signal` 上的 abort 监听;请求结算后必须调用,避免监听器泄漏。 */
	detachAbort?: () => void;
	/** 请求级超时计时器 — 结算时必须清除,否则悬挂的定时器会在之后误伤新请求。 */
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * 单次嵌入请求的超时上限。
 *
 * 关键路径(2026-11-06 线上):此前没有请求级超时 —— Worker 一旦被某个超大块卡住,
 * 该请求的 Promise 永远悬挂、pending 不清理,后续所有嵌入请求都排在它后面相继超时,
 * 表现为「同一目录多个文件连续报宿主调用超时」。超时后必须重建 Worker,
 * 否则卡住的状态会一直延续下去。
 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * EmbeddingWorkerProxy — Web Worker 代理实现 EmbeddingPort。
 *
 * 设计要点:
 * - 第二参兼容 deps 对象与工厂;工厂路径每次 ensureWorker 都 getDeps,避免 transfer 掏空旧 buffer。
 * - `ready` 在尚未创建 Worker 时是已 resolve 的空 Promise;真正 init 发生在首次 embed。
 * - embed 请求用自增 requestId 关联响应,支持并发;并发首次创建会合入同一 in-flight Promise。
 * - error 事件 reject 全部 pending 后 worker=null,不把运行时崩溃计入 consecutiveInitFailures。
 *
 * @example
 *   const proxy = new EmbeddingWorkerProxy(workerUrl, () => getDeps(), 512);
 *   const vectors = await proxy.embed(['hello world']);
 */
export class EmbeddingWorkerProxy implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId: string;
	private worker: Worker | null = null;
	private readyPromise: Promise<void> = Promise.resolve();
	private pending = new Map<string, PendingEmbed>();
	private requestCounter = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private consecutiveInitFailures = 0;
	private dead = false;
	private loggedDead = false;
	private creating: Promise<void> | null = null;
	private settleReady: { resolve: () => void; reject: (err: Error) => void } | null = null;
	private readonly workerUrl: string;
	/** Worker 加载类型:GPU 版是 ESM module,WASM 版是 classic。 */
	private readonly workerType: 'classic' | 'module';
	/**
	 * 已被装配层预热过的 Worker（已 init + 完成一次 warmup）。
	 *
	 * 关键路径(S-WEBGPU-EMBEDDING):GPU 探测成功后直接接管该实例,
	 * 不再销毁重建 —— 否则模型加载与 wasm 编译会白跑两次(每次约 1 秒)。
	 */
	private readonly prewarmed?: Worker;
	private readonly maxBatchSize: number;
	private readonly createDeps: () => Promise<EmbeddingOnnxDeps>;
	private readonly onLifecycle?: (kind: WorkerLifecycleKind, reason?: string) => void;
	/** 单次请求等待上限(ms) — 可注入，便于用真实分支验证超时行为。 */
	private readonly requestTimeoutMs: number;

	/**
	 * @param workerUrl - Worker 脚本 URL(Blob URL)
	 * @param depsOrFactory - 模型依赖对象,或每次 ensureWorker 都调用的工厂(transfer 会掏空 ArrayBuffer)
	 * @param dimensions - 向量维度
	 * @param maxBatchSize - Worker 内单批上限
	 * @param onLifecycle - 可选;create / idle-terminate / crash,由装配层打 heartbeat;
	 *   第二个参数是**终止原因** —— 三种故障都叫 crash,只记枚举等于没记。
	 * @param workerType - Worker 加载类型;GPU 版传 'module',WASM 版缺省 'classic'
	 * @param prewarmed - 已 init 完成的 Worker;传入时跳过创建与 init
	 */
	constructor(
		workerUrl: string,
		depsOrFactory: DepsOrFactory,
		dimensions: number,
		maxBatchSize = 16,
		onLifecycle?: (kind: WorkerLifecycleKind, reason?: string) => void,
		workerType: 'classic' | 'module' = 'classic',
		prewarmed?: Worker,
		requestTimeoutMs = REQUEST_TIMEOUT_MS,
	) {
		this.workerUrl = workerUrl;
		this.workerType = workerType;
		this.prewarmed = prewarmed;
		this.dimensions = dimensions;
		this.maxBatchSize = maxBatchSize;
		this.onLifecycle = onLifecycle;
		this.requestTimeoutMs = requestTimeoutMs;
		if (typeof depsOrFactory === 'function') {
			this.createDeps = depsOrFactory;
			this.modelId = 'local:bge-small-zh-v1.5';
		} else {
			this.createDeps = async () => depsOrFactory;
			this.modelId = depsOrFactory.modelId ?? 'local:bge-small-zh-v1.5';
		}
	}

	/**
	 * Worker init 完成的 Promise。尚未创建 Worker 时立即 resolve(惰性)。
	 */
	get ready(): Promise<void> {
		return this.readyPromise;
	}

	/**
	 * onload 预热:创建 Worker 并等到 init ready,不跑推理。
	 * 惰性后 `ready` 在无 worker 时是已 resolve 的空 Promise,不能当预热用。
	 *
	 * @throws Worker 连续 init 失败进入 dead 后抛「Embedding Worker 不可用」。
	 */
	async ensureReady(): Promise<void> {
		if (this.dead) throw new Error('Embedding Worker 不可用');
		await this.ensureWorker();
		// 关键路径:预热也算活动；不 arm 则 onload 创建的 WASM 会常驻到下一次 embed
		this.armIdleTimer();
	}

	/**
	 * 批量生成文本向量。空数组不创建 Worker。
	 *
	 * 关键路径(T5):
	 * - `options.onBatchComplete` 按 request ID 接收 Worker 的 `embed:progress`,不跨线程传函数;
	 * - `options.signal` 在主线程侧生效:已中止则立即 reject(不留永不结束的 Promise),
	 *   同时向 Worker 发 `cancel` 消息让它在批次边界停止;信号不跨 Worker 传递;
	 * - 请求结算后必须摘除 abort 监听与回调,避免监听器随任务泄漏。
	 *
	 * @param texts - 待编码文本数组。
	 * @param options - 可选取消信号与批次活动回调。
	 * @returns 与 texts 等长的向量数组。
	 * @throws Worker 不可用、推理失败、Worker 崩溃或调用已取消时抛错。
	 */
	async embed(texts: string[], options?: EmbedOptions): Promise<number[][]> {
		if (texts.length === 0) return [];
		// 关键路径:已中止的调用不创建 Worker(取消先于任何真实工作)。
		throwIfEmbeddingAborted(options?.signal);
		if (this.dead) {
			if (!this.loggedDead) {
				devLogger.error('worker', 'Embedding Worker 连续 init 失败，已停止重建');
				this.loggedDead = true;
			}
			throw new Error('Embedding Worker 不可用');
		}
		// 关键路径:先清空闲时钟,避免 ensureWorker 期间 timer 把刚要用的 Worker 收掉
		this.clearIdleTimer();
		try {
			await this.ensureWorker();
			const worker = this.worker;
			if (!worker) {
				throw new Error('Embedding Worker 不可用');
			}
			// 关键路径:await 之后必须重新检查 — 取消可能发生在等待 Worker 创建期间。
			throwIfEmbeddingAborted(options?.signal);
			const requestId = `embed_${++this.requestCounter}`;
			const result = await new Promise<number[][]>((resolve, reject) => {
				const entry: PendingEmbed = { resolve, reject, onBatchComplete: options?.onBatchComplete };
				const signal = options?.signal;
				if (signal !== undefined) {
					const onAbort = (): void => {
						// 关键路径:本地立即结算,Worker 侧异步收敛;两侧都不留永不结束的 Promise。
						this.requestCancel(requestId);
						this.settlePending(requestId, createEmbedAbortError());
					};
					signal.addEventListener('abort', onAbort, { once: true });
					entry.detachAbort = () => signal.removeEventListener('abort', onAbort);
				}
				// 关键路径:请求级超时 —— 卡住的请求必须主动结算并重建 Worker,
				// 否则它会永久占住 pending,让后续所有嵌入调用排队到超时。
				entry.timer = globalThis.setTimeout(() => {
					if (!this.pending.has(requestId)) return;
					// 关键路径(诊断):超时只说「120 秒没回来」对定位没有帮助 ——
					// 必须同时记下这一批有多大、还有多少请求在排队、Worker 是否还活着,
					// 否则「GPU 卡死」「消息丢失」「批量过大」三种原因无法区分。
					const chars = texts.reduce((sum, text) => sum + text.length, 0);
					devLogger.warn(
						'worker',
						`嵌入请求超时:${requestId} 批量=${texts.length} 字符=${chars} ` +
							`排队=${this.pending.size} worker=${this.worker === null ? '无' : '存活'} ` +
							`已发请求=${this.requestCounter}`,
					);
					this.settlePending(requestId, new Error(`Embedding Worker 请求超时(${this.requestTimeoutMs / 1000} 秒)`));
					this.terminateWorker('crash', `Embedding Worker 因请求超时被重建(批量=${texts.length} 字符=${chars})`);
				}, this.requestTimeoutMs);
				this.pending.set(requestId, entry);
				const msg: WorkerEmbedMessage = { type: 'embed', texts, requestId };
				worker.postMessage(msg);
			});
			return result;
		} finally {
			// 业务错误也要重新 arm，避免 clearIdleTimer 后 Worker 常驻
			if (this.pending.size === 0) this.armIdleTimer();
		}
	}

	/**
	 * 终止 Worker — 插件卸载时调用,不打 idle/crash 生命周期。
	 */
	terminate(): void {
		this.terminateWorker();
	}

	/**
	 * 整个嵌入运行时重置 — 永久挂起时的唯一出口。
	 *
	 * 关键路径(T5):永久挂起不能靠等待收尾来"结束";此入口终止 Worker 并让
	 * 所有受影响调用按**真实失败**结束(不留永不结束的 Promise),下次 embed 重新创建 Worker。
	 * 这不是取消单项任务的手段(那走 `signal` → `cancel` 消息)。
	 *
	 * @param reason - 诊断文案;不含路径、正文或密钥。
	 */
	resetRuntime(reason = '嵌入运行时已重置,受影响的调用按真实失败结束'): void {
		devLogger.warn('worker', `重置嵌入运行时:${reason}`);
		this.terminateWorker(undefined, reason);
	}

	/**
	 * 确保 Worker 已创建并 init ready。并发 embed 共用 in-flight 创建。
	 */
	private async ensureWorker(): Promise<void> {
		if (this.worker) {
			await this.readyPromise;
			return;
		}
		if (!this.creating) {
			this.creating = this.doCreate().finally(() => {
				this.creating = null;
			});
		}
		await this.creating;
	}

	/**
	 * 创建 Worker、绑定消息、发送 init(transfer ArrayBuffer)。
	 */
	private async doCreate(): Promise<void> {
		// 关键路径:有预热实例就直接接管,省掉一次模型加载+wasm 编译。
		if (this.prewarmed !== undefined) {
			this.attachReadyWorker(this.prewarmed);
			this.onLifecycle?.('create');
			this.armIdleTimer();
			return;
		}
		const deps = await this.createDeps();
		const worker = new Worker(this.workerUrl, { type: this.workerType });
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.settleReady = { resolve, reject };
		});

		const onInitMessage = (e: MessageEvent) => {
			const data = e.data as WorkerResponse;
			if (data.type === 'ready') {
				worker.removeEventListener('message', onInitMessage);
				// 关键路径(研发期诊断):记录 Worker 内是否暴露 WebGPU,决定 GPU 加速是否可行。
				const probe = (data as { probe?: { hasGpu?: boolean; secureContext?: boolean } }).probe;
				if (probe !== undefined) {
					devLogger.info('index', `嵌入 Worker 环境:navigator.gpu=${probe.hasGpu === true}(secureContext=${probe.secureContext === true})`);
				}
				this.settleReady?.resolve();
				this.settleReady = null;
			} else if (data.type === 'error' && !data.requestId) {
				worker.removeEventListener('message', onInitMessage);
				this.handleInitFailure(worker);
				const err = new Error(data.error);
				this.settleReady?.reject(err);
				this.settleReady = null;
			}
		};
		worker.addEventListener('message', onInitMessage);

		worker.addEventListener('message', (e: MessageEvent) => {
			const data = e.data as WorkerResponse;
			if (data.type === 'embed:result') {
				// 关键路径:按 request ID 结算;已完成(取消)的请求忽略迟到结果。
				this.settlePending(data.requestId, undefined, data.vectors);
			} else if (data.type === 'embed:progress') {
				// 关键路径:按 request ID 转发批次活动,不把函数传进 Worker。
				const entry = this.pending.get(data.requestId);
				if (entry !== undefined) entry.onBatchComplete?.(data.done, data.total);
			} else if (data.type === 'error' && data.requestId) {
				this.settlePending(data.requestId, new Error(data.error));
			} else if (data.type === 'gpu:lost') {
				// 关键路径(2026-11-09 现场):设备丢失后推理不会报错、只是永不返回。
				// 收到这条就立刻重建，而不是让在途请求干等到超时 ——
				// 用户感知是「瞬间恢复」而不是「卡两分钟」。
				devLogger.error('worker', `GPU 设备丢失,重建嵌入运行时:${data.reason}`);
				this.terminateWorker('crash', `GPU 设备丢失:${data.reason}`);
			}
		});

		// 关键路径:运行时崩溃不算 init 失败,下次 embed 允许重建。
		worker.addEventListener('error', (err: ErrorEvent) => {
			this.settleReady?.reject(new Error(`Embedding Worker 崩溃: ${err.message}`));
			this.settleReady = null;
			this.terminateWorker('crash', `Embedding Worker 崩溃: ${err.message}`);
		});

		this.worker = worker;
		const initMsg: WorkerInitMessage = {
			type: 'init',
			deps,
			dimensions: this.dimensions,
			maxBatchSize: this.maxBatchSize,
		};
		const transferables = [deps.modelBuffer, deps.wasmBinary];
		// 关键路径:postMessage 可能因已 transfer 的 ArrayBuffer 抛 DataCloneError;
		// 若不结算 readyPromise 并清空 worker,下次 ensureWorker 会永远 await ready。
		try {
			worker.postMessage(initMsg, transferables);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.handleInitFailure(worker);
			this.settleReady?.reject(error);
			this.settleReady = null;
		}

		await this.readyPromise;
		this.consecutiveInitFailures = 0;
		this.onLifecycle?.('create');
		// 关键路径:create/warmup 起算空闲，不能等第一次 embed
		this.armIdleTimer();
	}

	/**
	 * 接管一个已经 init 完成的 Worker：只绑请求/崩溃处理器，不再发 init。
	 *
	 * @param worker - 装配层探测成功、已完成 warmup 的实例
	 */
	private attachReadyWorker(worker: Worker): void {
		this.readyPromise = Promise.resolve();
		this.settleReady = null;
		worker.addEventListener('message', (e: MessageEvent) => {
			const data = e.data as WorkerResponse;
			if (data.type === 'embed:result') {
				this.settlePending(data.requestId, undefined, data.vectors);
			} else if (data.type === 'embed:progress') {
				const entry = this.pending.get(data.requestId);
				if (entry !== undefined) entry.onBatchComplete?.(data.done, data.total);
			} else if (data.type === 'error' && data.requestId) {
				this.settlePending(data.requestId, new Error(data.error));
			} else if (data.type === 'gpu:lost') {
				// 关键路径:预热复用路径（GPU 探测成功后接管实例）走的就是这里，
				// 少了这条分支，设备丢失信号会被静默丢弃，用户仍要等 120 秒超时。
				devLogger.error('worker', `GPU 设备丢失,重建嵌入运行时:${data.reason}`);
				this.terminateWorker('crash', `GPU 设备丢失:${data.reason}`);
			}
		});
		worker.addEventListener('error', (err: ErrorEvent) => {
			this.terminateWorker('crash', `Embedding Worker 崩溃: ${err.message}`);
		});
		this.worker = worker;
	}

	/**
	 * init 失败:累计次数,到 2 次进入 dead;不打 crash 生命周期。
	 *
	 * @param worker - 本次创建失败的 Worker 实例
	 */
	private handleInitFailure(worker: Worker): void {
		this.consecutiveInitFailures += 1;
		if (this.consecutiveInitFailures >= 2) {
			this.dead = true;
		}
		if (this.worker === worker) {
			this.worker = null;
		}
		worker.terminate();
	}

	/**
	 * 结算一次挂起请求 — 幂等,并摘除 abort 监听。
	 *
	 * @param requestId - 请求标识。
	 * @param error - 传入表示按失败结算。
	 * @param vectors - 成功结果。
	 */
	private settlePending(requestId: string, error?: Error, vectors?: number[][]): void {
		const entry = this.pending.get(requestId);
		if (entry === undefined) return;
		this.pending.delete(requestId);
		if (entry.timer !== undefined) {
			globalThis.clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.detachAbort?.();
		if (error !== undefined) {
			entry.reject(error);
			return;
		}
		entry.resolve(vectors ?? []);
	}

	/**
	 * 发送取消消息 — 单项任务取消,不终止共享 Worker。
	 *
	 * @param requestId - 待取消的请求标识。
	 */
	private requestCancel(requestId: string): void {
		const worker = this.worker;
		if (!worker) return;
		const msg: WorkerCancelMessage = { type: 'cancel', requestId };
		try {
			worker.postMessage(msg);
		}
		catch (err) {
			// 关键路径:取消消息发不出去不能反过来吞掉调用方的真实失败结算。
			devLogger.warn('worker', '发送嵌入取消消息失败', err);
		}
	}

	/**
	 * 回收或卸载当前 Worker。
	 *
	 * @param kind - 传入则回调 onLifecycle;公开 terminate 省略以免卸载误打 idle
	 * @param rejectMessage - pending 请求的拒绝文案
	 */
	private terminateWorker(kind?: WorkerLifecycleKind, rejectMessage = 'Embedding Worker 已终止'): void {
		this.clearIdleTimer();
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		for (const requestId of [...this.pending.keys()]) {
			this.settlePending(requestId, new Error(rejectMessage));
		}
		if (kind) this.onLifecycle?.(kind, rejectMessage);
	}

	/**
	 * 无挂起请求时启动空闲回收时钟（create / warmup / embed 成功或业务错误后）。
	 */
	private armIdleTimer(): void {
		this.clearIdleTimer();
		if (!this.worker) return;
		this.idleTimer = globalThis.setTimeout(() => {
			this.idleTimer = null;
			if (this.pending.size > 0) return;
			this.terminateWorker('idle-terminate');
		}, IDLE_TERMINATE_MS);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== null) {
			globalThis.clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
}
