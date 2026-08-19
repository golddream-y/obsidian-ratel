/**
 * @file src/worker/skill-script-worker.ts
 * @description Skill 脚沙箱 Worker Thread 入口 — 收 run 消息,跑 vm 沙箱,回 done(ADR-017)
 * @module worker/skill-script-worker
 * @depends node:worker_threads, skills/script-vm
 *
 * 关键路径:
 * - 本文件运行在 worker_threads(纯 Node),严禁 import 'obsidian'。
 * - Worker 一次性:主线程每次 run 新起、跑完 terminate,本入口不做状态保持。
 * - esbuild 打成 CJS 字符串内联进 main.js,运行时 new Worker(code, { eval: true })。
 */

import { parentPort, workerData } from 'node:worker_threads';
import { runInVmSandbox, type VmSandboxRequest, type VmSandboxResult } from '../skills/script-vm';

interface RunMessage {
	type: 'run';
	code: string;
	args: string[];
	allowedDirs: string[];
}

/** workerData.allowedDirs 用于定 cwd;run 消息为主协议(与测试用裸 worker 兼容) */
const fallbackDirs: string[] = Array.isArray((workerData as { allowedDirs?: string[] } | undefined)?.allowedDirs)
	? (workerData as { allowedDirs: string[] }).allowedDirs
	: [];

parentPort?.on('message', (msg: RunMessage) => {
	if (msg?.type !== 'run') return;
	const req: VmSandboxRequest = {
		code: msg.code,
		args: msg.args,
		allowedDirs: msg.allowedDirs ?? fallbackDirs,
		onProgress: (m) => parentPort?.postMessage({ type: 'progress', message: m }),
		onLog: (level, m) => parentPort?.postMessage({ type: 'log', level, message: String(m) }),
	};
	const result: VmSandboxResult = runInVmSandbox(req);
	parentPort?.postMessage({ type: 'done', result });
});
