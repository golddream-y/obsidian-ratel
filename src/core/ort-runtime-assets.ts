/**
 * @file src/core/ort-runtime-assets.ts
 * @description ONNX Runtime Web WASM 运行时资产 — 懒下载并缓存到插件目录
 * @module core/ort-runtime-assets
 * @depends obsidian(requestUrl), node:fs/promises
 *
 * 关键路径:Obsidian / BRAT 商店 release 只分发 main.js + manifest.json + styles.css,
 * WASM 不能随 release 附件安装;首次 local embedding 时从 jsDelivr 下载并缓存到 pluginDir。
 * 见 ADR-006。
 */

import { requestUrl } from 'obsidian';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProgressInfo } from './model-downloader';

/** 与 package.json `dependencies.onnxruntime-web` 版本保持同步。 */
export const ORT_RUNTIME_VERSION = '1.27.0';

export const ORT_WASM_FILENAME = 'ort-wasm-simd-threaded.wasm';

/** 完整文件至少约 10MB;过小视为损坏或未完成下载。 */
const ORT_WASM_MIN_BYTES = 10 * 1024 * 1024;

/**
 * 构造 jsDelivr CDN 上的 ORT WASM 下载 URL(版本 pin,避免漂移)。
 *
 * @param version - onnxruntime-web 包版本,默认 ORT_RUNTIME_VERSION。
 */
export function getOrtWasmDownloadUrl(version: string = ORT_RUNTIME_VERSION): string {
	return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/${ORT_WASM_FILENAME}`;
}

/**
 * 可注入的下载函数返回值 — 与 fetch Response 解耦,只暴露本模块实际用到的字段。
 *
 * 关键路径:不再依赖 fetch 的 Response 类型(裸 fetch 在 Obsidian CSP 下不稳定);
 * 改用 requestUrl 后,实际使用的字段只有 status 与 arrayBuffer,故独立定义此接口。
 */
export interface DownloadResponse {
	status: number;
	arrayBuffer: ArrayBuffer;
}

/** 可注入的下载函数类型(测试 mock 用)。 */
export type FetchFn = (url: string) => Promise<DownloadResponse>;

/**
 * 构造默认下载函数 — 用 Obsidian 内置 requestUrl 替代裸 fetch,处理 CORS/CSP 更稳。
 *
 * 关键路径:requestUrl 默认 throw 非 2xx,这里设 throw:false 以手动解析状态码;
 * 下载二进制用 .arrayBuffer。
 */
function createDefaultFetch(): FetchFn {
	return async (url) => {
		const response = await requestUrl({ url, method: 'GET', throw: false });
		return {
			status: response.status,
			arrayBuffer: response.arrayBuffer,
		};
	};
}

export class OrtRuntimeAssets {
	constructor(
		private pluginDir: string,
		private version: string = ORT_RUNTIME_VERSION,
		private fetchFn: FetchFn = createDefaultFetch(),
	) {}

	/** 插件目录下的 WASM 缓存绝对路径。 */
	get wasmPath(): string {
		return path.join(this.pluginDir, ORT_WASM_FILENAME);
	}

	/**
	 * 确保 WASM 已缓存到插件目录;缺失或损坏时从 CDN 下载。
	 *
	 * @param onProgress - 下载进度回调,progress 为 0-1。
	 * @throws Error 网络或写入失败。
	 */
	async ensureWasm(onProgress?: (p: ProgressInfo) => void): Promise<void> {
		if (await this.isWasmCached()) {
			return;
		}
		await mkdir(this.pluginDir, { recursive: true });

		const url = getOrtWasmDownloadUrl(this.version);
		const response = await this.fetchFn(url);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`下载 ONNX Runtime WASM 失败: ${response.status}`);
		}

		// 关键路径:requestUrl 不支持流式进度,只能下载完成后 emit 一次 1.0。
		const buffer = Buffer.from(response.arrayBuffer);
		if (buffer.byteLength < ORT_WASM_MIN_BYTES) {
			throw new Error(
				`下载 ONNX Runtime WASM 失败: 文件过小(${buffer.byteLength} bytes),可能已损坏`,
			);
		}

		const tmpPath = `${this.wasmPath}.downloading`;
		await writeFile(tmpPath, buffer);
		await rename(tmpPath, this.wasmPath);
		onProgress?.({ file: ORT_WASM_FILENAME, progress: 1 });
	}

	/**
	 * 读取 WASM 二进制;必要时先触发 ensureWasm。
	 *
	 * @returns 可传给 ort.env.wasm.wasmBinary 的 ArrayBuffer。
	 */
	async readWasmBinary(): Promise<ArrayBuffer> {
		await this.ensureWasm();
		const wasmBuffer = await readFile(this.wasmPath);
		return new Uint8Array(wasmBuffer).buffer;
	}

	private async isWasmCached(): Promise<boolean> {
		try {
			await access(this.wasmPath);
			const wasmBuffer = await readFile(this.wasmPath);
			return wasmBuffer.byteLength >= ORT_WASM_MIN_BYTES;
		} catch {
			return false;
		}
	}
}
