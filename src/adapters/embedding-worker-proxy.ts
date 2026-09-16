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

interface WorkerErrorMessage {
	type: 'error';
	requestId?: string;
	error: string;
}

type WorkerResponse = WorkerReadyMessage | WorkerEmbedResultMessage | WorkerErrorMessage;

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
	private pending = new Map<string, (vectors: number[][]) => void>();
	private pendingError = new Map<string, (err: Error) => void>();
	private requestCounter = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private consecutiveInitFailures = 0;
	private dead = false;
	private loggedDead = false;
	private creating: Promise<void> | null = null;
	private settleReady: { resolve: () => void; reject: (err: Error) => void } | null = null;
	private readonly workerUrl: string;
	private readonly maxBatchSize: number;
	private readonly createDeps: () => Promise<EmbeddingOnnxDeps>;
	private readonly onLifecycle?: (kind: WorkerLifecycleKind) => void;

	/**
	 * @param workerUrl - Worker 脚本 URL(Blob URL)
	 * @param depsOrFactory - 模型依赖对象,或每次 ensureWorker 都调用的工厂(transfer 会掏空 ArrayBuffer)
	 * @param dimensions - 向量维度
	 * @param maxBatchSize - Worker 内单批上限
	 * @param onLifecycle - 可选;create / idle-terminate / crash,由装配层打 heartbeat
	 */
	constructor(
		workerUrl: string,
		depsOrFactory: DepsOrFactory,
		dimensions: number,
		maxBatchSize = 16,
		onLifecycle?: (kind: WorkerLifecycleKind) => void,
	) {
		this.workerUrl = workerUrl;
		this.dimensions = dimensions;
		this.maxBatchSize = maxBatchSize;
		this.onLifecycle = onLifecycle;
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
	 * @param texts - 待编码文本数组。
	 * @returns 与 texts 等长的向量数组。
	 * @throws Worker 不可用、推理失败或 Worker 崩溃时抛错。
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
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
			const requestId = `embed_${++this.requestCounter}`;
			const result = await new Promise<number[][]>((resolve, reject) => {
				this.pending.set(requestId, resolve);
				this.pendingError.set(requestId, reject);
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
		const deps = await this.createDeps();
		const worker = new Worker(this.workerUrl);
		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.settleReady = { resolve, reject };
		});

		const onInitMessage = (e: MessageEvent) => {
			const data = e.data as WorkerResponse;
			if (data.type === 'ready') {
				worker.removeEventListener('message', onInitMessage);
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
				const resolve = this.pending.get(data.requestId);
				if (resolve) {
					resolve(data.vectors);
					this.pending.delete(data.requestId);
					this.pendingError.delete(data.requestId);
				}
			} else if (data.type === 'error' && data.requestId) {
				const reject = this.pendingError.get(data.requestId);
				if (reject) {
					reject(new Error(data.error));
					this.pending.delete(data.requestId);
					this.pendingError.delete(data.requestId);
				}
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
		for (const [, reject] of this.pendingError) {
			reject(new Error(rejectMessage));
		}
		this.pending.clear();
		this.pendingError.clear();
		if (kind) this.onLifecycle?.(kind);
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
