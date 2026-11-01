/**
 * @file tests/core/index-manager.test.ts
 * @description IndexManager 行为 — 初始 / 增量(自动消费) / 暂停 / 恢复 / 重索引 / 失败
 * @module tests/core/index-manager
 * @depends core/index-manager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IndexManager, type IndexTaskCoordinatorPort } from '../../src/core/index-manager';
import type { IndexTaskCounters } from '../../src/core/index-task-coordinator';
import { get } from 'svelte/store';

/** 协调器替身 — 只暴露管理器依赖的端口,计数可注入。 */
class CoordinatorStub implements IndexTaskCoordinatorPort {
    started = 0;
    readonly notified: Array<{ path: string; op: string }> = [];
    readonly events: string[] = [];
    pausedCount = 0;
    resumedCount = 0;
    /** `abortActive` 调用次数 — 顺序断言(先撤销在途、再停止调度)的可观察点。 */
    abortCount = 0;
    /** 调用顺序记录 — 供「先 abortActive 后 pause」的用例断言。 */
    readonly callOrder: string[] = [];
    destroyed = 0;
    private state: IndexTaskCounters = {
        taskId: 0, phase: 'paused', scanComplete: false, total: 0, committed: 0,
        committedThisRound: 0, queued: 0, active: 0, pendingTransactions: 0, failures: 0,
    };

    constructor(private readonly onStart?: () => void) {}

    async start(): Promise<IndexTaskCounters> {
        this.started += 1;
        this.events.push('start');
        this.onStart?.();
        this.state = { ...this.state, taskId: this.state.taskId + 1, scanComplete: true, phase: 'ready' };
        return this.counters();
    }

    counters(): IndexTaskCounters {
        return { ...this.state };
    }

    notify(path: string, op: 'upsert' | 'delete'): void {
        this.notified.push({ path, op });
    }

    async drain(): Promise<void> {}

    isReady(): boolean {
        return this.state.phase === 'ready' && this.state.failures === 0;
    }

    pause(): void { this.pausedCount += 1; this.callOrder.push('pause'); }
    abortActive(): void { this.abortCount += 1; this.callOrder.push('abortActive'); }
    resume(): void { this.resumedCount += 1; }
    destroy(): void { this.destroyed += 1; }

    set(next: Partial<IndexTaskCounters>): void {
        this.state = { ...this.state, ...next };
    }
}

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

    it('smartReindex - 索引不存在 - 仍调 smartReindex(内部转全量)', async () => {
        // 关键路径:onLayoutReady 只检查方法存在性,始终调 smartReindex。
        // 索引不存在时的全量逻辑由 smartReindex 内部处理(spec §5.2),IndexManager 不感知。
        const fullSpy = vi.fn();
        const smartSpy = vi.fn().mockResolvedValue({ indexed: 5, errors: 0, skipped: 0 });
        const mgr = new IndexManager({
            fullReindex: fullSpy,
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: smartSpy,
            isIndexCreated: vi.fn().mockResolvedValue(false),
            listMarkdownFiles: vi.fn(),
        });
        await mgr.onLayoutReady();
        expect(smartSpy).toHaveBeenCalled();
        expect(fullSpy).not.toHaveBeenCalled();
        expect(get(mgr.status$)).toMatchObject({ state: 'Ready' });
    });

    it('smartReindex - 索引存在 - 走 smart 零 embed', async () => {
        const fullSpy = vi.fn();
        const smartSpy = vi.fn().mockResolvedValue({ indexed: 0, errors: 0, skipped: 5 });
        const mgr = new IndexManager({
            fullReindex: fullSpy,
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: smartSpy,
            isIndexCreated: vi.fn().mockResolvedValue(true),
            listMarkdownFiles: vi.fn(),
        });
        await mgr.onLayoutReady();
        expect(smartSpy).toHaveBeenCalled();
        expect(fullSpy).not.toHaveBeenCalled();
        expect(get(mgr.status$)).toMatchObject({ state: 'Ready' });
    });

    it('smartReindex - 状态经过 Diffing', async () => {
        const smartSpy = vi.fn().mockResolvedValue({ indexed: 0, errors: 0, skipped: 0 });
        const states: string[] = [];
        const mgr = new IndexManager({
            fullReindex: vi.fn(),
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: smartSpy,
            isIndexCreated: vi.fn().mockResolvedValue(true),
            listMarkdownFiles: vi.fn(),
        });
        const unsub = mgr.status$.subscribe((s) => states.push(s.state));
        await mgr.onLayoutReady();
        unsub();
        // 关键路径:热启动应经过 Diffing 状态。
        expect(states).toContain('Diffing');
        expect(states[states.length - 1]).toBe('Ready');
    });

    it('smartReindex - backend 无 smartReindex - 回退全量(向后兼容)', async () => {
        // 关键路径:渐进式迁移,backend 未实现 smartReindex 时回退到 fullReindex。
        const fullSpy = vi.fn().mockResolvedValue({ indexed: 3, errors: 0 });
        const mgr = new IndexManager({
            fullReindex: fullSpy,
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            // 不提供 smartReindex / isIndexCreated / listMarkdownFiles
        });
        await mgr.onLayoutReady();
        expect(fullSpy).toHaveBeenCalled();
        expect(get(mgr.status$)).toMatchObject({ state: 'Ready' });
    });

    it('smartReindex - smart 失败 - 状态 Failed', async () => {
        const smartSpy = vi.fn().mockRejectedValue(new Error('embed failed'));
        const mgr = new IndexManager({
            fullReindex: vi.fn(),
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: smartSpy,
            isIndexCreated: vi.fn().mockResolvedValue(true),
            listMarkdownFiles: vi.fn(),
        });
        await mgr.onLayoutReady();
        expect(get(mgr.status$)).toMatchObject({ state: 'Failed' });
    });
});


describe('索引协调', () => {
 it('启动扫描 - 重复启动和增量并发 - 复用扫描且串行追平', async () => {
  let finish!: () => void;
  const order: string[] = [];
  const manager = new IndexManager({
   fullReindex: async () => { order.push('scan'); await new Promise<void>(r => { finish = r; }); order.push('scanned'); return { indexed: 1, errors: 0 }; },
   incrementalIndex: async file => { order.push(file.content); return { indexed: 1, errors: 0 }; },
   deleteFile: async () => 0,
  });
  const first = manager.onLayoutReady();
  const second = manager.onLayoutReady();
  manager.enqueue('a.md', 'upsert', 'updated');
  await Promise.resolve();
  expect(order).toEqual(['scan']);
  finish();
  await Promise.all([first, second]);
  await manager.flush();
  expect(order).toEqual(['scan', 'scanned', 'updated']);
 });
 it('重建 - 清库失败 - 停止扫描并保留失败状态', async () => {
  const scan = vi.fn(async () => ({ indexed: 1, errors: 0 }));
  const manager = new IndexManager({ fullReindex: scan, incrementalIndex: vi.fn(), deleteFile: vi.fn(), dropIndex: async () => { throw new Error('drop failed'); } });
  await manager.reindex();
  expect(scan).not.toHaveBeenCalled();
  expect(get(manager.status$).state).toBe('Failed');
 });
 it('启动扫描 - 部分错误 - 返回失败且不进入 Ready', async () => {
  const manager = new IndexManager({ fullReindex: async () => ({ indexed: 1, errors: 1 }), incrementalIndex: vi.fn(), deleteFile: vi.fn() });
  expect(await manager.onLayoutReady()).toBeNull();
  expect(get(manager.status$).state).toBe('Failed');
 });
});


describe('失败状态保持', () => {
 it('扫描失败 - 扫描期间已有增量排队 - 显式恢复重扫成功后追平', async () => {
  let reject!: (err: Error) => void;
  const incremental = vi.fn(async () => ({ indexed: 1, errors: 0 }));
  let scans = 0;
  const manager = new IndexManager({
   fullReindex: () => ++scans === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve({ indexed: 2, errors: 0 }),
   incrementalIndex: incremental, deleteFile: vi.fn(),
  });
  const scan = manager.onLayoutReady();
  await Promise.resolve();
  manager.enqueue('a.md', 'upsert', 'latest');
  reject(new Error('scan failed'));
  await scan;
  await manager.flush();
  expect(incremental).not.toHaveBeenCalled();
  expect(get(manager.status$).state).toBe('Failed');
  manager.enqueue('b.md', 'upsert', 'new');
  expect(get(manager.status$).state).toBe('Failed');
  manager.resume();
  await vi.waitFor(() => expect(incremental).toHaveBeenCalledTimes(2));
 });
 it('增量失败 - 后面仍有排队 - 停止消费且不覆盖Failed', async () => {
  const order: string[] = [];
  const manager = new IndexManager({ fullReindex: vi.fn(), deleteFile: vi.fn(), incrementalIndex: async file => {
   order.push(file.path); return { indexed: 0, errors: file.path === 'a.md' ? 1 : 0 };
  } });
  manager.pause(); manager.enqueue('a.md', 'upsert', 'a'); manager.enqueue('b.md', 'upsert', 'b'); manager.resume();
  await vi.waitFor(() => expect(get(manager.status$).state).toBe('Failed'));
  expect(order).toEqual(['a.md']);
 });
 it('手动重建 - 扫描与增量同时请求 - 按扫描重建增量顺序且保留事件', async () => {
  const order: string[] = [];
  let release!: () => void;
  const manager = new IndexManager({
   fullReindex: async () => { order.push('full'); if (order.length === 1) await new Promise<void>(r => { release = r; }); return { indexed: 1, errors: 0 }; },
   dropIndex: async () => { order.push('drop'); },
   incrementalIndex: async () => { order.push('incremental'); return { indexed: 1, errors: 0 }; }, deleteFile: vi.fn(),
  });
  const startup = manager.onLayoutReady(); await Promise.resolve();
  const rebuild = manager.reindex(); manager.enqueue('a.md', 'upsert', 'latest');
  release(); await Promise.all([startup, rebuild]);
  await vi.waitFor(() => expect(order).toEqual(['full', 'drop', 'full', 'incremental']));
 });
});

describe('暂停期间的真实完成状态', () => {
    it('启动扫描 - 暂停后扫描失败再空队列恢复 - 保留最新Failed', async () => {
        let finish!: (result: { indexed: number; errors: number }) => void;
        const manager = new IndexManager({
            fullReindex: () => new Promise(resolve => { finish = resolve; }),
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
        });
        const scan = manager.onLayoutReady();
        await Promise.resolve();
        manager.pause();
        finish({ indexed: 0, errors: 1 });
        expect(await scan).toBeNull();
        const failure = get(manager.status$);
        expect(failure.state).toBe('Failed');
        manager.resume();
        expect(get(manager.status$)).toEqual(failure);
        manager.destroy();
    });

    it('启动扫描 - 暂停后扫描成功再空队列恢复 - 保留真实Ready统计', async () => {
        let finish!: (result: { indexed: number; errors: number }) => void;
        const manager = new IndexManager({
            fullReindex: () => new Promise(resolve => { finish = resolve; }),
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
        });
        const scan = manager.onLayoutReady();
        await Promise.resolve();
        manager.pause();
        finish({ indexed: 3, errors: 0 });
        await scan;
        const complete = get(manager.status$);
        expect(complete).toMatchObject({ state: 'Ready', totalDocs: 3 });
        manager.resume();
        expect(get(manager.status$)).toEqual(complete);
        manager.destroy();
    });

    it('启动扫描 - 暂停后尚未完成便恢复 - 恢复真实运行状态', async () => {
        let finish!: (result: { indexed: number; errors: number }) => void;
        const manager = new IndexManager({
            fullReindex: () => new Promise(resolve => { finish = resolve; }),
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
        });
        const scan = manager.onLayoutReady();
        await Promise.resolve();
        const running = get(manager.status$);
        manager.pause();
        manager.resume();
        expect(get(manager.status$)).toEqual(running);
        finish({ indexed: 0, errors: 0 });
        await scan;
        manager.destroy();
    });

    it('增量失败 - 失败条目保留队列后显式恢复 - 重试成功才进入Ready', async () => {
        let attempts = 0;
        const manager = new IndexManager({
            fullReindex: vi.fn(),
            incrementalIndex: async () => ({ indexed: attempts++ === 0 ? 0 : 1, errors: attempts === 1 ? 1 : 0 }),
            deleteFile: vi.fn(),
        });
        manager.enqueue('retry.md', 'upsert', 'latest');
        await manager.flush();
        expect(get(manager.status$).state).toBe('Failed');
        manager.resume();
        await manager.flush();
        expect(attempts).toBe(2);
        expect(get(manager.status$).state).toBe('Ready');
        manager.destroy();
    });
});


describe('协调器接入', () => {
    const backendStub = () => ({
        fullReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0 }),
        smartReindex: vi.fn().mockResolvedValue({ indexed: 0, errors: 0, skipped: 0 }),
        incrementalIndex: vi.fn().mockResolvedValue({ indexed: 1, errors: 0 }),
        deleteFile: vi.fn().mockResolvedValue(1),
    });

    it('启动扫描 - 注入协调器 - 由协调器驱动且不再调用整批重扫入口', async () => {
        const backend = backendStub();
        const coordinator = new CoordinatorStub();
        const manager = new IndexManager(backend, coordinator);
        await manager.onLayoutReady();
        expect(coordinator.started).toBe(1);
        expect(backend.smartReindex).not.toHaveBeenCalled();
        expect(backend.fullReindex).not.toHaveBeenCalled();
        expect(get(manager.status$)).toMatchObject({ state: 'Ready' });
        manager.destroy();
    });

    it('增量事件 - 注入协调器 - 转发给协调器且不调用后端单文件入口', async () => {
        const backend = backendStub();
        const coordinator = new CoordinatorStub();
        const manager = new IndexManager(backend, coordinator);
        await manager.onLayoutReady();
        manager.enqueue('a.md', 'upsert', '内容');
        expect(coordinator.notified).toEqual([{ path: 'a.md', op: 'upsert' }]);
        expect(backend.incrementalIndex).not.toHaveBeenCalled();
        expect(backend.deleteFile).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('状态展示 - 协调器 ready - 区分总文件数、已提交数与失败数', async () => {
        const coordinator = new CoordinatorStub();
        coordinator.set({ committed: 7, total: 9, failures: 0 });
        const manager = new IndexManager(backendStub(), coordinator);
        await manager.onLayoutReady();
        expect(get(manager.status$)).toMatchObject({
            state: 'Ready', totalDocs: 7, committedDocs: 7, totalFiles: 9, pendingDocs: 0, failedDocs: 0, phase: 'ready',
        });
        manager.destroy();
    });

    it('状态展示 - 新一轮 taskId 递增且未收敛 - 不沿用旧任务完成统计', async () => {
        const coordinator = new CoordinatorStub();
        const manager = new IndexManager(backendStub(), coordinator);
        await manager.onLayoutReady();
        expect(get(manager.status$)).toMatchObject({ state: 'Ready', totalDocs: 0 });
        // 新一轮:扫描结束但仍有待处理项,旧任务的 0 篇完成统计不得继续展示为 Ready。
        coordinator.set({ taskId: 5, phase: 'processing', scanComplete: true, total: 5, committed: 3, queued: 2, committedThisRound: 1 });
        manager.enqueue('a.md', 'upsert');
        const status = get(manager.status$);
        expect(status.state).toBe('Queueing');
        expect(status).toMatchObject({ pending: 2, reverifying: true, committed: 3, phase: 'processing' });
        expect(status).not.toHaveProperty('totalDocs');
        manager.destroy();
    });

    it('状态展示 - 协调器报告失败 - 不进入 Ready', async () => {
        const coordinator = new CoordinatorStub();
        coordinator.set({ failures: 2, committed: 1, total: 3 });
        const manager = new IndexManager(backendStub(), coordinator);
        const result = await manager.onLayoutReady();
        expect(result).toEqual({ indexed: 0, errors: 2 });
        expect(coordinator.counters().failures).toBe(2);
        expect(get(manager.status$).state).toBe('Failed');
        manager.destroy();
    });

    it('部分检索可用性 - 后端未实现记录视图 - 返回 null 而不是空集', async () => {
        const manager = new IndexManager(backendStub());
        expect(await manager.searchableFileRecords()).toBeNull();
        manager.destroy();
    });

    it('部分检索可用性 - 后端实现记录视图 - 原样透传', async () => {
        const records = { total: 1, records: [{ path: 'a.md', state: 'present' as const, revision: 1, inputHash: 'h', chunkCount: 2 }] };
        const manager = new IndexManager({ ...backendStub(), searchableFileRecords: vi.fn().mockResolvedValue(records) });
        expect(await manager.searchableFileRecords()).toEqual(records);
        manager.destroy();
    });

    it('暂停与恢复 - 注入协调器 - 透传到协调器', async () => {
        const coordinator = new CoordinatorStub();
        const manager = new IndexManager(backendStub(), coordinator);
        await manager.onLayoutReady();
        manager.pause();
        expect(coordinator.pausedCount).toBe(1);
        expect(get(manager.status$)).toMatchObject({ state: 'Paused' });
        manager.resume();
        expect(coordinator.resumedCount).toBe(1);
        manager.destroy();
        expect(coordinator.destroyed).toBe(1);
    });

    it('重建 - 注入协调器 - 不清库 - 撤销在途调用后重新核对', async () => {
        const backend = backendStub();
        const order: string[] = [];
        backend.fullReindex = vi.fn(async () => { order.push('full'); return { indexed: 0, errors: 0 }; });
        const coordinator = new CoordinatorStub(() => order.push('coordinator-start'));
        const dropIndex = vi.fn(async () => { order.push('drop'); });
        (backend as { dropIndex?: () => Promise<void> }).dropIndex = dropIndex;
        const manager = new IndexManager(backend, coordinator);
        await manager.onLayoutReady();
        await manager.reindex();
        // 关键路径:代际装配下手动重建**不得清库** —— 清库会抹掉当前代际的向量与日志凭据,
        // 等于静默丢弃当前有效索引;重建改为撤销在途调用后重新跑一轮逐文件核对。
        expect(order).toEqual(['coordinator-start', 'coordinator-start']);
        expect(dropIndex).not.toHaveBeenCalled();
        expect(coordinator.abortCount).toBe(1);
        expect(coordinator.resumedCount).toBe(1);
        expect(backend.fullReindex).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('暂停 - 注入协调器 - 先撤销在途调用再停止调度', async () => {
        const coordinator = new CoordinatorStub();
        const manager = new IndexManager(backendStub(), coordinator);
        await manager.onLayoutReady();
        manager.pause();
        // 关键路径(I6):顺序必须先是 abortActive(撤销在途调用),再是 pause(停止调度新文件)。
        expect(coordinator.callOrder).toEqual(['abortActive', 'pause']);
        manager.destroy();
    });

    it('重建 - 协调器在途 drain - 重扫不与其交错', async () => {
        const order: string[] = [];
        let releaseDrain!: () => void;
        const backend = backendStub();
        const dropIndex = vi.fn(async () => { order.push('drop'); });
        (backend as { dropIndex?: () => Promise<void> }).dropIndex = dropIndex;
        const coordinator = new CoordinatorStub(() => order.push('coordinator-start'));
        // 在途提交:drain 卡住时,重建必须排在它之后。
        coordinator.drain = async () => {
            order.push('drain');
            await new Promise<void>((resolve) => { releaseDrain = resolve; });
            order.push('drain-done');
        };
        const manager = new IndexManager(backend, coordinator);
        await manager.onLayoutReady();
        manager.enqueue('a.md', 'upsert');
        await vi.waitFor(() => expect(order).toContain('drain'));

        const rebuilding = manager.reindex();
        await Promise.resolve();
        // 关键路径:协调器分支若不挂到 this.tail,重建会在 drain 未收敛时就开始。
        expect(order.filter((item) => item === 'coordinator-start')).toHaveLength(1);
        releaseDrain();
        await rebuilding;
        expect(order.filter((item) => item === 'coordinator-start')).toHaveLength(2);
        expect(order.lastIndexOf('coordinator-start')).toBeGreaterThan(order.indexOf('drain-done'));
        expect(order.indexOf('coordinator-start')).toBeLessThan(order.indexOf('drain'));
        expect(dropIndex).not.toHaveBeenCalled();
        manager.destroy();
    });

    it('状态展示 - 新一轮首次发布即扫描结束但未收敛 - 显示重新核对中', async () => {
        const coordinator = new CoordinatorStub();
        // 关键路径:发布必须发生在记录 `lastTaskId` 之前 —— 反序会让本轮首次发布永远看不到新 taskId。
        coordinator.start = async () => {
            coordinator.set({ taskId: 9, phase: 'processing', scanComplete: true, total: 5, committed: 3, queued: 2, committedThisRound: 0 });
            return coordinator.counters();
        };
        const manager = new IndexManager(backendStub(), coordinator);
        await manager.onLayoutReady();
        expect(get(manager.status$)).toMatchObject({ state: 'Queueing', reverifying: true, pending: 2, committed: 3 });
        manager.destroy();
    });

    it('状态展示 - 新一轮 taskId 递增且本轮零提交 - 仍显示重新核对中', async () => {
        const coordinator = new CoordinatorStub();
        const manager = new IndexManager(backendStub(), coordinator);
        await manager.onLayoutReady();
        // 关键路径:只有 taskId 判据成立(committedThisRound 为 0)时也必须显示重新核对中。
        coordinator.set({ taskId: 2, phase: 'processing', scanComplete: true, committed: 3, queued: 1, committedThisRound: 0 });
        manager.enqueue('a.md', 'upsert');
        expect(get(manager.status$)).toMatchObject({ state: 'Queueing', reverifying: true, committed: 3 });
        // 反向对照:同一轮(与 lastTaskId 相等)且零提交时不得凭空显示重新核对中。
        coordinator.set({ taskId: 1, queued: 1, committedThisRound: 0 });
        manager.enqueue('a.md', 'upsert');
        expect(get(manager.status$)).toMatchObject({ state: 'Queueing', reverifying: false });
        manager.destroy();
    });
});


describe('协调器运行中的进度展示', () => {
    it.each(['完成', '卸载'] as const)('整轮尚未返回 - 中途计数刷新且%s后停止采样', async ending => {
        vi.useFakeTimers();
        const coordinator = new CoordinatorStub();
        let release!: (value: IndexTaskCounters) => void;
        const started = new Promise<void>(resolve => {
            vi.spyOn(coordinator, 'start').mockImplementation(() => {
                resolve();
                return new Promise<IndexTaskCounters>(done => { release = done; });
            });
        });
        const manager = new IndexManager({
            fullReindex: vi.fn(), incrementalIndex: vi.fn(), deleteFile: vi.fn(),
        }, coordinator);
        const startup = manager.onLayoutReady();
        try {
            await started;
            coordinator.set({ taskId: 1, total: 100, committed: 12, active: 1, queued: 87, phase: 'processing', scanComplete: true });
            await vi.advanceTimersByTimeAsync(500);
            expect(get(manager.status$)).toMatchObject({
                state: 'Queueing', total: 100, committed: 12, pending: 88, phase: 'processing',
            });
            if (ending === '卸载') {
                manager.destroy();
                expect(vi.getTimerCount()).toBe(0);
            }
            coordinator.set({ total: 100, committed: 100, committedThisRound: 100, active: 0, queued: 0, phase: 'ready' });
            release(coordinator.counters());
            await startup;
            expect(vi.getTimerCount()).toBe(0);
            expect(get(manager.status$).state).toBe(ending === '卸载' ? 'Unloaded' : 'Ready');
        } finally {
            release(coordinator.counters());
            await startup;
            manager.destroy();
            vi.useRealTimers();
        }
    });
});

describe('失败态保留稳定错误码(T7/I1)', () => {
    it('启动扫描 - 后端抛带码错误 - 失败态携带 errorCode 而不是只留 String(err)', async () => {
        const busy = Object.assign(new Error('写所有权被占用(开发向)'), { code: 'owner-busy' });
        const manager = new IndexManager({
            fullReindex: vi.fn(),
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: vi.fn().mockRejectedValue(busy),
        });
        await manager.onLayoutReady();

        expect(get(manager.status$)).toMatchObject({ state: 'Failed', errorCode: 'owner-busy' });
        // 开发向 message 仍留在 reason 里(日志/诊断用),但不作为上屏依据。
        expect((get(manager.status$) as { reason: string }).reason).toContain('写所有权被占用');
    });

    it('重建 - dropIndex 拒绝(归属断言)- 失败态携带 index-directory-not-owned', async () => {
        const refused = Object.assign(new Error('索引目录归属断言未通过'), { code: 'index-directory-not-owned' });
        const manager = new IndexManager({
            fullReindex: vi.fn(), incrementalIndex: vi.fn(), deleteFile: vi.fn(),
            dropIndex: async () => { throw refused; },
        });
        await manager.reindex();

        expect(get(manager.status$)).toMatchObject({ state: 'Failed', errorCode: 'index-directory-not-owned' });
    });

    it('启动扫描 - 无码错误 - 不伪造 errorCode,保持既有 reason 语义', async () => {
        const manager = new IndexManager({
            fullReindex: vi.fn().mockRejectedValue(new Error('embed failed')),
            incrementalIndex: vi.fn(), deleteFile: vi.fn(),
            smartReindex: vi.fn().mockRejectedValue(new Error('embed failed')),
        });
        await manager.onLayoutReady();

        const status = get(manager.status$);
        expect(status.state).toBe('Failed');
        expect((status as { errorCode?: string }).errorCode).toBeUndefined();
    });
});
