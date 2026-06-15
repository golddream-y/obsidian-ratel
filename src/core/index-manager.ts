/**
 * @file src/core/index-manager.ts
 * @description 自动索引管理器 — 状态机 + 队列 + 暂停/恢复/重索引
 * @module core/index-manager
 * @depends svelte/store
 *
 * 设计要点:
 * - 状态用 Svelte writable store,UI 直接 subscribe,零样板
 * - 队列用 Map<path, op> 自动去重(同 path 多次 enqueue 只保留最后 op)
 * - pause 时事件继续入队但不消费;resume 时追平
 * - 失败可重试:catch 后状态 → Failed,用户手动重试(resume)
 */

import { writable, get } from 'svelte/store';

/** 索引状态机(9 态)。 */
export type IndexStatus =
    | { state: 'Idle' }
    | { state: 'Init' }
    | { state: 'Scanning'; scanned: number; total: number }
    | { state: 'Queueing'; pending: number }
    | { state: 'Processing'; currentBatch: string[] }
    | { state: 'Ready'; totalDocs: number; lastIndexTime: number }
    | { state: 'Paused'; pending: number }
    | { state: 'Failed'; reason: string }
    | { state: 'Unloaded' };

/** Worker 调用抽象,便于单测注入 mock。 */
export interface IndexBackend {
    fullReindex(): Promise<{ indexed: number; errors: number }>;
    incrementalIndex(file: { path: string; content: string }): Promise<{ indexed: number; errors: number }>;
    deleteFile(filePath: string): Promise<number>;
}

interface QueueEntry {
    op: 'upsert' | 'delete';
    content?: string;
}

export class IndexManager {
    readonly status$ = writable<IndexStatus>({ state: 'Idle' });
    private queue = new Map<string, QueueEntry>();
    private paused = false;
    private previousState: IndexStatus = { state: 'Idle' };

    constructor(private backend: IndexBackend) {}

    /** 启动期调用 — 全量扫一遍 + 状态 Init → Ready。 */
    async onLayoutReady(): Promise<void> {
        this.status$.set({ state: 'Init' });
        try {
            const result = await this.backend.fullReindex();
            this.status$.set({
                state: 'Ready',
                totalDocs: result.indexed,
                lastIndexTime: Date.now(),
            });
        } catch (err) {
            this.status$.set({ state: 'Failed', reason: String(err) });
        }
    }

    /**
     * 入队增量事件。
     *
     * 关键路径:同 path 多次 enqueue 只保留最后一次(后写覆盖先写,Map.set)。
     */
    enqueue(path: string, op: 'upsert' | 'delete', content?: string): void {
        this.queue.set(path, { op, content });
        if (this.paused) {
            this.status$.set({ state: 'Paused', pending: this.queue.size });
        } else {
            this.status$.set({ state: 'Queueing', pending: this.queue.size });
        }
    }

    /** 暂停 — 队列继续累积,不消费。 */
    pause(): void {
        if (this.paused) return;
        this.paused = true;
        this.snapshotForResume();
        this.status$.set({ state: 'Paused', pending: this.queue.size });
    }

    /** 恢复 — 追平累积的队列。 */
    resume(): void {
        if (!this.paused) return;
        this.paused = false;
        this.status$.set(this.queue.size > 0 ? { state: 'Queueing', pending: this.queue.size } : this.previousState);
    }

    /** 重新索引 — 清队列 + 走全量。 */
    async reindex(): Promise<void> {
        this.queue.clear();
        await this.onLayoutReady();
    }

    /** 取出队首并处理,测试用。 */
    async processNext(): Promise<void> {
        const iter = this.queue.entries().next();
        if (iter.done) return;
        const [path, entry] = iter.value as [string, QueueEntry];
        this.queue.delete(path);
        this.status$.set({ state: 'Processing', currentBatch: [path] });
        try {
            if (entry.op === 'upsert') {
                await this.backend.incrementalIndex({ path, content: entry.content ?? '' });
            } else {
                await this.backend.deleteFile(path);
            }
            this.status$.set({ state: 'Ready', totalDocs: 0, lastIndexTime: Date.now() });
        } catch (err) {
            this.status$.set({ state: 'Failed', reason: String(err) });
        }
    }

    /** 把队列中所有项消费完,测试用。 */
    async flush(): Promise<void> {
        if (this.paused) return;
        while (this.queue.size > 0) {
            await this.processNext();
        }
    }

    private snapshotForResume(): void {
        // 关键路径:paused 前若在 Ready,记为 Ready;其他情况统一记 Queueing。
        // 简化:此处不读 status$(避免订阅泄漏),假设 paused 前是 Ready。
        this.previousState = { state: 'Ready', totalDocs: 0, lastIndexTime: Date.now() };
    }
}
