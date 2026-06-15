/**
 * @file tests/integration/pause-resume-integration.test.ts
 * @description 暂停/恢复集成 — IndexController 端到端
 * @module tests/integration/pause-resume-integration
 * @depends core/index-controller
 */

import { describe, it, expect, vi } from 'vitest';
import { IndexController, type VaultEventListener } from '../../src/core/index-controller';
import { get } from 'svelte/store';

const mockVault: VaultEventListener = {
    onFileCreate: () => () => {},
    onFileModify: () => () => {},
    onFileDelete: () => () => {},
    onFileRename: () => () => {},
};

describe('Pause/Resume 集成', () => {
    it('暂停期间事件入队 - 恢复后追平', async () => {
        const ctl = new IndexController(
            mockVault,
            {
                fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
                incrementalIndex: vi.fn().mockResolvedValue({ indexed: 1, errors: 0 }),
                deleteFile: vi.fn().mockResolvedValue(0),
            },
            '/tmp',
        );
        await ctl.onLayoutReady();
        ctl.pause();
        ctl.indexManager.enqueue('a.md', 'upsert', 'content');
        ctl.indexManager.enqueue('b.md', 'upsert', 'content');
        expect(get(ctl.indexManager.status$)).toMatchObject({ state: 'Paused', pending: 2 });

        ctl.resume();
        await ctl.indexManager.flush();
        expect(get(ctl.indexManager.status$).state).toBe('Ready');
    });
});
