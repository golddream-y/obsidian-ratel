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
 *
 * T5 分道规则(与 `src/worker/index.ts` 共用 `WorkerMessageLane`):
 * - 索引请求串行;
 * - 只读请求(查询/状态)不与索引队列串行,但提交窗口内延后 —— 长推理不再阻塞查询,
 *   查询也不会读到文件事务的中间状态;
 * - `index.cancel` 越过串行队列立即生效(取消不能排在一整个索引请求后面)。
 */

import type { WorkerRequest, WorkerResponse } from '../types';
import { isWorkerReadRequest, isWorkerStoreWriteRequest } from '../types';
import { VectraStore } from '../adapters/vector-vectra';
import { handleMessage, initProcessorWithStore, cancelIndexRun, WorkerMessageLane } from './handler';
import type { WorkerLike } from './manager';
import type { EmbeddingPort } from '../ports/embedding';

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
	/** 索引串行 / 只读并行 / 提交窗口的分道策略。 */
	private readonly lane = new WorkerMessageLane();

	/**
	 * 用已构造好的 VectraStore 初始化 processor。
	 *
	 * 关键路径:InlineWorker 创建时模型可能尚未下载完成,
	 * 因此把 init 延迟到主线程 onLayoutReady 模型就绪后。
	 * `embeddingPort`(EmbeddingPort)由主线程注入,IndexProcessor 用它批量 embed chunk 文本。
	 */
	initWithStore(store: VectraStore, embeddingPort: EmbeddingPort): void {
		initProcessorWithStore(store, embeddingPort);
	}

	/**
	 * 模拟 Worker.postMessage,按消息类型分道调度。
	 *
	 * 关键路径:setTimeout(..., 0) 让调用方保持"异步请求-响应"语义,
	 * 虽然实际仍在同一线程执行,但避免同步返回破坏 WorkerManager 的假设。
	 * postEvent 回调也用 setTimeout(0) 异步派发,与真实 Worker 的消息时序一致。
	 */
	postMessage(message: WorkerRequest & { _requestId?: string }): void {
		if (this.terminated) return;

		if (message.type === 'index.cancel') {
			// 关键路径:取消必须立即生效 —— 排进索引串行队列等于让取消等一整轮索引跑完。
			window.setTimeout(() => {
				if (this.terminated) return;
				const cancelled = cancelIndexRun(message.payload);
				this.emitMessage({ type: 'index.cancel.done', payload: { cancelled } });
			}, 0);
			return;
		}

		if (isWorkerReadRequest(message.type)) {
			window.setTimeout(() => {
				if (this.terminated) return;
				this.lane.scheduleRead(() => this.handle(message));
			}, 0);
			return;
		}

		window.setTimeout(() => {
			if (this.terminated) return;

			// 关键路径:同一索引只允许一条消息执行,失败也必须释放队列。
			this.lane.scheduleIndex(() => this.handle(message));
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
		this.lane.clear();
	}

	/**
	 * 派发事件消息给所有 message 监听器(异步,与 postMessage 语义一致)。
	 */
	private emitMessage(msg: WorkerResponse & { _requestId?: string }): void {
		window.setTimeout(() => {
			if (this.terminated) return;
			for (const listener of this.messageListeners) {
				listener(msg);
			}
		}, 0);
	}

	private async handle(msg: WorkerRequest & { _requestId?: string }): Promise<void> {
		const isRead = isWorkerReadRequest(msg.type);
		// 关键路径(B1):整个请求就是一次存储事务的写请求没有 `persist` 活动通道,
		// 提交窗口由请求本身开启,并在请求结束时关闭。
		if (isWorkerStoreWriteRequest(msg.type)) this.lane.openCommitWindow();
		// 关键路径:postEvent 通过 emitMessage 异步派发,让进度/活动事件在请求响应前到达主线程。
		const postEvent = (eventMsg: WorkerResponse) => {
			if (!isRead) this.lane.observeEvent(eventMsg);
			// 关键路径:活动包自带 taskId/requestId,不再叠加信封 `_requestId` ——
			// 现有消费者把「带 _requestId 的非进度消息」当作终态响应,而活动是进度信号。
			const forwarded = eventMsg.type === 'index.activity' ? eventMsg : { ...eventMsg, _requestId: msg._requestId };
			this.emitMessage(forwarded);
		};

		try {
			const response = await handleMessage(msg, postEvent);
			if (msg._requestId) {
				(response as Record<string, unknown>)._requestId = msg._requestId;
			}
			this.emitMessage(response);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.emitMessage({ type: 'error', payload: { code: 'WORKER_ERROR', message: error.message }, _requestId: msg._requestId });
		}
		finally {
			// 关键路径:索引请求结束即关闭提交窗口(只读任务不参与窗口维护)。
			if (!isRead) this.lane.closeCommitWindow();
		}
	}
}