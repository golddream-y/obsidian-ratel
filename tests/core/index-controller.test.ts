/**
 * @file tests/core/index-controller.test.ts
 * @description IndexController 行为 — vault 事件 → watcher → manager.enqueue
 * @module tests/core/index-controller
 * @depends core/index-controller
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IndexController, type VaultEventListener } from '../../src/core/index-controller';
import { get } from 'svelte/store';

const listeners: Record<string, (cb: unknown) => () => void> = {
    create: vi.fn(),
    modify: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
};

const mockVault: VaultEventListener = {
    onFileCreate: (cb) => { listeners.create(cb); return () => {}; },
    onFileModify: (cb) => { listeners.modify(cb); return () => {}; },
    onFileDelete: (cb) => { listeners.delete(cb); return () => {}; },
    onFileRename: (cb) => { listeners.rename(cb); return () => {}; },
    readFile: vi.fn().mockResolvedValue('mock content'),
};

describe('IndexController', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('onLayoutReady - 注册 4 个 vault 事件订阅', async () => {
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
        expect(listeners.create).toHaveBeenCalled();
        expect(listeners.modify).toHaveBeenCalled();
        expect(listeners.delete).toHaveBeenCalled();
        expect(listeners.rename).toHaveBeenCalled();
    });

    it('pause / resume 透传到 IndexManager', async () => {
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
        ctl.indexManager.enqueue('a.md', 'upsert');
        expect(get(ctl.indexManager.status$).state).toBe('Paused');
        ctl.resume();
        expect(get(ctl.indexManager.status$).state).not.toBe('Paused');
    });

    it('destroy - 退订所有 vault 事件', async () => {
        const unsubs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
        const ctl = new IndexController(
            {
                onFileCreate: () => unsubs[0],
                onFileModify: () => unsubs[1],
                onFileDelete: () => unsubs[2],
                onFileRename: () => unsubs[3],
                readFile: vi.fn().mockResolvedValue(''),
            },
            {
                fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
                incrementalIndex: vi.fn().mockResolvedValue({ indexed: 1, errors: 0 }),
                deleteFile: vi.fn().mockResolvedValue(0),
            },
            '/tmp',
        );
        await ctl.onLayoutReady();
        ctl.destroy();
        for (const u of unsubs) expect(u).toHaveBeenCalled();
    });

    it('onFileCreate - png 等非 md - 不读文件不入队', async () => {
        vi.useFakeTimers();
        let createCb: (p: string) => void = () => {};
        const readFile = vi.fn().mockResolvedValue('# hi');
        const incrementalIndex = vi.fn().mockResolvedValue({ indexed: 1, errors: 0 });
        const ctl = new IndexController(
            {
                onFileCreate: (cb) => {
                    createCb = cb;
                    return () => {};
                },
                onFileModify: () => () => {},
                onFileDelete: () => () => {},
                onFileRename: () => () => {},
                readFile,
            },
            {
                fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
                incrementalIndex,
                deleteFile: vi.fn().mockResolvedValue(0),
            },
            '/tmp',
        );
        await ctl.onLayoutReady(false);
        createCb('photo.png');
        await vi.advanceTimersByTimeAsync(5000);
        expect(readFile).not.toHaveBeenCalled();
        expect(incrementalIndex).not.toHaveBeenCalled();
        expect(get(ctl.indexManager.status$).state).not.toBe('Queueing');
        ctl.destroy();
        vi.useRealTimers();
    });

    it('enqueue - 非 md - 跳过', async () => {
        const readFile = vi.fn().mockResolvedValue('x');
        const ctl = new IndexController(
            {
                onFileCreate: () => () => {},
                onFileModify: () => () => {},
                onFileDelete: () => () => {},
                onFileRename: () => () => {},
                readFile,
            },
            {
                fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
                incrementalIndex: vi.fn().mockResolvedValue({ indexed: 1, errors: 0 }),
                deleteFile: vi.fn().mockResolvedValue(0),
            },
            '/tmp',
        );
        await ctl.onLayoutReady(false);
        await ctl.enqueue('shot.jpg', 'upsert');
        expect(readFile).not.toHaveBeenCalled();
        ctl.destroy();
    });
});
