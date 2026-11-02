/**
 * @file src/worker/index-runtime-browser.ts
 * @description 浏览器侧运行时装配 — 把内联代码装成常驻 Blob Worker 并接入宿主
 * @module src/worker/index-runtime-browser
 *
 * 关键路径:
 * - Worker 代码随 main.js 内联,运行时用 Blob URL 拉起,商店三文件不变。
 * - Blob URL 只在终止时回收,不在每次请求后回收:常驻 Worker 复用同一条 URL。
 * - 该 Worker 依宿主 Node 集成取得文件能力;拿不到时由入口如实报错,不静默降级成内存实现。
 */

import { INDEX_RUNTIME_WORKER_CODE } from '@ratel/index-runtime-worker-code';
import { IndexRuntimeHost, type RuntimeWorkerLike } from './index-runtime-host';

/** 把内联 Worker 代码装成常驻 Worker。 */
export function createInlineRuntimeWorker(code: string = INDEX_RUNTIME_WORKER_CODE): RuntimeWorkerLike {
	const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
	const worker = new Worker(url);
	let closed = false;
	const handle: RuntimeWorkerLike = {
		postMessage: (message) => worker.postMessage(message),
		terminate: () => {
			if (closed) return;
			closed = true;
			worker.terminate();
			URL.revokeObjectURL(url);
		},
		get onmessage() {
			return worker.onmessage as RuntimeWorkerLike['onmessage'];
		},
		set onmessage(handler) {
			worker.onmessage = handler as ((event: MessageEvent<unknown>) => void) | null;
		},
		get onerror() {
			return worker.onerror as RuntimeWorkerLike['onerror'];
		},
		set onerror(handler) {
			worker.onerror = handler as ((event: ErrorEvent) => void) | null;
		},
	};
	return handle;
}

/** 构造常驻索引运行时宿主。 */
export function createInlineIndexRuntimeHost(options: {
	runtimeId?: string;
	requestTimeoutMs?: number;
	maxInflight?: number;
	maxInflightBytes?: number;
} = {}): IndexRuntimeHost {
	return new IndexRuntimeHost({
		createWorker: () => createInlineRuntimeWorker(),
		...options,
	});
}
