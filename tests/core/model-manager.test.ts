/**
 * @file tests/core/model-manager.test.ts
 * @description ModelManager 状态机 — 初始 / download / 失败 / switchTo / remove
 * @module tests/core/model-manager
 * @depends core/model-manager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelManager } from '../../src/core/model-manager';
import { get } from 'svelte/store';

describe('ModelManager', () => {
    let manager: ModelManager;

    beforeEach(() => {
        manager = new ModelManager({
            ensureModel: vi.fn().mockResolvedValue({}),
            remove: vi.fn().mockResolvedValue(undefined),
        });
    });

    it('初始状态 - NotStarted', () => {
        expect(get(manager.status$)).toEqual({ state: 'NotStarted' });
    });

    it('download - 状态 Downloading → Ready', async () => {
        const onProgress = vi.fn();
        await manager.download('Xenova/bge-small-zh-v1.5', onProgress);
        expect(get(manager.status$)).toMatchObject({ state: 'Ready', modelId: 'Xenova/bge-small-zh-v1.5' });
    });

    it('download 失败 - 状态 Failed', async () => {
        const failManager = new ModelManager({
            ensureModel: vi.fn().mockRejectedValue(new Error('net error')),
            remove: vi.fn().mockResolvedValue(undefined),
        });
        await failManager.download('Xenova/bge-small-zh-v1.5');
        expect(get(failManager.status$)).toMatchObject({ state: 'Failed' });
    });

    it('switchTo - 状态 Switching → Ready', async () => {
        await manager.download('Xenova/bge-small-zh-v1.5');
        await manager.switchTo('Xenova/bge-base-zh-v1.5');
        expect(get(manager.status$)).toMatchObject({ state: 'Ready', modelId: 'Xenova/bge-base-zh-v1.5' });
    });

    it('remove - 状态 NotStarted', async () => {
        await manager.download('Xenova/bge-small-zh-v1.5');
        await manager.remove('Xenova/bge-small-zh-v1.5');
        expect(get(manager.status$)).toEqual({ state: 'NotStarted' });
    });
});
