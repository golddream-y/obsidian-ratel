/**
 * @file src/worker/embedding-worker.ts
 * @description Web Worker 入口 — 加载 ONNX runtime,处理 embed 请求,不依赖 Node API
 * @module worker/embedding-worker
 * @depends adapters/embedding-onnx
 *
 * 硬约束:
 * - 严禁 `import 'obsidian'`
 * - 不发 HTTP 请求(纯 CPU WASM 推理)
 * - 不使用 `node:fs` / `node:path`(纯浏览器环境)
 * - 与主线程通过 postMessage 通信
 *
 * 设计要点:
 * - 主线程在构造时传入 modelBuffer + vocabPath + wasmBinary,Worker 内部初始化 EmbeddingOnnx。
 * - init 完成后回复 ready,之前所有 embed 请求回复 error。
 * - embed 请求用 requestId 关联响应。
 */

import { EmbeddingOnnx } from '../adapters/embedding-onnx';
import type { EmbeddingOnnxDeps } from '../adapters/embedding-onnx';

// 关键路径:模块级状态,Worker 整个生命周期内只持有一个 EmbeddingOnnx 实例;
// init 完成前为 null,所有 embed 请求会被拒绝。
let embeddingOnnx: EmbeddingOnnx | null = null;

self.onmessage = async (e: MessageEvent): Promise<void> => {
	const msg = e.data;

	switch (msg.type) {
		case 'init': {
			try {
				const deps = msg.deps as EmbeddingOnnxDeps;
				const dimensions = msg.dimensions as number;
				const maxBatchSize = msg.maxBatchSize as number;
				embeddingOnnx = new EmbeddingOnnx(deps, dimensions, maxBatchSize);
				await embeddingOnnx.init();
				self.postMessage({ type: 'ready' });
			} catch (err) {
				// 关键路径:初始化失败回复 error(无 requestId,广播式),主线程据此销毁 Worker。
				const error = err instanceof Error ? err.message : String(err);
				self.postMessage({ type: 'error', error: `初始化失败: ${error}` });
			}
			break;
		}
		case 'embed': {
			// 关键路径:未 init 直接发 embed — 用 requestId 关联,回复 error 让主线程降级。
			if (!embeddingOnnx) {
				self.postMessage({
					type: 'error',
					requestId: msg.requestId,
					error: 'Worker 未初始化,请先发送 init 消息',
				});
				return;
			}
			try {
				const vectors = await embeddingOnnx.embed(msg.texts as string[]);
				self.postMessage({
					type: 'embed:result',
					requestId: msg.requestId,
					vectors,
				});
			} catch (err) {
				// 关键路径:推理失败仍带 requestId,主线程按 requestId reject 对应 Promise。
				const error = err instanceof Error ? err.message : String(err);
				self.postMessage({
					type: 'error',
					requestId: msg.requestId,
					error: `推理失败: ${error}`,
				});
			}
			break;
		}
	}
};
