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
import { tNow } from '../i18n';
import type { ProgressInfo } from './model-downloader';

/** 与 package.json `dependencies.onnxruntime-web` 版本保持同步。 */
export const ORT_RUNTIME_VERSION = '1.27.0';

/** WASM 版(CPU)运行时文件名 — 与 ort.wasm.bundle 配套。 */
export const ORT_WASM_FILENAME = 'ort-wasm-simd-threaded.wasm';

/**
 * WebGPU 版运行时文件名。
 *
 * 关键路径(S-WEBGPU-EMBEDDING):`ort.webgpu.bundle` 按 **asyncify** 变体查找胶水与
 * wasm;用 jsep 版会让模块实例上缺少 `webgpuInit`(线上报 `webgpuInit is not a function`)。
 * 与 CPU 版同一 CDN、同一 ORT 包,只是文件名不同;首次 GPU 探测时多下载约 26 MB。
 */
export const ORT_WASM_GPU_FILENAME = 'ort-wasm-simd-threaded.asyncify.wasm';

/** 完整文件至少约 10MB;过小视为损坏或未完成下载。 */
const ORT_WASM_MIN_BYTES = 10 * 1024 * 1024;

/**
 * ORT 运行时文件的下载源，按顺序尝试。
 *
 * 关键路径：这两个都是同一个 npm 包里的同一份文件（字节一致），只是托管方不同。
 * - `npmmirror`：阿里云国内镜像，国内网络更稳、通常更快。
 * - `jsDelivr`：国际 CDN，作为国内源不可用时的回退。
 * 不引入新的数据去向 —— 来源仍是 onnxruntime-web 官方包，仅换托管位置。
 */
const ORT_WASM_MIRRORS = [
	(version: string, filename: string) => `https://registry.npmmirror.com/onnxruntime-web/${version}/files/dist/${filename}`,
	(version: string, filename: string) => `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/${filename}`,
] as const;

/** 单次下载的尝试次数上限（不含切换下载源）。 */
const ORT_DOWNLOAD_ATTEMPTS = 2;

/**
 * 列出某个运行时文件按优先级排列的全部下载地址。
 *
 * @param version - onnxruntime-web 包版本
 * @param filename - dist 下的文件名
 */
export function getOrtWasmDownloadUrls(
	version: string = ORT_RUNTIME_VERSION,
	filename: string = ORT_WASM_FILENAME,
): string[] {
	return ORT_WASM_MIRRORS.map((build) => build(version, filename));
}

/**
 * 构造 ORT WASM 首选下载 URL（保留旧签名，供既有调用与测试使用）。
 *
 * @param version - onnxruntime-web 包版本,默认 ORT_RUNTIME_VERSION。
 */
export function getOrtWasmDownloadUrl(
	version: string = ORT_RUNTIME_VERSION,
	filename: string = ORT_WASM_FILENAME,
): string {
	return getOrtWasmDownloadUrls(version, filename)[0]!;
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

	/** 插件目录下的 CPU 版 WASM 缓存绝对路径。 */
	get wasmPath(): string {
		return path.join(this.pluginDir, ORT_WASM_FILENAME);
	}

	/** 插件目录下的 WebGPU 版 WASM 缓存绝对路径。 */
	get gpuWasmPath(): string {
		return path.join(this.pluginDir, ORT_WASM_GPU_FILENAME);
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
			throw new Error(tNow('error.ort.downloadFailed', { status: response.status }));
		}

		// 关键路径:requestUrl 不支持流式进度,只能下载完成后 emit 一次 1.0。
		const buffer = Buffer.from(response.arrayBuffer);
		if (buffer.byteLength < ORT_WASM_MIN_BYTES) {
			throw new Error(
				tNow('error.ort.fileCorrupted', { bytes: buffer.byteLength }),
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

	/**
	 * 读取 WebGPU 版 WASM 二进制;必要时先下载缓存。
	 *
	 * 关键路径:与 CPU 版分开缓存,互不影响;GPU 探测失败时 CPU 版缓存仍完整可用。
	 * 下载按「多个镜像 × 每源多次尝试」进行,任何一步失败都只是抛错,
	 * 由调用方回退到 CPU 路径 —— 不得让 GPU 可选组件拖垮整个索引。
	 *
	 * @param onProgress - 可选进度回调(0-1),按镜像尝试阶段上报
	 * @returns 可传给 ort.env.wasm.wasmBinary 的 ArrayBuffer
	 */
	async readGpuWasmBinary(onProgress?: (p: ProgressInfo) => void): Promise<ArrayBuffer> {
		const filePath = this.gpuWasmPath;
		if (!(await this.isCached(filePath))) {
			await this.download(ORT_WASM_GPU_FILENAME, filePath, onProgress);
		}
		const wasmBuffer = await readFile(filePath);
		return new Uint8Array(wasmBuffer).buffer;
	}

	/**
	 * 按镜像顺序下载运行时文件，每个镜像最多尝试若干次。
	 *
	 * 关键路径：国内网络访问国际 CDN 常出现长时间挂起或中途断开，
	 * 因此先试国内镜像、再试国际 CDN，并把每次失败写进日志便于支持定位。
	 *
	 * @param filename - dist 下的文件名
	 * @param targetPath - 落地绝对路径
	 * @param onProgress - 可选进度回调
	 */
	private async download(
		filename: string,
		targetPath: string,
		onProgress?: (p: ProgressInfo) => void,
	): Promise<void> {
		await mkdir(this.pluginDir, { recursive: true });
		const urls = getOrtWasmDownloadUrls(this.version, filename);
		const failures: string[] = [];
		for (const [mirrorIndex, url] of urls.entries()) {
			for (let attempt = 1; attempt <= ORT_DOWNLOAD_ATTEMPTS; attempt++) {
				onProgress?.({ file: filename, progress: (mirrorIndex * ORT_DOWNLOAD_ATTEMPTS + attempt - 1) / (urls.length * ORT_DOWNLOAD_ATTEMPTS) });
				try {
					const response = await this.fetchFn(url);
					if (response.status < 200 || response.status >= 300) {
						failures.push(`${url} → HTTP ${response.status}`);
						continue;
					}
					const buffer = Buffer.from(response.arrayBuffer);
					if (buffer.byteLength < ORT_WASM_MIN_BYTES) {
						failures.push(`${url} → 文件过小(${buffer.byteLength} 字节)`);
						continue;
					}
					const tmpPath = `${targetPath}.downloading`;
					await writeFile(tmpPath, buffer);
					await rename(tmpPath, targetPath);
					onProgress?.({ file: filename, progress: 1 });
					return;
				} catch (error) {
					// 关键路径:网络异常(超时/断连/DNS)与状态码失败一样处理,换源重试。
					failures.push(`${url} → ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		throw new Error(tNow('error.ort.downloadFailed', { status: failures.join(' | ') }));
	}

	/** 按路径判断缓存是否有效。 */
	private async isCached(filePath: string): Promise<boolean> {
		try {
			await access(filePath);
			const wasmBuffer = await readFile(filePath);
			return wasmBuffer.byteLength >= ORT_WASM_MIN_BYTES;
		} catch {
			return false;
		}
	}

	private async isWasmCached(): Promise<boolean> {
		return this.isCached(this.wasmPath);
	}
}
