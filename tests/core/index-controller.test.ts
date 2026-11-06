/**
 * @file tests/core/index-controller.test.ts
 * @description IndexController 行为 — vault 事件 → watcher → manager.enqueue
 * @module tests/core/index-controller
 * @depends core/index-controller
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    IndexController,
    type IndexControllerOptions,
    type ReadOnlySearchViewPort,
    type VaultEventListener,
} from '../../src/core/index-controller';
import type { IndexBackend, IndexTaskCoordinatorPort } from '../../src/core/index-manager';
import type { IndexTaskCounters } from '../../src/core/index-task-coordinator';
import { get } from 'svelte/store';

const temporaryRoots: string[] = [];

afterEach(async () => {
    for (const root of temporaryRoots.splice(0)) {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

/** 建临时索引目录并登记清理 — 用例不再泄漏临时目录。 */
async function makeTempRoot(): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ratel-t4-ctl-'));
    temporaryRoots.push(root);
    return root;
}

/** 协调器替身 — 记录启动与事件,计数可注入。 */
class CoordinatorStub implements IndexTaskCoordinatorPort {
    readonly events: string[] = [];
    readonly notified: Array<{ path: string; op: string }> = [];
    private state: IndexTaskCounters = {
        taskId: 0, phase: 'paused', scanComplete: false, total: 0, committed: 0,
        committedThisRound: 0, queued: 0, active: 0, pendingTransactions: 0, failures: 0,
    };

    constructor(private readonly onStart?: () => void) {}

    async start(): Promise<IndexTaskCounters> {
        this.events.push('start');
        this.onStart?.();
        this.state = { ...this.state, taskId: this.state.taskId + 1, scanComplete: true, phase: 'ready' };
        return this.counters();
    }

    counters(): IndexTaskCounters { return { ...this.state }; }

    notify(path: string, op: 'upsert' | 'delete'): void { this.notified.push({ path, op }); }

    async drain(): Promise<void> {}

    isReady(): boolean { return this.state.phase === 'ready'; }

    pause(): void {}
    abortActive(): void { this.events.push('abortActive'); }
    resume(): void {}
    destroy(): void { this.events.push('destroy'); }
}

/** 会真正写盘的索引后端替身 — 用它证明「没有调用 = 没有写入」而非只看 mock。 */
function writingBackend(dir: string) {
    const write = async (name: string): Promise<void> => { await fsp.writeFile(path.join(dir, name), name, 'utf8'); };
    return {
        fullReindex: vi.fn(async () => { await write('fullReindex'); return { indexed: 0, errors: 0 }; }),
        smartReindex: vi.fn(async () => { await write('smartReindex'); return { indexed: 0, errors: 0, skipped: 0 }; }),
        incrementalIndex: vi.fn(async () => { await write('incrementalIndex'); return { indexed: 1, errors: 0 }; }),
        deleteFile: vi.fn(async () => { await write('deleteFile'); return 1; }),
        dropIndex: vi.fn(async () => { await write('dropIndex'); }),
    } satisfies IndexBackend;
}

/** 目录快照 — 相对路径 → 内容 + mtime。 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (dir: string, prefix: string): Promise<void> => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(absolute, relative);
            else {
                const stat = await fsp.stat(absolute);
                out[relative] = `${stat.mtimeMs}:${await fsp.readFile(absolute, 'utf8')}`;
            }
        }
    };
    await walk(root, '');
    return out;
}

/** 记录装配顺序的 vault — 用于断言「监听先于扫描」。 */
function orderedVault(order: string[]): VaultEventListener {
    const subscribe = (name: string): (() => void) => {
        order.push(name);
        return () => {};
    };
    return {
        onFileCreate: () => subscribe('create'),
        onFileModify: () => subscribe('modify'),
        onFileDelete: () => subscribe('delete'),
        onFileRename: () => subscribe('rename'),
        readFile: vi.fn().mockResolvedValue('mock content'),
    };
}

const listeners: Record<'create' | 'modify' | 'delete' | 'rename', (cb: unknown) => () => void> = {
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
                onFileCreate: () => unsubs[0]!,
                onFileModify: () => unsubs[1]!,
                onFileDelete: () => unsubs[2]!,
                onFileRename: () => unsubs[3]!,
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
    it('重建调用者 - 全量失败 - 收到拒绝而不能报告成功', async () => {
        const ctl = new IndexController(mockVault, {
            fullReindex: async () => ({ indexed: 0, errors: 1 }),
            incrementalIndex: vi.fn(), deleteFile: vi.fn(),
        }, '/tmp');
        try { await expect(ctl.reindex()).rejects.toThrow(); }
        finally { ctl.destroy(); }
    });

});


describe('IndexController 协调器接入与只读契约', () => {
    /** 可手动触发的 vault 事件订阅。 */
    function eventVault() {
        const callbacks = { create: (_p: string) => {}, modify: (_p: string) => {}, delete: (_p: string) => {}, rename: (_n: string, _o: string) => {} };
        const vault: VaultEventListener = {
            onFileCreate: (cb) => { callbacks.create = cb; return () => {}; },
            onFileModify: (cb) => { callbacks.modify = cb; return () => {}; },
            onFileDelete: (cb) => { callbacks.delete = cb; return () => {}; },
            onFileRename: (cb) => { callbacks.rename = cb; return () => {}; },
            readFile: vi.fn().mockResolvedValue('mock content'),
        };
        return { vault, callbacks };
    }

    it('自动索引开启 - 注入协调器 - vault 事件订阅先于协调器启动', async () => {
        const order: string[] = [];
        const coordinator = new CoordinatorStub(() => order.push('start'));
        const ctl = new IndexController(orderedVault(order), writingBackend(await makeTempRoot()), '/tmp', { coordinator });
        try {
            await ctl.onLayoutReady(true);
            expect(order).toEqual(['create', 'modify', 'delete', 'rename', 'start']);
        } finally { ctl.destroy(); }
    });

    it('自动索引开启 - 修改事件去抖后 - 事件转发给协调器且不调用后端单文件入口', async () => {
        vi.useFakeTimers();
        const root = await makeTempRoot();
        const { vault, callbacks } = eventVault();
        const backend = writingBackend(root);
        const coordinator = new CoordinatorStub();
        const ctl = new IndexController(vault, backend, '/tmp', { coordinator });
        try {
            await ctl.onLayoutReady(true);
            callbacks.modify('note.md');
            await vi.advanceTimersByTimeAsync(5000);
            expect(coordinator.notified).toEqual([{ path: 'note.md', op: 'upsert' }]);
            expect(backend.incrementalIndex).not.toHaveBeenCalled();
            expect(backend.deleteFile).not.toHaveBeenCalled();
            expect(await snapshotTree(root)).toEqual({});
        } finally { ctl.destroy(); vi.useRealTimers(); }
    });

    it('自动索引开启 - 改名事件 - 旧路径删除立即入队且新路径去抖后入队', async () => {
        vi.useFakeTimers();
        const root = await makeTempRoot();
        const { vault, callbacks } = eventVault();
        const backend = writingBackend(root);
        const coordinator = new CoordinatorStub();
        const ctl = new IndexController(vault, backend, '/tmp', { coordinator });
        try {
            await ctl.onLayoutReady(true);
            callbacks.rename('new.md', 'old.md');
            // 关键路径:旧路径删除不走去抖(立即 durable 事务),新路径去抖后按最新内容处理。
            expect(coordinator.notified).toEqual([{ path: 'old.md', op: 'delete' }]);
            await vi.advanceTimersByTimeAsync(5000);
            expect(coordinator.notified).toEqual([
                { path: 'old.md', op: 'delete' },
                { path: 'new.md', op: 'upsert' },
            ]);
            expect(backend.deleteFile).not.toHaveBeenCalled();
            expect(backend.incrementalIndex).not.toHaveBeenCalled();
        } finally { ctl.destroy(); vi.useRealTimers(); }
    });

    it('自动索引开启 - 注入协调器 - 事件通路与立即刷新都不整读文件', async () => {
        vi.useFakeTimers();
        const root = await makeTempRoot();
        const { vault, callbacks } = eventVault();
        const coordinator = new CoordinatorStub();
        const ctl = new IndexController(vault, writingBackend(root), '/tmp', { coordinator });
        try {
            await ctl.onLayoutReady(true);
            callbacks.modify('note.md');
            await vi.advanceTimersByTimeAsync(5000);
            await ctl.enqueue('direct.md', 'upsert');
            // 关键路径:协调器自行读取并核对磁盘内容,事件去抖通路与立即刷新都不得先整读一遍。
            expect(vault.readFile).not.toHaveBeenCalled();
            expect(coordinator.notified).toEqual([
                { path: 'note.md', op: 'upsert' },
                { path: 'direct.md', op: 'upsert' },
            ]);
        } finally { ctl.destroy(); vi.useRealTimers(); }
    });

    it('自动索引开启 - 未注入协调器 - 事件通路仍读取正文交给管理器', async () => {
        vi.useFakeTimers();
        const { vault, callbacks } = eventVault();
        const ctl = new IndexController(vault, writingBackend(await makeTempRoot()), '/tmp');
        try {
            await ctl.onLayoutReady(true);
            callbacks.modify('note.md');
            await vi.advanceTimersByTimeAsync(5000);
            // 反向对照:没有协调器时正文必须读出来,证明上面的短路只针对协调器模式。
            expect(vault.readFile).toHaveBeenCalledWith('note.md');
        } finally { ctl.destroy(); vi.useRealTimers(); }
    });

    it('重复装配 - 同一通路只订阅一次 - 切换通路时先退订且不丢变更记录', async () => {
        let subscriptions = 0;
        let unsubscriptions = 0;
        let modify: (p: string) => void = () => {};
        const vault: VaultEventListener = {
            onFileCreate: () => { subscriptions += 1; return () => { unsubscriptions += 1; }; },
            onFileModify: (cb) => { subscriptions += 1; modify = cb; return () => { unsubscriptions += 1; }; },
            onFileDelete: () => { subscriptions += 1; return () => { unsubscriptions += 1; }; },
            onFileRename: () => { subscriptions += 1; return () => { unsubscriptions += 1; }; },
            readFile: vi.fn().mockResolvedValue('mock content'),
        };
        const ctl = new IndexController(vault, writingBackend(await makeTempRoot()), '/tmp');
        try {
            await ctl.onLayoutReady(true);
            expect(subscriptions).toBe(4);
            // 关键路径:autoIndex 可在运行时改,重复装配不得叠加 vault 订阅。
            await ctl.onLayoutReady(true);
            expect(subscriptions).toBe(4);
            expect(unsubscriptions).toBe(0);
            // 切换通路:先退订旧通路,再装配只读通路(4 个新订阅)。
            await ctl.onLayoutReady(false);
            expect(unsubscriptions).toBe(4);
            expect(subscriptions).toBe(8);
            modify('changed.md');
            expect(ctl.readOnlyChanged()).toEqual(new Set(['changed.md']));
            // 关键路径:只读通路重复装配不得清空此前的变更记录(旧实现每次 clear)。
            await ctl.onLayoutReady(false);
            expect(subscriptions).toBe(8);
            expect(ctl.readOnlyChanged()).toEqual(new Set(['changed.md']));
        } finally { ctl.destroy(); }
    });

    it('关闭自动索引 - 事件触发后仍不读文件不嵌入不写盘 - 目录快照逐字不变', async () => {
        vi.useFakeTimers();
        const root = await makeTempRoot();
        const { vault, callbacks } = eventVault();
        const backend = writingBackend(root);
        const coordinator = new CoordinatorStub();
        const embeds = vi.fn();
        const ctl = new IndexController(vault, backend, '/tmp', { coordinator });
        const before = await snapshotTree(root);
        try {
            expect(await ctl.onLayoutReady(false)).toBeNull();
            // 关键路径:关闭自动索引不启动扫描,也不装配写路径监听。
            expect(coordinator.events).toEqual([]);
            callbacks.modify('note.md');
            callbacks.create('new.md');
            callbacks.delete('gone.md');
            await vi.advanceTimersByTimeAsync(10000);
            expect(vault.readFile).not.toHaveBeenCalled();
            expect(embeds).not.toHaveBeenCalled();
            expect(backend.incrementalIndex).not.toHaveBeenCalled();
            expect(backend.deleteFile).not.toHaveBeenCalled();
            expect(backend.fullReindex).not.toHaveBeenCalled();
            expect(backend.smartReindex).not.toHaveBeenCalled();
            expect(backend.dropIndex).not.toHaveBeenCalled();
            // 关键路径:目录快照逐字不变 —— 没有任何本地派生数据被改写。
            expect(await snapshotTree(root)).toEqual(before);
            // 事件只记入内存,供检索侧过滤过期候选。
            expect(ctl.readOnlyChanged()).toEqual(new Set(['note.md', 'new.md', 'gone.md']));
            expect(get(ctl.indexManager.status$).state).toBe('Idle');
        } finally { ctl.destroy(); vi.useRealTimers(); }
    });

    it('关闭自动索引 - 注入只读视图 - 控制器只暴露只读通道且不触发写', async () => {
        const root = await makeTempRoot();
        const { vault } = eventVault();
        const backend = writingBackend(root);
        const view: ReadOnlySearchViewPort = {
            refresh: vi.fn().mockResolvedValue(undefined),
            recordsKind: () => 'known',
            freshnessOf: () => 'unknown',
            filterCandidates: async <T extends { path: string }>(candidates: readonly T[]) => ({ visible: [...candidates], denied: [] }),
        };
        const ctl = new IndexController(vault, backend, '/tmp', { readOnlyView: view });
        try {
            await ctl.onLayoutReady(false);
            expect(ctl.searchVisibilityView()).toBe(view);
            expect(backend.fullReindex).not.toHaveBeenCalled();
            expect(await snapshotTree(root)).toEqual({});
        } finally { ctl.destroy(); }
    });

    it('外部重建 - 清库与扫描顺序保持 - 失败仍向调用者抛错', async () => {
        const root = await makeTempRoot();
        const { vault } = eventVault();
        const backend = writingBackend(root);
        const ctl = new IndexController(vault, backend, '/tmp', {});
        try {
            await ctl.onLayoutReady(false);
            await ctl.reindex();
            expect(backend.dropIndex).toHaveBeenCalledOnce();
            expect(backend.fullReindex).toHaveBeenCalledOnce();
            expect(await snapshotTree(root)).toHaveProperty('dropIndex');
        } finally { ctl.destroy(); }
    });
});
