/**
 * @file tests/core/model-manager.test.ts
 * @description ModelManager 状态机 — 初始 / download / 失败 / remove
 * @module tests/core/model-manager
 * @depends core/model-manager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelManager } from '../../src/core/model-manager';
import { ModelDownloader } from '../../src/core/model-downloader';
import { get } from 'svelte/store';

function createMockDownloader(): ModelDownloader {
	return {
		ensureModel: vi.fn().mockResolvedValue('/tmp/models/Xenova/bge-small-zh-v1.5'),
		remove: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModelDownloader;
}

function createMockEmbedding(modelId = 'local:bge-small-zh-v1.5'): import('../../src/ports/embedding').EmbeddingPort {
	return {
		modelId,
		dimensions: 512,
		embed: vi.fn().mockResolvedValue([]),
	};
}

describe('ModelManager', () => {
	let manager: ModelManager;
	let downloader: ModelDownloader;

	beforeEach(() => {
		downloader = createMockDownloader();
		manager = new ModelManager('/tmp/models', '', downloader, async () => createMockEmbedding());
	});

	it('初始状态 - NotStarted', () => {
		expect(get(manager.status$)).toEqual({ state: 'NotStarted' });
	});

	it('download - 状态 Downloading → Ready', async () => {
		const onProgress = vi.fn();
		await manager.download(onProgress);
		expect(get(manager.status$)).toMatchObject({ state: 'Ready', modelId: 'local:bge-small-zh-v1.5' });
	});

	it('download 失败 - 状态 Failed + 抛错', async () => {
		const failDownloader = createMockDownloader();
		(failDownloader.ensureModel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('net error'));
		const failManager = new ModelManager('/tmp/models', '', failDownloader);
		await expect(failManager.download()).rejects.toThrow('net error');
		expect(get(failManager.status$)).toMatchObject({ state: 'Failed', reason: 'net error' });
	});

	it('remove - 状态 NotStarted', async () => {
		await manager.download();
		await manager.remove();
		expect(get(manager.status$)).toEqual({ state: 'NotStarted' });
	});
});
