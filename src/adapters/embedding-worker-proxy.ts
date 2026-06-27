/**
 * @file src/adapters/embedding-worker-proxy.ts
 * @description EmbeddingWorkerProxy — Web Worker 代理,实现 EmbeddingPort,ONNX 推理在 Worker 线程
 * @module adapters/embedding-worker-proxy
 * @depends ports/embedding, adapters/embedding-onnx
 *
 * 设计要点:
 * - 实现 EmbeddingPort 接口,对上层(IndexProcessor / SearchVault)透明。
 * - postMessage 到 Web Worker,Worker 内跑 EmbeddingOnnx 的 ONNX WASM 推理。
 * - 请求/响应用 requestId 关联,支持并发 embed 请求。
 * - Worker 创建失败不降级,由调用方处理(提示用户接 API Embedding)。
 */

import type { EmbeddingPort } from '../ports/embedding';
import type { EmbeddingOnnxDeps } from './embedding-onnx';

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

type WorkerRequest = WorkerInitMessage | WorkerEmbedMessage;

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
 * - 构造时创建 Worker 并发送 init 消息(含模型依赖)。
 * - `ready` Promise 在 Worker 返回 ready 后 resolve;之前所有 embed 调用 await。
 * - embed 请求用自增 requestId 关联响应,支持并发。
 * - Worker 崩溃时所有 pending 请求 reject。
 * - 模型依赖(ArrayBuffer)用 transferable 转移所有权,避免复制大文件。
 *
 * @example
 *   const proxy = new EmbeddingWorkerProxy(workerUrl, deps, 512);
 *   await proxy.ready;
 *   const vectors = await proxy.embed(['hello world']);
 */
export class EmbeddingWorkerProxy implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId: string;
	private worker: Worker;
	private readyPromise: Promise<void>;
	private pending = new Map<string, (vectors: number[][]) => void>();
	private pendingError = new Map<string, (err: Error) => void>();
	private requestCounter = 0;

	constructor(
		workerUrl: string,
		deps: EmbeddingOnnxDeps,
		dimensions: number,
		maxBatchSize = 16,
	) {
		this.dimensions = dimensions;
		this.modelId = deps.modelId ?? 'local:bge-small-zh-v1.5';
		this.worker = new Worker(workerUrl);

		// 关键路径:init 完成前 ready 不 resolve;init 失败则 reject。
		this.readyPromise = new Promise((resolve, reject) => {
			const onInitMessage = (e: MessageEvent) => {
				const data = e.data as WorkerResponse;
				if (data.type === 'ready') {
					resolve();
				} else if (data.type === 'error' && !data.requestId) {
					reject(new Error(data.error));
				}
			};
			this.worker.addEventListener('message', onInitMessage);
		});

		// 关键路径:init 完成后的常规消息处理(embed:result / error)。
		this.worker.addEventListener('message', (e: MessageEvent) => {
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

		// 关键路径:Worker 崩溃时所有 pending 请求 reject。
		this.worker.addEventListener('error', (err: ErrorEvent) => {
			for (const [, reject] of this.pendingError) {
				reject(new Error(`Embedding Worker 崩溃: ${err.message}`));
			}
			this.pending.clear();
			this.pendingError.clear();
		});

		// 关键路径:发送 init 消息,用 transferable 转移 ArrayBuffer 所有权。
		const initMsg: WorkerInitMessage = { type: 'init', deps, dimensions, maxBatchSize };
		const transferables = [deps.modelBuffer, deps.wasmBinary];
		this.worker.postMessage(initMsg, transferables);
	}

	/**
	 * Worker init 完成的 Promise。调用方可 await 确保 Worker 就绪。
	 */
	get ready(): Promise<void> {
		return this.readyPromise;
	}

	/**
	 * 批量生成文本向量。
	 *
	 * @param texts - 待编码文本数组。
	 * @returns 与 texts 等长的向量数组。
	 * @throws Worker 未就绪、推理失败或 Worker 崩溃时抛错。
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		await this.readyPromise;

		const requestId = `embed_${++this.requestCounter}`;
		return new Promise((resolve, reject) => {
			this.pending.set(requestId, resolve);
			this.pendingError.set(requestId, reject);
			const msg: WorkerEmbedMessage = { type: 'embed', texts, requestId };
			this.worker.postMessage(msg);
		});
	}

	/**
	 * 终止 Worker — 释放 Worker 线程资源。
	 */
	terminate(): void {
		this.worker.terminate();
		for (const [, reject] of this.pendingError) {
			reject(new Error('Embedding Worker 已终止'));
		}
		this.pending.clear();
		this.pendingError.clear();
	}
}
