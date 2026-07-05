/**
 * @file tests/core/ort-runtime-assets.test.ts
 * @description OrtRuntimeAssets — WASM 懒下载与缓存
 * @module tests/core/ort-runtime-assets
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// 关键路径:src/core/ort-runtime-assets.ts 改用 requestUrl 后,需要在测试中 mock 'obsidian'。
// 测试通过注入 fetchFn 走自定义路径,createDefaultFetch 不会被调用,故 requestUrl 用空实现即可。
vi.mock('obsidian', () => ({
	requestUrl: vi.fn(),
}));

import {
	OrtRuntimeAssets,
	ORT_WASM_FILENAME,
	getOrtWasmDownloadUrl,
} from '../../src/core/ort-runtime-assets';

function createWasmBytes(size = 11 * 1024 * 1024): Uint8Array {
	return new Uint8Array(size).fill(1);
}

describe('getOrtWasmDownloadUrl', () => {
	it('pins onnxruntime-web version on jsDelivr', () => {
		expect(getOrtWasmDownloadUrl('1.27.0')).toBe(
			`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/${ORT_WASM_FILENAME}`,
		);
	});
});

describe('OrtRuntimeAssets', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ratel-ort-'));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it('ensureWasm - 从 CDN 下载并缓存', async () => {
		const wasmBytes = createWasmBytes();
		// 关键路径:FetchFn 现返回 { status, arrayBuffer },与 requestUrl 返回字段对齐。
		const fetchFn = vi.fn().mockResolvedValue({
			status: 200,
			arrayBuffer: wasmBytes.buffer as ArrayBuffer,
		});
		const assets = new OrtRuntimeAssets(tmpDir, '1.27.0', fetchFn);

		await assets.ensureWasm();

		expect(fetchFn).toHaveBeenCalledOnce();
		const cached = await readFile(assets.wasmPath);
		expect(cached.byteLength).toBe(wasmBytes.byteLength);
	});

	it('ensureWasm - 已缓存时跳过下载', async () => {
		const wasmBytes = createWasmBytes();
		const { writeFile, mkdir } = await import('node:fs/promises');
		await mkdir(tmpDir, { recursive: true });
		await writeFile(path.join(tmpDir, ORT_WASM_FILENAME), Buffer.from(wasmBytes));

		const fetchFn = vi.fn();
		const assets = new OrtRuntimeAssets(tmpDir, '1.27.0', fetchFn);
		await assets.ensureWasm();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it('ensureWasm - 文件过小时重新下载', async () => {
		const { writeFile, mkdir } = await import('node:fs/promises');
		await mkdir(tmpDir, { recursive: true });
		await writeFile(path.join(tmpDir, ORT_WASM_FILENAME), Buffer.from([1, 2, 3]));

		const wasmBytes = createWasmBytes();
		// 关键路径:FetchFn 现返回 { status, arrayBuffer },与 requestUrl 返回字段对齐。
		const fetchFn = vi.fn().mockResolvedValue({
			status: 200,
			arrayBuffer: wasmBytes.buffer as ArrayBuffer,
		});
		const assets = new OrtRuntimeAssets(tmpDir, '1.27.0', fetchFn);
		await assets.ensureWasm();
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	it('readWasmBinary - 返回 ArrayBuffer', async () => {
		const wasmBytes = createWasmBytes();
		// 关键路径:FetchFn 现返回 { status, arrayBuffer },与 requestUrl 返回字段对齐。
		const fetchFn = vi.fn().mockResolvedValue({
			status: 200,
			arrayBuffer: wasmBytes.buffer as ArrayBuffer,
		});
		const assets = new OrtRuntimeAssets(tmpDir, '1.27.0', fetchFn);
		const binary = await assets.readWasmBinary();
		expect(binary).toBeInstanceOf(ArrayBuffer);
		expect(binary.byteLength).toBe(wasmBytes.byteLength);
	});
});
