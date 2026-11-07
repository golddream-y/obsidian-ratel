/**
 * @file src/core/gpu-probe.ts
 * @description GPU 嵌入探针 — 在独立 Worker 里尝试 WebGPU 执行器并回报结论
 * @module core/gpu-probe
 *
 * 关键路径:
 * - 只做诊断,不参与正式索引;正式路径始终用 WASM,探针失败不影响可用性。
 * - 探针 Worker 代码由构建期内联,运行时用 Blob URL 拉起。
 */

import path from 'node:path';
import { readFile, writeFile, access } from 'node:fs/promises';
import { GPU_PROBE_WORKER_CODE } from '@ratel/gpu-probe-code';
import { ORT_RUNTIME_VERSION } from './ort-runtime-assets';
import { devLogger } from '../logging/dev-logger';

/** 探针结论。 */
export interface GpuProbeOutcome {
	ok: boolean;
	backend?: string;
	error?: string;
	hasNavigatorGpu: boolean;
}

/** jsep wasm 的 CDN 地址(webgpu 执行器配套)。 */
function jsepWasmUrl(): string {
	return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_RUNTIME_VERSION}/dist/ort-wasm-simd-threaded.jsep.wasm`;
}

/**
 * 取 jsep wasm 字节:优先读插件目录缓存,缺失时下载并缓存。
 *
 * @param pluginDir - 插件目录
 * @returns wasm 字节
 */
async function loadJsepWasm(pluginDir: string): Promise<ArrayBuffer> {
	const cached = path.join(pluginDir, 'gpu-probe.jsep.wasm');
	try {
		await access(cached);
		const buffer = await readFile(cached);
		return new Uint8Array(buffer).buffer;
	} catch {
		const response = await fetch(jsepWasmUrl());
		if (!response.ok) throw new Error(`下载 jsep wasm 失败: HTTP ${response.status}`);
		const bytes = await response.arrayBuffer();
		await writeFile(cached, new Uint8Array(bytes));
		return bytes;
	}
}

/**
 * 运行一次 GPU 探针。
 *
 * @param pluginDir - 插件目录(模型与此处缓存同源)
 * @param modelId - 当前本地模型标识,如 `Xenova/bge-small-zh-v1.5`
 * @returns 探针结论
 */
export async function runGpuProbe(pluginDir: string, modelId: string): Promise<GpuProbeOutcome> {
	const modelPath = path.join(pluginDir, 'models', modelId, 'model_quantized.onnx');
	let modelBuffer: ArrayBuffer;
	let wasmBinary: ArrayBuffer;
	try {
		const model = await readFile(modelPath);
		modelBuffer = new Uint8Array(model).buffer;
	} catch {
		return { ok: false, hasNavigatorGpu: false, error: `找不到本地模型:${modelPath}` };
	}
	try {
		wasmBinary = await loadJsepWasm(pluginDir);
	} catch (error) {
		return { ok: false, hasNavigatorGpu: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (GPU_PROBE_WORKER_CODE.length === 0) {
		return { ok: false, hasNavigatorGpu: false, error: '探针 Worker 未打入产物' };
	}
	const url = URL.createObjectURL(new Blob([GPU_PROBE_WORKER_CODE], { type: 'text/javascript' }));
	const worker = new Worker(url);
	try {
		const outcome = await new Promise<GpuProbeOutcome>((resolve) => {
			// 关键路径:探针可能因环境问题永不回包,超时后如实报告,不能挂住 UI。
			const timer = setTimeout(() => resolve({ ok: false, hasNavigatorGpu: false, error: '探针超时(60 秒无响应)' }), 60_000);
			worker.onmessage = (event: MessageEvent) => {
				clearTimeout(timer);
				resolve(event.data as GpuProbeOutcome);
			};
			worker.onerror = (event: ErrorEvent) => {
				clearTimeout(timer);
				resolve({ ok: false, hasNavigatorGpu: false, error: `Worker 错误:${event.message}` });
			};
			worker.postMessage({ type: 'probe', modelBuffer, wasmBinary }, [modelBuffer, wasmBinary]);
		});
		devLogger.info('index', `GPU 探针结论: ${JSON.stringify(outcome)}`);
		return outcome;
	} finally {
		worker.terminate();
		URL.revokeObjectURL(url);
	}
}
