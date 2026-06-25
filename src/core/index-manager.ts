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
import { devLogger } from '../logging/dev-logger';

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
    private processing = false;
    private previousState: IndexStatus = { state: 'Idle' };

    constructor(private backend: IndexBackend) {}

    /** 启动期调用 — 全量扫一遍 + 状态 Init → Ready。 */
    async onLayoutReady(): Promise<{ indexed: number; errors: number } | null> {
        this.status$.set({ state: 'Init' });
        try {
            const result = await this.backend.fullReindex();
            this.status$.set({
                state: 'Ready',
                totalDocs: result.indexed,
                lastIndexTime: Date.now(),
            });
            return result;
        } catch (err) {
            this.status$.set({ state: 'Failed', reason: String(err) });
			devLogger.error('index', '全量索引失败', err);
            return null;
        }
    }

    /**
     * 入队增量事件。
     *
     * 关键路径:同 path 多次 enqueue 只保留最后一次(后写覆盖先写,Map.set)。
     * 入队后自动触发非阻塞消费(若未暂停且无正在处理的批次)。
     */
    enqueue(path: string, op: 'upsert' | 'delete', content?: string): void {
        this.queue.set(path, { op, content });
        if (this.paused) {
            this.status$.set({ state: 'Paused', pending: this.queue.size });
        } else {
            this.status$.set({ state: 'Queueing', pending: this.queue.size });
            // 关键路径:自动触发队列消费,不阻塞调用方(事件回调)。
            void this.scheduleFlush();
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
        if (this.queue.size > 0) {
            this.status$.set({ state: 'Queueing', pending: this.queue.size });
            void this.scheduleFlush();
        } else {
            this.status$.set(this.previousState);
        }
    }

    /** 重新索引 — 清队列 + 走全量。 */
    async reindex(): Promise<void> {
        this.queue.clear();
        await this.onLayoutReady();
    }

    /** 取出队首并处理。 */
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

    /** 把队列中所有项消费完。 */
    async flush(): Promise<void> {
        if (this.paused || this.processing) return;
        this.processing = true;
        try {
            while (this.queue.size > 0 && !this.paused) {
                await this.processNext();
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * 内部调度 — 防止并发消费。
     * 多次 enqueue 只会触发一次实际 flush(processing 标志去重)。
     */
    private async scheduleFlush(): Promise<void> {
        if (this.processing || this.paused) return;
        await this.flush();
    }

    private snapshotForResume(): void {
        // 修复:读真实状态而非 hardcode Ready,避免 paused 前非 Ready 时恢复错误。
        const current = get(this.status$);
        if (current.state === 'Ready' || current.state === 'Idle' || current.state === 'Failed') {
            this.previousState = current;
        } else {
            // 处理中暂停,恢复后回 Ready。
            this.previousState = { state: 'Ready', totalDocs: 0, lastIndexTime: Date.now() };
        }
    }
}
