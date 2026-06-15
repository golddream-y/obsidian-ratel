/**
 * @file tests/core/model-manager-cleanup.test.ts
 * @description ModelManager cleanup 行为 — 一键清空已下载模型列表
 * @module tests/core/model-manager-cleanup
 * @depends core/model-manager
 */

import { describe, it, expect, vi } from 'vitest';
import { ModelManager } from '../../src/core/model-manager';
import { get } from 'svelte/store';

describe('ModelManager - M-7 cleanup', () => {
    it('cleanup - 清空所有已下载列表 + 状态 NotStarted', async () => {
        const removeMock = vi.fn().mockResolvedValue(undefined);
        const manager = new ModelManager({
            ensureModel: vi.fn().mockResolvedValue({}),
            remove: removeMock,
        });
        await manager.download('Xenova/bge-small-zh-v1.5');
        await manager.cleanup(['Xenova/bge-small-zh-v1.5', 'Xenova/bge-base-zh-v1.5']);
        expect(removeMock).toHaveBeenCalledTimes(2);
        expect(get(manager.status$)).toEqual({ state: 'NotStarted' });
    });
});
