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
 * - 主线程在构造时传入 modelBuffer + vocabContent + wasmBinary,Worker 内部初始化 EmbeddingOnnx。
 * - init 完成后回复 ready,之前所有 embed 请求回复 error。
 * - embed 请求用 requestId 关联响应。
 * - T5:每个真实完成的批次回 `embed:progress`;`cancel` 消息按 requestId 中止对应请求的
 *   `AbortController`,推理在批次边界停止 —— 不为取消单项任务终止整个运行时。
 */

import { EmbeddingOnnx } from '../adapters/embedding-onnx';
import type { EmbeddingOnnxDeps } from '../adapters/embedding-onnx';

// 关键路径:模块级状态,Worker 整个生命周期内只持有一个 EmbeddingOnnx 实例;
// init 完成前为 null,所有 embed 请求会被拒绝。
let embeddingOnnx: EmbeddingOnnx | null = null;
/** 环境能力探测结果 — 随 ready 回传,避免在 Worker 里直接打控制台。 */
let probeInfo: { hasGpu: boolean; secureContext: boolean } = { hasGpu: false, secureContext: false };

/**
 * 在途推理请求的取消句柄 — 键是主线程的 requestId。
 *
 * 关键路径:`AbortSignal` 不能跨线程传递,取消由主线程发消息、Worker 侧在本地中止;
 * 请求结算后必须移除,避免句柄随任务无限累积。
 */
const abortControllers = new Map<string, AbortController>();

self.onmessage = async (e: MessageEvent): Promise<void> => {
	// 关键路径:e.data 是 unknown,断言为消息形状后访问字段,避免 no-unsafe-member-access。
	const msg = e.data as {
		type: string;
		requestId?: string;
		deps?: EmbeddingOnnxDeps;
		dimensions?: number;
		maxBatchSize?: number;
		texts?: string[];
	};

	switch (msg.type) {
		case 'init': {
			try {
				// 关键路径(研发期诊断):把环境能力随 ready 一起报回主线程,由主线程统一记录日志。
				const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
				probeInfo = { hasGpu, secureContext: self.isSecureContext === true };
				const deps = msg.deps as EmbeddingOnnxDeps;
				const dimensions = msg.dimensions as number;
				const maxBatchSize = msg.maxBatchSize as number;
				// 关键路径(S-WEBGPU-EMBEDDING):同一份源码打两份 Worker,靠构建期 define 区分。
				// GPU 版(ESM + webgpu bundle)才尝试 WebGPU 并携带内联胶水;
				// WASM 版(IIFE)保持纯 CPU 路径,行为与 1.4.0 完全一致。
				const resolvedDeps: EmbeddingOnnxDeps = __RATEL_GPU_WORKER__
					? {
						...deps,
						enableWebgpu: true,
						glueSource: __RATEL_ORT_GLUE__,
						// 关键路径:GPU 设备一旦丢失，推理会静默挂起、请求等到 120 秒超时。
						// 这里在毫秒级把信号报给主线程，由它换一个全新实例。
						onGpuDeviceLost: (reason: string) => {
							self.postMessage({ type: 'gpu:lost', reason });
						},
					}
					: deps;
				embeddingOnnx = new EmbeddingOnnx(resolvedDeps, dimensions, maxBatchSize);
				await embeddingOnnx.init();
				self.postMessage({ type: 'ready', probe: probeInfo });
			} catch (err) {
				// 关键路径:初始化失败回复 error(无 requestId,广播式),主线程据此销毁 Worker。
				// 研发期带上堆栈:GPU 版产物不 minify,能直接定位到 ORT/胶水的具体函数。
				const message = err instanceof Error ? err.message : String(err);
				const stack = err instanceof Error ? err.stack : undefined;
				self.postMessage({ type: 'error', error: `初始化失败: ${message}`, stack });
			}
			break;
		}
		case 'warmup': {
			// 关键路径(S-WEBGPU-EMBEDDING):装配层用它量一次真实单块耗时,
			// 不必等整轮索引跑完才能判断 GPU 是否值得启用。
			try {
				if (embeddingOnnx === null) throw new Error('尚未初始化');
				const startedAt = Date.now();
				const batchSize = typeof msg.maxBatchSize === 'number' ? msg.maxBatchSize : 8;
				// 关键路径:预热必须用接近真实块的文本,否则测到的不是索引成本。
				// 早先用一句短语,按真实长度填充时只有十几个 token,却在固定 512 时变成满长,
				// 两种策略的「预热耗时」相差十几倍,读数完全不可比。
				// 这里按约 400 个汉字生成,贴合分块上限,读数可直接与端到端对照。
				const seeds = [
					'索引写入线程的可靠性取决于提交顺序与恢复判定的严格程度,任何一步放宽都会在重启后表现为重复索引或进度倒退。',
					'分片存储把单一文件拆成多个独立片段,单次写入只触碰目标分片,因此写入量与库的总规模解耦,大库不再越写越慢。',
					'向量检索的召回质量由分块粒度、文本前缀与精排共同决定,任何一环缺失都会让相似内容排在无关结果之后。',
					'嵌入速度取决于模型规模、序列长度与执行后端,短序列下调度开销占比升高,长序列下算力利用率上升。',
				];
				const texts = Array.from({ length: batchSize }, (_, index) => {
					const seed = seeds[index % seeds.length]!;
					return `${seed}(${index})`;
				});
				await embeddingOnnx.embed(texts);
				const batchMs = Date.now() - startedAt;
				// 关键路径(诊断):索引批次是 [8, 长序列],查询是 [1, 短序列]。
				// GPU 对输入形状敏感,换形状可能触发流水线重建。这里单独量一次单条短查询,
				// 若它比整批还慢或直接挂住,就说明查询超时来自形状切换而不是检索链路。
				const queryStartedAt = Date.now();
				await embeddingOnnx.embed(['工程化']);
				const queryMs = Date.now() - queryStartedAt;
				self.postMessage({
					type: 'warmup:done',
					blocks: batchSize,
					elapsedMs: batchMs,
					queryElapsedMs: queryMs,
				});
			} catch (err) {
				self.postMessage({ type: 'warmup:error', error: err instanceof Error ? err.message : String(err) });
			}
			break;
		}
		case 'cancel': {
			// 关键路径:取消单项请求;命中则在批次边界中止,未命中是无害的空操作。
			const controller = msg.requestId === undefined ? undefined : abortControllers.get(msg.requestId);
			controller?.abort();
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
			const requestId = msg.requestId;
			const controller = new AbortController();
			if (requestId !== undefined) abortControllers.set(requestId, controller);
			try {
				const vectors = await embeddingOnnx.embed(msg.texts as string[], {
					signal: controller.signal,
					// 关键路径:批次活动由 Worker 主动上报,函数不跨线程传递。
					onBatchComplete: (done, total) => {
						self.postMessage({ type: 'embed:progress', requestId, done, total });
					},
				});
				self.postMessage({
					type: 'embed:result',
					requestId,
					vectors,
				});
			} catch (err) {
				// 关键路径:推理失败(含取消)仍带 requestId,主线程按 requestId reject 对应 Promise。
				const error = err instanceof Error ? err.message : String(err);
				self.postMessage({
					type: 'error',
					requestId,
					error: `推理失败: ${error}`,
				});
			}
			finally {
				if (requestId !== undefined) abortControllers.delete(requestId);
			}
			break;
		}
	}
};
