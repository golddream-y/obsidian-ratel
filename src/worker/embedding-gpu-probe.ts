/**
 * @file src/worker/embedding-gpu-probe.ts
 * @description GPU 嵌入探针 — 独立 Worker，只用于验证 WebGPU 执行器能否在本环境初始化
 * @module worker/embedding-gpu-probe
 *
 * 关键路径:
 * - 这份代码**不参与正式索引**。正式路径始终用 WASM 执行器,避免实验失败导致索引不可用。
 * - 打包时单独走 ort.webgpu.bundle,并把 jsep 胶水模块内联进本 bundle(不依赖外部文件)。
 * - 只回报结论与错误栈,方便定位是「环境不支持 GPU」还是「加载机制不兼容」。
 */

import * as ort from 'onnxruntime-web';
import { ORT_WASM_JSEP_GLUE } from '../adapters/ort-wasm-glue.generated';

/** 探针请求载荷。 */
interface ProbeRequest {
	type: 'probe';
	/** 量化模型字节。 */
	modelBuffer: ArrayBuffer;
	/** jsep wasm 字节。 */
	wasmBinary: ArrayBuffer;
}

/** 探针结论。 */
interface ProbeResult {
	ok: boolean;
	/** 实际可用的执行器名称。 */
	backend?: string;
	/** 失败原因(含名称与消息,便于定位)。 */
	error?: string;
	/** WebGPU 是否在当前 Worker 暴露。 */
	hasNavigatorGpu: boolean;
}

self.onmessage = (event: MessageEvent): void => {
	void handleProbe(event);
};

/** 处理一次探针请求。 */
async function handleProbe(event: MessageEvent): Promise<void> {
	const msg = event.data as ProbeRequest | null;
	if (msg === null || msg.type !== 'probe') return;
	const hasNavigatorGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
	let result: ProbeResult = { ok: false, hasNavigatorGpu };
	try {
		// 关键路径:把内联胶水还原成 Blob URL 交给 ORT;缺它 ORT 会去 fetch 相对路径并失败。
		const glueSource = ORT_WASM_JSEP_GLUE;
		const glueUrl = URL.createObjectURL(new Blob([glueSource], { type: 'text/javascript' }));
		ort.env.wasm.wasmBinary = msg.wasmBinary;
		ort.env.wasm.numThreads = 1;
		(ort.env.wasm as { wasmPaths?: unknown }).wasmPaths = { mjs: glueUrl };
		const session = await ort.InferenceSession.create(msg.modelBuffer, {
			executionProviders: ['webgpu'],
		});
		result = { ok: true, backend: 'webgpu', hasNavigatorGpu };
		await session.release?.();
	} catch (error) {
		const err = error as { name?: string; message?: string; stack?: string };
		result = {
			ok: false,
			error: `${err?.name ?? 'Error'}: ${err?.message ?? String(error)}${err?.stack ? `\n${err.stack.split('\n').slice(0, 4).join('\n')}` : ''}`,
			hasNavigatorGpu,
		};
	}
	self.postMessage(result);
}
