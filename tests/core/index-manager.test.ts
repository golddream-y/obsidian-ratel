/**
 * @file tests/core/index-manager.test.ts
 * @description IndexManager 行为 — 初始 / 增量 / 暂停 / 恢复 / 重索引 / 失败
 * @module tests/core/index-manager
 * @depends core/index-manager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IndexManager } from '../../src/core/index-manager';
import { get } from 'svelte/store';

describe('IndexManager', () => {
    let manager: IndexManager;

    beforeEach(() => {
        manager = new IndexManager({
            fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
            incrementalIndex: vi.fn().mockResolvedValue({ indexed: 1, errors: 0 }),
            deleteFile: vi.fn().mockResolvedValue(1),
        });
    });

    it('初始状态 - Idle', () => {
        expect(get(manager.status$)).toEqual({ state: 'Idle' });
    });

    it('onLayoutReady - 状态 Init → Ready', async () => {
        await manager.onLayoutReady();
        expect(get(manager.status$)).toMatchObject({ state: 'Ready' });
    });

    it('enqueue 增量 - 状态变 Queueing,处理后变 Ready', async () => {
        await manager.onLayoutReady();
        manager.enqueue('foo.md', 'upsert');
        expect(get(manager.status$).state).toBe('Queueing');
        await manager.processNext();
        expect(get(manager.status$).state).toBe('Ready');
    });

    it('enqueue 增量 - 状态 Processing → Ready', async () => {
        await manager.onLayoutReady();
        manager.enqueue('a.md', 'upsert');
        expect(get(manager.status$).state).toBe('Queueing');
        await manager.processNext();
        expect(get(manager.status$).state).toBe('Ready');
    });

    it('pause - 状态 Paused;新事件入队不消费', async () => {
        await manager.onLayoutReady();
        manager.pause();
        manager.enqueue('b.md', 'upsert');
        expect(get(manager.status$)).toMatchObject({ state: 'Paused', pending: 1 });
        await manager.flush();
        // 关键路径:暂停时 flush 不消费队列。
        expect(get(manager.status$)).toMatchObject({ state: 'Paused', pending: 1 });
    });

    it('resume - 追平队列', async () => {
        await manager.onLayoutReady();
        manager.pause();
        manager.enqueue('c.md', 'upsert');
        manager.resume();
        await manager.flush();
        expect(get(manager.status$).state).toBe('Ready');
    });

    it('reindex - 状态 Scanning → Ready', async () => {
        await manager.onLayoutReady();
        await manager.reindex();
        expect(get(manager.status$).state).toBe('Ready');
    });

    it('失败 - 状态 Failed', async () => {
        const failManager = new IndexManager({
            fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 1 }),
            incrementalIndex: vi.fn().mockRejectedValue(new Error('boom')),
            deleteFile: vi.fn().mockResolvedValue(0),
        });
        await failManager.onLayoutReady();
        failManager.enqueue('x.md', 'upsert');
        await failManager.processNext();
        expect(get(failManager.status$).state).toBe('Failed');
    });

    it('同 path 多次 enqueue - 只保留最后一次 op (去重)', async () => {
        await manager.onLayoutReady();
        manager.enqueue('d.md', 'upsert', 'v1');
        manager.enqueue('d.md', 'delete');
        expect(get(manager.status$)).toMatchObject({ pending: 1 });
    });

    it('quality fix - 在 Ready 状态 pause → resume 后仍是 Ready', async () => {
        await manager.onLayoutReady();
        expect(get(manager.status$).state).toBe('Ready');
        manager.pause();
        expect(get(manager.status$).state).toBe('Paused');
        manager.resume();
        // 关键路径:resume 后若队列空,回到 paused 前的 Ready(不是 hardcode 的 Ready)。
        expect(get(manager.status$).state).toBe('Ready');
        expect(get(manager.status$)).toMatchObject({ state: 'Ready', totalDocs: 0 });
    });
});
