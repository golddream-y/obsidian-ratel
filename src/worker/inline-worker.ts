/**
 * @file src/worker/inline-worker.ts
 * @description InlineWorker — 主线程内模拟 Worker,用于 Obsidian 渲染进程无法创建 Worker Threads 时的降级
 * @module worker/inline-worker
 * @depends worker/handler, worker/manager, adapters/vector-vectra
 *
 * 设计要点:
 * - 实现 WorkerLike 接口,对 WorkerManager 透明。
 * - 直接调用 handleMessage,响应通过 setTimeout(..., 0) 异步回调,模拟 postMessage。
 * - 复用主线程的 VectraStore,避免双写冲突。
 * - 不导入 obsidian,与 Worker 约束一致。
 */

import type { WorkerRequest, WorkerResponse } from '../types';
import { VectraStore } from '../adapters/vector-vectra';
import { handleMessage, initProcessorWithStore } from './handler';
import type { WorkerLike } from './manager';

type MessageListener = (data: WorkerResponse & { _requestId?: string }) => void;
type ErrorListener = (err: Error) => void;
type ExitListener = (code: number) => void;

/**
 * 主线程内 Worker 模拟器。
 *
 * 适用场景:Obsidian 渲染进程的 V8 平台禁用了 Worker Threads,
 * 但 vectra 需要 Node fs,Web Worker 无 Node 集成也无法使用。
 *
 * 副作用:CPU 密集型操作(分块、向量化、索引 IO)会在主线程执行,
 * 大 vault 全量索引时可能短暂阻塞 UI。
 */
export class InlineWorker implements WorkerLike {
	private messageListeners: MessageListener[] = [];
	private errorListeners: ErrorListener[] = [];
	private exitListeners: ExitListener[] = [];
	private terminated = false;
	private initialized = false;

	/**
	 * 用已构造好的 VectraStore 初始化 processor。
	 *
	 * 关键路径:InlineWorker 创建时模型可能尚未下载完成,
	 * 因此把 init 延迟到主线程 onLayoutReady 模型就绪后。
	 */
	initWithStore(store: VectraStore): void {
		initProcessorWithStore(store);
		this.initialized = true;
	}

	/**
	 * 模拟 Worker.postMessage,异步调用 handleMessage。
	 *
	 * 关键路径:setTimeout(..., 0) 让调用方保持"异步请求-响应"语义,
	 * 虽然实际仍在同一线程执行,但避免同步返回破坏 WorkerManager 的假设。
	 */
	postMessage(message: WorkerRequest & { _requestId?: string }): void {
		if (this.terminated) return;

		setTimeout(() => {
			if (this.terminated) return;

			void this.handle(message);
		}, 0);
	}

	/**
	 * 注册事件监听器,兼容 Node Worker Threads 的三个事件。
	 */
	on(event: 'message' | 'error' | 'exit', listener: MessageListener | ErrorListener | ExitListener): void {
		if (event === 'message') {
			this.messageListeners.push(listener as MessageListener);
		} else if (event === 'error') {
			this.errorListeners.push(listener as ErrorListener);
		} else if (event === 'exit') {
			this.exitListeners.push(listener as ExitListener);
		}
	}

	/**
	 * 终止 InlineWorker — 清空监听器,后续 postMessage 不再处理。
	 */
	terminate(): void {
		this.terminated = true;
		this.messageListeners = [];
		this.errorListeners = [];
		this.exitListeners = [];
	}

	private async handle(msg: WorkerRequest & { _requestId?: string }): Promise<void> {
		try {
			const response = await handleMessage(msg);
			if (msg._requestId) {
				(response as Record<string, unknown>)._requestId = msg._requestId;
			}
			for (const listener of this.messageListeners) {
				listener(response as WorkerResponse & { _requestId?: string });
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			for (const listener of this.errorListeners) {
				listener(error);
			}
		}
	}
}
