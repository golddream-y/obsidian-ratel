/**
 * @file src/skills/skill-script-sandbox.ts
 * @description Skill 脚本沙箱主线程运行器 — Worker 生命周期 / 心跳分类超时状态机 / 并发=1(ADR-017 v1.1)
 * @module skills/skill-script-sandbox
 * @depends node:worker_threads(Node 环境兜底), DOM Worker(浏览器环境)
 */

import { Worker as NodeWorker } from 'node:worker_threads';

/** 软超时:10s 无心跳 → onSoftTimeout 警告(慢,可继续等)— ADR-017 §3 */
export const SOFT_TIMEOUT_MS = 10_000;
/** 绝对上限:自启动累计 10min — 持续打点的 forever-progress 也在此击杀(ADR-017 v1.1 §3「赖」) */
export const MAX_RUN_MS = 10 * 60_000;
/** 心跳巡检间隔(性能:1s 粒度足够,不值得更细) */
const HEARTBEAT_CHECK_INTERVAL_MS = 1_000;

export interface ScriptRunRequest {
	code: string;
	args: string[];
	allowedDirs: string[];
	/** 无心跳超时窗口(ms)— settings.skillScriptTimeout;零心跳满此值判卡死,有心跳满此值返回 still-running 交 LLM 决策(ADR-017 v1.1 §3) */
	timeoutMs: number;
	/** 绝对上限(ms),默认 MAX_RUN_MS;测试可注入小值 */
	maxRunMs?: number;
	/** 软超时(ms),默认 SOFT_TIMEOUT_MS */
	softTimeoutMs?: number;
	onProgress?: (message: string) => void;
	/** 软超时警告回调(每次 run 至多一次) */
	onSoftTimeout?: () => void;
}

/** 单次执行的结果:终态(ok/scriptError/timeout/killed/crashed)、挂起态(stillRunning)、空态(noRunning)— ADR-017 v1.1 §3 状态机 */
export type ScriptRunOutcome =
	| { status: 'ok'; result: string }
	| { status: 'scriptError'; error: string; stack?: string }
	| { status: 'stillRunning'; elapsedMs: number; lastProgress?: string; hadProgress: boolean }
	| { status: 'timeout'; kind: 'stalled' | 'maxDuration'; hadProgress: boolean }
	| { status: 'killed' }
	| { status: 'crashed'; detail?: string }
	| { status: 'noRunning' };

/** Worker 构造工厂签名 — 测试可注入裸 JS worker(协议兼容) */
export type WorkerFactory = (code: string) => SandboxWorkerHandle;

/** Worker → 主线程消息的最小结构(与 skill-script-worker 协议一致) */
interface WorkerInboundMessage {
	type?: string;
	message?: string;
	level?: string;
	result?: { ok: boolean; result?: string; error?: string; stack?: string };
}

/**
 * 沙箱 Worker 统一句柄 — 屏蔽浏览器 Web Worker 与 Node worker_threads 的 API 差异。
 *
 * 关键路径(冒烟实测):Obsidian Electron 渲染进程不支持创建 node:worker_threads
 * ("The V8 platform used by this instance of Node does not support creating Workers"),
 * 生产环境必须走浏览器 Web Worker(Obsidian 开启 nodeIntegrationInWorker,
 * Worker 内 require('vm')/require('fs') 可用);vitest/本地 Node 走 worker_threads。
 * 两种环境下 Worker 消息协议完全一致(run/progress/log/done)。
 */
export interface SandboxWorkerHandle {
	postMessage(msg: unknown): void;
	terminate(): void;
	onMessage(handler: (msg: WorkerInboundMessage) => void): void;
	onError(handler: (message: string) => void): void;
	onExit(handler: () => void): void;
}

/**
 * 适配浏览器 Web Worker(DOM addEventListener 协议)为统一句柄。
 *
 * @param worker - 浏览器 Worker 实例
 * @param objectUrl - 创建该 Worker 的 Blob URL;terminate 时回收(每次 run 一个 URL,防泄漏)
 */
export function wrapBrowserWorker(worker: Worker, objectUrl?: string): SandboxWorkerHandle {
	return {
		postMessage: (msg) => worker.postMessage(msg),
		terminate: () => {
			worker.terminate();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		},
		// 关键路径:浏览器 message 事件载荷包在 MessageEvent.data 里,此处解包
		onMessage: (h) => worker.addEventListener('message', (e) => h(e.data as WorkerInboundMessage)),
		// 脚本自身错误由 worker 内 vm 捕获后经 done 回传;此处仅兜底 worker 加载失败/harness 崩溃
		onError: (h) => worker.addEventListener('error', (e) => h(e.message || 'worker 异常')),
		// 浏览器 Worker 无 exit 事件;终止均由本端先 finish 后 terminate 发起,无需兜底
		onExit: () => {},
	};
}

/** 适配 Node worker_threads(EventEmitter 协议)为统一句柄 — vitest/本地环境路径 */
function wrapNodeWorker(worker: NodeWorker): SandboxWorkerHandle {
	return {
		postMessage: (msg) => worker.postMessage(msg),
		// 关键路径:worker_threads terminate 返回 Promise,void 抑制 floating-promise
		terminate: () => { void worker.terminate(); },
		onMessage: (h) => worker.on('message', (msg) => h(msg as WorkerInboundMessage)),
		onError: (h) => worker.on('error', (err: Error) => h(err.message)),
		onExit: (h) => worker.on('exit', () => h()),
	};
}

/**
 * 默认 Worker 工厂 — 按运行环境自动选择:
 * - 浏览器(Obsidian 渲染进程):Blob URL 起 Web Worker(同 embedding worker 模式,ADR-006);
 *   Node 分支的双重守卫:全局 Worker 与 URL.createObjectURL 任一缺失即视为 Node 环境
 *   (Node 的 URL 无 createObjectURL)。
 * - Node(vitest/本地):worker_threads eval 模式加载内联代码。
 */
const defaultCreateWorker: WorkerFactory = (code) => {
	if (typeof Worker !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
		const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
		return wrapBrowserWorker(new Worker(url), url);
	}
	return wrapNodeWorker(new NodeWorker(code, { eval: true }));
};

/** deferred(promise + resolve)— pending 轮次管理的等待句柄 */
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}

// 关键路径:Promise.withResolvers 属 ES2024,tsconfig lib 尚为 ES2021 无类型声明;
// 运行时 Node 22+/Obsidian Electron 均原生支持,此处仅以断言补类型、不做 polyfill
const withResolvers = <T>(): Deferred<T> =>
	(Promise as unknown as { withResolvers: () => Deferred<T> }).withResolvers();

/** 挂起的运行:窗口到点且有心跳 → worker 不杀,deferred 等待 continueRun/killRun 的后续轮次 */
interface PendingRun {
	worker: SandboxWorkerHandle;
	/** 当前轮的等待句柄;每次 stillRunning 轮次推进时换新 */
	deferred: Deferred<ScriptRunOutcome>;
	/** 终态收尾(清定时器 + resolve 当前轮 + terminate worker + 清 pending) */
	finish: (outcome: ScriptRunOutcome) => void;
	/** 重置无心跳窗口定时器(continueRun 调用;startMs/lastBeat 均不重置) */
	rearmWindow: () => void;
}

/**
 * Skill 脚本沙箱运行器。
 *
 * 设计要点(ADR-017 v1.1):
 * - 每次执行新起一次性 Worker(Obsidian 渲染进程:Blob URL 浏览器 Web Worker;Node:worker_threads eval),
 *   终态(ok/scriptError/timeout/killed/crashed)即 terminate 回收;死循环由 terminate() 毫秒级击杀
 * - 并发 = 1:内部 promise 链串行,防 LLM 连环调用起一堆 Worker
 * - 超时按心跳分类:窗口到点有心跳 → stillRunning 挂起(worker 不杀),LLM 决定 continueRun/killRun;
 *   零心跳满窗口(kind='stalled')或累计超绝对上限(kind='maxDuration')→ 自动击杀
 * - stalled 巡检 1s 粒度,停跳满 timeoutMs 即杀,不等窗口到点(中途停跳也能及时判死)
 * - 挂起中来了新 run → 隐含终止旧脚本(killed)再跑新(串行链语义)
 * - exit 监听兜底:即使 terminate 异常,pending Promise 也不悬空
 * - terminateAll 供插件 onunload 调用,不留孤儿线程;挂起轮次同步 resolve killed
 *
 * @example
 *   const sandbox = new SkillScriptSandbox(code);
 *   const outcome = await sandbox.run({ code: '1+1', args: [], allowedDirs: [dir], timeoutMs: 30_000 });
 *   if (outcome.status === 'stillRunning') {
 *     const next = await sandbox.continueRun(); // 再等一轮(可多轮)
 *   }
 */
export class SkillScriptSandbox {
	/** 串行链 — 并发 = 1(ADR-017 兜底三件套之一) */
	private chain: Promise<unknown> = Promise.resolve();
	/** 当前活跃 worker(terminateAll 目标;含挂起中的 worker) */
	private activeWorker: SandboxWorkerHandle | null = null;
	/** 挂起的运行(stillRunning 后);全局单个 — 不做后台多脚本并行 */
	private pending: PendingRun | null = null;

	constructor(
		private readonly workerCode: string,
		private readonly createWorker: WorkerFactory = defaultCreateWorker,
	) {}

	/** 串行执行一次脚本;前序未完成时自动排队;挂起中的旧脚本会被隐含终止 */
	run(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
		const next = this.chain.then(() => this.runExclusive(req), () => this.runExclusive(req));
		// 关键路径:链尾吞错,单个失败不阻断后续排队
		this.chain = next.then(() => undefined, () => undefined);
		return next;
	}

	/**
	 * 继续等待挂起的脚本 — 重置无心跳窗口后再等一轮(可多轮)。
	 * 绝对上限自启动累计,不随本调用重置;期间脚本停跳满窗口或完成均会立即返回。
	 *
	 * @returns 无挂起脚本时 noRunning;否则 resolve 脚本终态(ok/scriptError/timeout/killed/crashed)或下一轮 stillRunning
	 */
	async continueRun(): Promise<ScriptRunOutcome> {
		const p = this.pending;
		if (!p) return { status: 'noRunning' };
		p.rearmWindow();
		return p.deferred.promise;
	}

	/**
	 * 终止挂起的脚本(LLM 显式决策;不计熔断 — 计数口径由工具层负责)。
	 *
	 * @returns 无挂起脚本时 noRunning;否则 killed(挂起轮次的 deferred 同步 resolve killed,不悬空)
	 */
	async killRun(): Promise<ScriptRunOutcome> {
		if (!this.pending) return { status: 'noRunning' };
		this.killPending();
		return { status: 'killed' };
	}

	/** 插件 unload 时击杀活跃 Worker(孤儿线程兜底);挂起轮次同步 resolve killed,不悬空 */
	terminateAll(): void {
		// 关键路径:pending 先 finish(killed,内含 terminate),防 exit 兜底覆盖 outcome
		if (this.pending) this.killPending();
		this.activeWorker?.terminate();
		this.activeWorker = null;
	}

	/** 隐含终止挂起的运行(新 run 进入 / unload):finish(killed) 内含 terminate 回收 */
	private killPending(): void {
		const p = this.pending;
		if (!p) return;
		// finish 置 done 后 terminate;旧 worker 的 exit 兜底因 done=true 不会二次 resolve
		p.finish({ status: 'killed' });
	}

	private runExclusive(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
		return new Promise<ScriptRunOutcome>((resolve) => {
			// 关键路径:串行链放行后进入;上一脚本仍挂起(stillRunning)→ 隐含终止(ADR-017 §3 续等期间来新 run)
			if (this.pending) this.killPending();

			const worker = this.createWorker(this.workerCode);
			this.activeWorker = worker;
			const softMs = req.softTimeoutMs ?? SOFT_TIMEOUT_MS;
			const maxRunMs = req.maxRunMs ?? MAX_RUN_MS;
			const startMs = Date.now();
			/** 终态标志(ok/scriptError/timeout/killed/crashed);stillRunning 挂起不算终态 */
			let done = false;
			let lastBeat = Date.now();
			let softFired = false;
			let hadProgress = false;
			let lastProgress: string | undefined;
			/** 无心跳窗口定时器;stillRunning 挂起时清掉,由 continueRun 重置 */
			let windowTimer = 0;
			/** 当前轮 resolver:首轮是 run 的 resolve;每次 stillRunning 后换成新 deferred 的 resolve */
			let resolveCurrent: (o: ScriptRunOutcome) => void = resolve;

			const finish = (outcome: ScriptRunOutcome) => {
				if (done) return;
				done = true;
				window.clearTimeout(windowTimer);
				window.clearInterval(beatTimer);
				if (this.pending?.worker === worker) this.pending = null;
				if (this.activeWorker === worker) this.activeWorker = null;
				resolveCurrent(outcome);
				// 关键路径(修复):一次性 Worker 终态即回收 — 旧实现 ok/scriptError 后不 terminate,
				// 每次成功执行都漏一个闲置线程(浏览器 Worker 与 worker_threads 均如此)。
				worker.terminate();
			};

			// ==================== 巡检:软超时警告 + stalled 判死 + 绝对上限 ====================
			const beatTimer = window.setInterval(() => {
				if (done) return;
				if (!softFired && Date.now() - lastBeat >= softMs) {
					softFired = true;
					req.onSoftTimeout?.();
				}
				// 关键路径:绝对上限 — 自启动累计,不随 continueRun 重置(ADR-017 v1.1 §3「赖」)
				if (Date.now() - startMs >= maxRunMs) {
					finish({ status: 'timeout', kind: 'maxDuration', hadProgress });
					void worker.terminate();
					return;
				}
				// 关键路径:stalled 判死 — 停跳满 timeoutMs 即杀,不等窗口到点(中途停跳也能及时判死)
				if (Date.now() - lastBeat >= req.timeoutMs) {
					finish({ status: 'timeout', kind: 'stalled', hadProgress });
					void worker.terminate();
				}
			}, HEARTBEAT_CHECK_INTERVAL_MS);

			// ==================== 窗口到点:按心跳分类(ADR-017 v1.1 §3) ====================
			const armWindow = () => {
				window.clearTimeout(windowTimer);
				windowTimer = window.setTimeout(() => {
					if (done) return;
					// 绝对上限优先(防御:巡检 1s 粒度可能略晚于窗口到点)
					if (Date.now() - startMs >= maxRunMs) {
						finish({ status: 'timeout', kind: 'maxDuration', hadProgress });
						void worker.terminate();
						return;
					}
					if (hadProgress && Date.now() - lastBeat < req.timeoutMs) {
						// 有心跳 → 不杀:resolve 当前轮 stillRunning,挂 pending 等决策
						suspendAsStillRunning();
						return;
					}
					// 防御性击杀:零心跳或已停跳满窗口(正常该被 stalled 巡检先杀)
					finish({ status: 'timeout', kind: 'stalled', hadProgress });
					void worker.terminate();
				}, req.timeoutMs);
			};

			// ==================== stillRunning 挂起 ====================
			const suspendAsStillRunning = () => {
				resolveCurrent({ status: 'stillRunning', elapsedMs: Date.now() - startMs, lastProgress, hadProgress });
				const deferred = withResolvers<ScriptRunOutcome>();
				resolveCurrent = deferred.resolve;
				// 窗口定时器已到点触发,清掉;巡检保留(挂起期间仍要判 stalled/maxDuration)
				window.clearTimeout(windowTimer);
				// 覆盖式更新:多轮续等时旧 deferred 已 resolve,换新 deferred 供下一轮 continueRun await
				this.pending = { worker, deferred, finish, rearmWindow: armWindow };
			};

			// ==================== worker 消息与兜底 ====================
			worker.onMessage((msg) => {
				if (done) return;
				lastBeat = Date.now();
				if (msg?.type === 'progress') {
					hadProgress = true;
					lastProgress = String(msg.message ?? '');
					req.onProgress?.(lastProgress);
				} else if (msg?.type === 'log') {
					// worker 内 console 透传,吞掉即可(dev 细节不进用户日志)
				} else if (msg?.type === 'done' && msg.result) {
					const r = msg.result;
					finish(r.ok ? { status: 'ok', result: r.result ?? '' } : { status: 'scriptError', error: r.error ?? 'unknown', stack: r.stack });
				}
			});
			worker.onError((message) => finish({ status: 'crashed', detail: message }));
			// 关键路径:exit 兜底 — terminate/崩溃后保证 Promise 不悬空(ADR-017 兜底三件套之三);
			// 浏览器 Worker 无 exit 事件(适配层空实现),Node worker_threads 保留此兜底
			worker.onExit(() => {
				if (!done) finish({ status: 'crashed', detail: 'worker exited unexpectedly' });
			});

			armWindow();
			worker.postMessage({ type: 'run', code: req.code, args: req.args, allowedDirs: req.allowedDirs });
		});
	}
}
