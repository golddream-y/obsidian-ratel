/**
 * @file tests/core/folder-watcher.test.ts
 * @description FolderWatcher 行为 — 5s 单文件去抖 / delete 不去抖 / stop 清空
 * @module tests/core/folder-watcher
 * @depends core/folder-watcher
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FolderWatcher } from '../../src/core/folder-watcher';

describe('FolderWatcher', () => {
    let watcher: FolderWatcher;
    let onUpsert: ReturnType<typeof vi.fn>;
    let onDelete: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        watcher = new FolderWatcher({ debounceMs: 5000 });
        onUpsert = vi.fn();
        onDelete = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('同 path 1s 内多次 modify - 5s 后只触发 1 次', () => {
        watcher.start({ onUpsert, onDelete });
        watcher.notify('foo.md', 'upsert');
        vi.advanceTimersByTime(1000);
        watcher.notify('foo.md', 'upsert');
        vi.advanceTimersByTime(1000);
        watcher.notify('foo.md', 'upsert');
        expect(onUpsert).not.toHaveBeenCalled();
        vi.advanceTimersByTime(5000);
        expect(onUpsert).toHaveBeenCalledTimes(1);
        expect(onUpsert).toHaveBeenCalledWith('foo.md');
    });

    it('不同 path 并行 - 各自独立触发', () => {
        watcher.start({ onUpsert, onDelete });
        watcher.notify('a.md', 'upsert');
        watcher.notify('b.md', 'upsert');
        vi.advanceTimersByTime(5000);
        expect(onUpsert).toHaveBeenCalledTimes(2);
        expect(onUpsert).toHaveBeenCalledWith('a.md');
        expect(onUpsert).toHaveBeenCalledWith('b.md');
    });

    it('delete 事件 - 立即触发(不去抖)', () => {
        watcher.start({ onUpsert, onDelete });
        watcher.notify('gone.md', 'delete');
        expect(onDelete).toHaveBeenCalledWith('gone.md');
        expect(onUpsert).not.toHaveBeenCalled();
    });

    it('stop - 清掉所有 pending', () => {
        watcher.start({ onUpsert, onDelete });
        watcher.notify('p.md', 'upsert');
        watcher.stop();
        vi.advanceTimersByTime(10_000);
        expect(onUpsert).not.toHaveBeenCalled();
    });

    it('notify 前未 start - 静默忽略', () => {
        watcher.notify('early.md', 'upsert');
        vi.advanceTimersByTime(10_000);
        expect(onUpsert).not.toHaveBeenCalled();
    });
});
