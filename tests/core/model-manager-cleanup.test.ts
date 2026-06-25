/**
 * @file tests/core/model-manager-cleanup.test.ts
 * @description ModelManager cleanup 行为 — 一键清空已下载模型列表
 * @module tests/core/model-manager-cleanup
 * @depends core/model-manager
 */

import { describe, it, expect, vi } from 'vitest';
import { ModelManager } from '../../src/core/model-manager';
import { ModelDownloader } from '../../src/core/model-downloader';
import { get } from 'svelte/store';

describe('ModelManager - cleanup', () => {
	it('cleanup - 清空所有已下载列表 + 状态 NotStarted', async () => {
		const removeMock = vi.fn().mockResolvedValue(undefined);
		const downloader = {
			ensureModel: vi.fn().mockResolvedValue('/tmp/models/Xenova/bge-small-zh-v1.5'),
			remove: removeMock,
		} as unknown as ModelDownloader;
		const manager = new ModelManager('/tmp/models', '', downloader, async () => ({
			modelId: 'local:bge-small-zh-v1.5',
			dimensions: 512,
			embed: vi.fn().mockResolvedValue([]),
		}));
		await manager.download();
		await manager.remove();
		expect(removeMock).toHaveBeenCalledTimes(1);
		expect(get(manager.status$)).toEqual({ state: 'NotStarted' });
	});
});
