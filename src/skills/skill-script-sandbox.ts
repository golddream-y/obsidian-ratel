/**
 * @file src/skills/skill-script-sandbox.ts
 * @description Skill 脚本沙箱主线程运行器 — Worker 生命周期 / 心跳分类超时状态机 / 并发=1(ADR-017 v1.1)
 * @module skills/skill-script-sandbox
 * @depends node:worker_threads
 */

import { Worker } from 'node:worker_threads';

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
export type WorkerFactory = (code: string) => Worker;

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
	worker: Worker;
	/** 当前轮的等待句柄;每次 stillRunning 轮次推进时换新 */
	deferred: Deferred<ScriptRunOutcome>;
	/** 终态收尾(清定时器 + resolve 当前轮 + 清 pending) */
	finish: (outcome: ScriptRunOutcome) => void;
	/** 重置无心跳窗口定时器(continueRun 调用;startMs/lastBeat 均不重置) */
	rearmWindow: () => void;
}

/**
 * Skill 脚本沙箱运行器。
 *
 * 设计要点(ADR-017 v1.1):
 * - 每次执行 new Worker(code, { eval: true }),跑完即弃;死循环由 terminate() 毫秒级击杀
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
	private activeWorker: Worker | null = null;
	/** 挂起的运行(stillRunning 后);全局单个 — 不做后台多脚本并行 */
	private pending: PendingRun | null = null;

	constructor(
		private readonly workerCode: string,
		private readonly createWorker: WorkerFactory = (code) => new Worker(code, { eval: true }),
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
		// 关键路径:pending 先 finish(killed) 再 terminate,防 exit 兜底覆盖 outcome
		if (this.pending) this.killPending();
		// 关键路径:terminate 返回 Promise,void 抑制 floating-promise;失败无需善后(线程已死)
		void this.activeWorker?.terminate();
		this.activeWorker = null;
	}

	/** 隐含终止挂起的运行(新 run 进入 / unload):terminate + resolve killed */
	private killPending(): void {
		const p = this.pending;
		if (!p) return;
		// 先 finish(killed) 再 terminate:finish 置 done 后,旧 worker 的 exit 兜底不会二次 resolve
		p.finish({ status: 'killed' });
		void p.worker.terminate();
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
			worker.on('message', (msg: { type?: string; message?: string; level?: string; result?: { ok: boolean; result?: string; error?: string; stack?: string } }) => {
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
			worker.on('error', (err: Error) => finish({ status: 'crashed', detail: err.message }));
			// 关键路径:exit 兜底 — terminate/崩溃后保证 Promise 不悬空(ADR-017 兜底三件套之三)
			worker.on('exit', () => {
				if (!done) finish({ status: 'crashed', detail: 'worker exited unexpectedly' });
			});

			armWindow();
			worker.postMessage({ type: 'run', code: req.code, args: req.args, allowedDirs: req.allowedDirs });
		});
	}
}
