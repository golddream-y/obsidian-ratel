/**
 * @file src/skills/skill-script-sandbox.ts
 * @description Skill 脚本沙箱主线程运行器 — Worker 生命周期 / 双层超时 / 并发=1(ADR-017)
 * @module skills/skill-script-sandbox
 * @depends node:worker_threads
 */

import { Worker } from 'node:worker_threads';

/** 软超时:10s 无心跳 → onSoftTimeout 警告(慢,可继续等)— ADR-017 §3 */
export const SOFT_TIMEOUT_MS = 10_000;
/** 心跳巡检间隔(性能:1s 粒度足够,不值得更细) */
const HEARTBEAT_CHECK_INTERVAL_MS = 1_000;

export interface ScriptRunRequest {
	code: string;
	args: string[];
	allowedDirs: string[];
	/** 硬超时(ms)—— settings.skillScriptTimeout */
	timeoutMs: number;
	/** 软超时(ms),默认 SOFT_TIMEOUT_MS */
	softTimeoutMs?: number;
	onProgress?: (message: string) => void;
	/** 软超时警告回调(每次 run 至多一次) */
	onSoftTimeout?: () => void;
}

export type ScriptRunOutcome =
	| { status: 'ok'; result: string }
	| { status: 'scriptError'; error: string; stack?: string }
	| { status: 'timeout'; hadProgress: boolean }
	| { status: 'crashed'; detail?: string };

/** Worker 构造工厂签名 — 测试可注入裸 JS worker(协议兼容) */
export type WorkerFactory = (code: string) => Worker;

/**
 * Skill 脚本沙箱运行器。
 *
 * 设计要点(ADR-017):
 * - 每次执行 new Worker(code, { eval: true }),跑完即弃;死循环由 terminate() 毫秒级击杀
 * - 并发 = 1:内部 promise 链串行,防 LLM 连环调用起一堆 Worker
 * - 软超时只警告不终止;硬超时无条件 terminate
 * - exit 监听兜底:即使 terminate 异常,pending Promise 也不悬空
 * - terminateAll 供插件 onunload 调用,不留孤儿线程
 *
 * @example
 *   const sandbox = new SkillScriptSandbox(code);
 *   const outcome = await sandbox.run({ code: '1+1', args: [], allowedDirs: [dir], timeoutMs: 30_000 });
 */
export class SkillScriptSandbox {
	/** 串行链 — 并发 = 1(ADR-017 兜底三件套之一) */
	private chain: Promise<unknown> = Promise.resolve();
	/** 当前活跃 worker(terminateAll 目标) */
	private activeWorker: Worker | null = null;

	constructor(
		private readonly workerCode: string,
		private readonly createWorker: WorkerFactory = (code) => new Worker(code, { eval: true }),
	) {}

	/** 串行执行一次脚本;前序未完成时自动排队 */
	run(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
		const next = this.chain.then(() => this.runExclusive(req), () => this.runExclusive(req));
		// 关键路径:链尾吞错,单个失败不阻断后续排队
		this.chain = next.then(() => undefined, () => undefined);
		return next;
	}

	/** 插件 unload 时击杀活跃 Worker(孤儿线程兜底) */
	terminateAll(): void {
		// 关键路径:terminate 返回 Promise,void 抑制 floating-promise;失败无需善后(线程已死)
		void this.activeWorker?.terminate();
		this.activeWorker = null;
	}

	private runExclusive(req: ScriptRunRequest): Promise<ScriptRunOutcome> {
		return new Promise<ScriptRunOutcome>((resolve) => {
			const worker = this.createWorker(this.workerCode);
			this.activeWorker = worker;
			const softMs = req.softTimeoutMs ?? SOFT_TIMEOUT_MS;
			let settled = false;
			let lastBeat = Date.now();
			let softFired = false;
			let hadProgress = false;

			const finish = (outcome: ScriptRunOutcome) => {
				if (settled) return;
				settled = true;
				window.clearTimeout(hardTimer);
				window.clearInterval(beatTimer);
				if (this.activeWorker === worker) this.activeWorker = null;
				resolve(outcome);
			};

			// 关键路径:软超时巡检 — 任何消息(progress/log)都复位心跳
			const beatTimer = window.setInterval(() => {
				if (settled) return;
				if (!softFired && Date.now() - lastBeat >= softMs) {
					softFired = true;
					req.onSoftTimeout?.();
				}
			}, HEARTBEAT_CHECK_INTERVAL_MS);

			// 关键路径:硬超时无条件击杀(有心跳照样杀 — 上限即上限,ADR-017 §3)
			const hardTimer = window.setTimeout(() => {
				finish({ status: 'timeout', hadProgress });
				// 关键路径:terminate 返回 Promise,void 抑制 floating-promise;击杀失败线程也已不可用
				void worker.terminate();
			}, req.timeoutMs);

			worker.on('message', (msg: { type?: string; message?: string; level?: string; result?: { ok: boolean; result?: string; error?: string; stack?: string } }) => {
				lastBeat = Date.now();
				if (msg?.type === 'progress') {
					hadProgress = true;
					req.onProgress?.(String(msg.message ?? ''));
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
				if (!settled) finish({ status: 'crashed', detail: 'worker exited unexpectedly' });
			});

			worker.postMessage({ type: 'run', code: req.code, args: req.args, allowedDirs: req.allowedDirs });
		});
	}
}
