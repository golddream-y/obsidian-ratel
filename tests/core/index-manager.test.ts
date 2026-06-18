/**
 * @file tests/core/index-manager.test.ts
 * @description IndexManager 行为 — 初始 / 增量(自动消费) / 暂停 / 恢复 / 重索引 / 失败
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

    it('enqueue 增量 - 自动消费后状态变 Ready', async () => {
        await manager.onLayoutReady();
        manager.enqueue('foo.md', 'upsert', 'content');
        // 异步等待:自动 flush 完成后状态变 Ready
        await vi.waitFor(() => expect(get(manager.status$).state).toBe('Ready'));
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

    it('resume - 自动追平队列', async () => {
        await manager.onLayoutReady();
        manager.pause();
        manager.enqueue('c.md', 'upsert', 'content');
        manager.resume();
        // resume 后自动触发 scheduleFlush
        await vi.waitFor(() => expect(get(manager.status$).state).toBe('Ready'));
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
        failManager.enqueue('x.md', 'upsert', 'content');
        // 自动 flush 失败后状态变 Failed
        await vi.waitFor(() => expect(get(failManager.status$).state).toBe('Failed'));
    });

    it('同 path 多次 enqueue - 只保留最后一次 op (去重)', async () => {
        const incrementalSpy = vi.fn().mockResolvedValue({ indexed: 1, errors: 0 });
        const deleteSpy = vi.fn().mockResolvedValue(1);
        const mgr = new IndexManager({
            fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
            incrementalIndex: incrementalSpy,
            deleteFile: deleteSpy,
        });
        await mgr.onLayoutReady();
        // 关键路径:paused 状态下 enqueue 不触发消费,确保去重可验证。
        mgr.pause();
        mgr.enqueue('d.md', 'upsert', 'v1');
        mgr.enqueue('d.md', 'delete');
        expect(get(mgr.status$)).toMatchObject({ state: 'Paused', pending: 1 });
        mgr.resume();
        await vi.waitFor(() => expect(get(mgr.status$).state).toBe('Ready'));
        // 去重后只保留 delete,所以 deleteFile 被调用,incrementalIndex 不被调用
        expect(deleteSpy).toHaveBeenCalledOnce();
        expect(incrementalSpy).not.toHaveBeenCalled();
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

    it('增量索引 - content 传给 backend', async () => {
        const incrementalSpy = vi.fn().mockResolvedValue({ indexed: 1, errors: 0 });
        const mgr = new IndexManager({
            fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
            incrementalIndex: incrementalSpy,
            deleteFile: vi.fn().mockResolvedValue(1),
        });
        await mgr.onLayoutReady();
        mgr.enqueue('note.md', 'upsert', 'file content here');
        await vi.waitFor(() => expect(incrementalSpy).toHaveBeenCalledOnce());
        expect(incrementalSpy).toHaveBeenCalledWith({ path: 'note.md', content: 'file content here' });
    });
});
