/**
 * @file src/worker/skill-script-worker.ts
 * @description Skill 脚沙箱 Worker 入口 — 跨环境兼容(Node worker_threads ↔ 浏览器 Web Worker)
 * @module worker/skill-script-worker
 * @depends node:vm, node:fs, node:path
 *
 * 关键路径:
 * - 本文件运行在 Worker 线程内,严禁 import 'obsidian'。
 * - Worker 一次性:主线程每次 run 新起、跑完 terminate,本入口不做状态保持。
 * - esbuild 打成 CJS 字符串内联进 main.js,运行时通过 Blob URL 在浏览器 Web Worker 加载,
 *   或在 vitest/本地 Node 环境通过 new worker_threads.Worker(code, { eval: true }) 加载。
 *
 * 跨环境通信:
 * - Node worker_threads(vitest/本地):parentPort 非 null → 走 parentPort.on/postMessage
 * - 浏览器 Web Worker(Obsidian Electron,nodeIntegrationInWorker=true):
 *   parentPort 为 null(Worker 由 new Worker(url) 创建,非 worker_threads.Worker)
 *   → 走 self.onmessage/self.postMessage(Electron 注入了 Node require,vm/fs/path 可用)
 */

// 关键路径:node:worker_threads 在两种环境下都能 require 成功,但浏览器 Web Worker 中 parentPort 为 null,
// 不能直接 .on/.postMessage,运行时通过 createPort() 检测后选择正确通道。
import { parentPort, workerData } from 'node:worker_threads';
import { runInVmSandbox, type VmSandboxRequest, type VmSandboxResult } from '../skills/script-vm';

interface RunMessage {
	type: 'run';
	code: string;
	args: string[];
	allowedDirs: string[];
}

/** Worker → 主线程消息(与主线程 SandboxWorkerHandle 协议一致) */
type OutboundMessage =
	| { type: 'progress'; message: string }
	| { type: 'log'; level: string; message: string }
	| { type: 'done'; result: VmSandboxResult };

/**
 * 跨环境通信端口,屏蔽 Node worker_threads 与浏览器 Web Worker API 差异。
 *
 * 设计要点:
 * - 优先检测 parentPort(Node 路径);若为 null/undefined 则走 self(浏览器路径)。
 * - Node worker_threads 中 self 不保证存在,故不能用 self 是否存在作为判断条件。
 */
interface WorkerPort {
	onMessage(handler: (msg: RunMessage) => void): void;
	postMessage(msg: OutboundMessage): void;
}

/** 浏览器 DedicatedWorkerGlobalScope 的最小子集 — 只声明本文件用到的成员,避免 any 与 WebWorker lib 依赖 */
interface BrowserWorkerScope {
	onmessage: ((e: MessageEvent) => void) | null;
	postMessage(msg: unknown): void;
}

function createPort(): WorkerPort {
	// Node worker_threads 路径:parentPort 是 MessagePort 实例
	// 关键路径:赋值给局部常量避免闭包中 TS 不收敛 null 类型
	const nodePort = parentPort;
	if (nodePort) {
		return {
			onMessage: (h) => nodePort.on('message', h),
			postMessage: (msg) => nodePort.postMessage(msg),
		};
	}
	// 浏览器 Web Worker 路径(Obsidian Electron nodeIntegrationInWorker):
	// self 是 DedicatedWorkerGlobalScope,onmessage/postMessage 是标准 Web Worker API。
	// 关键路径:浏览器 message 事件载荷在 MessageEvent.data 内,此处解包。
	// 类型断言经 unknown 中转:Window 与 Worker scope 类型不重叠,直接 as 会报错
	const workerSelf = self as unknown as BrowserWorkerScope;
	return {
		onMessage: (h) => {
			workerSelf.onmessage = (e: MessageEvent) => {
				h(e.data as RunMessage);
			};
		},
		postMessage: (msg) => workerSelf.postMessage(msg),
	};
}

/** workerData 仅在 Node worker_threads eval 模式下可用;浏览器 Web Worker 中为 undefined,回退空数组 */
const fallbackDirs: string[] = Array.isArray((workerData as { allowedDirs?: string[] } | undefined)?.allowedDirs)
	? (workerData as { allowedDirs: string[] }).allowedDirs
	: [];

const port = createPort();

port.onMessage((msg: RunMessage) => {
	if (msg?.type !== 'run') return;
	const req: VmSandboxRequest = {
		code: msg.code,
		args: msg.args,
		allowedDirs: msg.allowedDirs ?? fallbackDirs,
		onProgress: (m) => port.postMessage({ type: 'progress', message: m }),
		onLog: (level, m) => port.postMessage({ type: 'log', level, message: String(m) }),
	};
	const result: VmSandboxResult = runInVmSandbox(req);
	port.postMessage({ type: 'done', result });
});
