/**
 * @file src/core/folder-watcher.ts
 * @description vault 事件去抖监听 — 5s 单文件去抖
 * @module core/folder-watcher
 *
 * 设计要点:
 * - 单文件去抖(5s):同 path 多次 modify 只触发 1 次,5s 后真触发
 * - delete 事件不去抖:用户删了东西希望立刻反映在索引上
 * - stop() 主动清掉所有 pending timer,避免插件卸载后悬挂
 */

export interface WatcherHandlers {
    onUpsert: (path: string) => void;
    onDelete: (path: string) => void;
}

export interface FolderWatcherOptions {
    debounceMs?: number;
}

interface PendingEntry {
    op: 'upsert' | 'delete';
    timer: ReturnType<typeof setTimeout>;
}

export class FolderWatcher {
    private debounceMs: number;
    private pending = new Map<string, PendingEntry>();
    private handlers: WatcherHandlers | null = null;
    private started = false;

    constructor(options: FolderWatcherOptions = {}) {
        this.debounceMs = options.debounceMs ?? 5000;
    }

    /** 启动监听。 */
    start(handlers: WatcherHandlers): void {
        this.handlers = handlers;
        this.started = true;
    }

    /**
     * 外部通知一个事件(由 Vault 适配器的事件订阅回调调用)。
     *
     * @param path - vault 相对路径。
     * @param op - 'upsert'(create/modify)或 'delete'。
     */
    notify(path: string, op: 'upsert' | 'delete'): void {
        if (!this.started || !this.handlers) return;

        if (op === 'delete') {
            // 关键路径:delete 不去抖,立刻触发;同时清掉该 path 的 pending upsert 计时器。
            this.cancelPending(path);
            this.handlers.onDelete(path);
            return;
        }

        // 关键路径:同 path 已有 timer,先清掉,后写覆盖先写。
        this.cancelPending(path);
        const timer = setTimeout(() => {
            this.pending.delete(path);
            this.handlers?.onUpsert(path);
        }, this.debounceMs);
        this.pending.set(path, { op, timer });
    }

    /** 停止 — 清空所有 pending。 */
    stop(): void {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
        }
        this.pending.clear();
        this.started = false;
        this.handlers = null;
    }

    private cancelPending(path: string): void {
        const existing = this.pending.get(path);
        if (existing) {
            clearTimeout(existing.timer);
            this.pending.delete(path);
        }
    }
}
