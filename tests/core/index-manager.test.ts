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
 it('扫描失败 - 扫描期间已有增量排队 - 保留队列直到显式恢复', async () => {
  let reject!: (err: Error) => void;
  const incremental = vi.fn(async () => ({ indexed: 1, errors: 0 }));
  const manager = new IndexManager({
   fullReindex: () => new Promise((_resolve, fail) => { reject = fail; }),
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
