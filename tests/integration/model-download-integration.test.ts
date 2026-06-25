/**
 * @file tests/integration/model-download-integration.test.ts
 * @description 模型下载集成 — mock fetch 模拟 ModelScope 下载与进度回调
 * @module tests/integration/model-download-integration
 * @depends core/model-downloader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelDownloader } from '../../src/core/model-downloader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('ModelDownloader 集成 - 进度回调', () => {
	let tmpDir: string;
	let originalFetch: typeof fetch;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-dl-'));
		originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async () => {
			const data = new Uint8Array(1000).fill(65);
			return {
				ok: true,
				headers: { get: () => String(data.length) },
				body: {
					getReader: () => {
						let done = false;
						return {
							read: async () => {
								if (done) return { done: true, value: undefined };
								done = true;
								return { done: false, value: data };
							},
						};
					},
				},
			} as unknown as Response;
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('ensureModel - 进度回调被触发', async () => {
		const dl = new ModelDownloader(tmpDir);
		const onProgress = vi.fn();
		await dl.ensureModel(onProgress);
		expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ file: expect.any(String) }));
	});
});
