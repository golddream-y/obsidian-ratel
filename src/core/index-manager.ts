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

/** 索引状态机(10 态)。Diffing = smartReindex hash diff 阶段。 */
export type IndexStatus =
    | { state: 'Idle' }
    | { state: 'Init' }
    | { state: 'Diffing' }
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
    incrementalIndex(file: { path: string; content: string }): Promise<{ indexed: number; errors: number; chunkCount?: number }>;
    deleteFile(filePath: string): Promise<number>;
    // 关键路径:smartReindex 是可选方法,未实现时 onLayoutReady 回退到 fullReindex。
    smartReindex?(): Promise<{ indexed: number; errors: number; skipped: number }>;
    isIndexCreated?(): Promise<boolean>;
    listMarkdownFiles?(): Promise<Array<{ path: string; content: string }>>;
    // 关键路径:reindex 命令需清 .index/ + manifest 后全量(spec §4.4)。
    // 可选 — backend 未实现时 reindex 退化为 onLayoutReady(走 smartReindex hash diff)。
    dropIndex?(): Promise<void>;
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
    // 关键路径:reindex 时清 manifest 的回调,由 main.ts 注入(避免 core 层依赖 IndexManifest)。
    private onManifestReset: (() => Promise<void>) | null = null;

    constructor(private backend: IndexBackend) {}

    /**
     * 注入 manifest 清理回调(reindex 时调用)。
     *
     * 关键路径:IndexManager 不直接依赖 IndexManifest(core 层 purity),
     * 由 main.ts 注入清理逻辑:dropIndex + manifest.invalidate。
     */
    setManifestResetCallback(cb: () => Promise<void>): void {
        this.onManifestReset = cb;
    }

    /**
     * 启动期调用 — 优先走 smartReindex(hash diff),backend 未实现 smartReindex 时回退全量。
     *
     * 关键路径:
     * - smartReindex 内部处理所有情况:索引不存在 → 全量 + 写 manifest;存在 → hash diff(零 embed 热启动)
     * - onLayoutReady 只检查方法存在性(Truthiness),始终委托给 smartReindex,不感知索引是否存在
     * - backend 未提供 smartReindex → 回退 fullReindex(向后兼容,渐进迁移)
     * - smart 执行前状态 Diffing,执行后 Ready / 失败 Failed
     *
     * @returns 成功返回 {indexed, errors};失败返回 null 且状态置 Failed
     */
    async onLayoutReady(): Promise<{ indexed: number; errors: number } | null> {
        this.status$.set({ state: 'Init' });
        try {
            // 关键路径:优先 smart,backend 渐进迁移。
            // smartReindex 内部处理所有情况:索引不存在 → 全量 + 写 manifest;存在 → hash diff。
            if (this.backend.smartReindex && this.backend.isIndexCreated) {
                this.status$.set({ state: 'Diffing' });
                const result = await this.backend.smartReindex();
                this.status$.set({
                    state: 'Ready',
                    totalDocs: result.indexed + result.skipped,
                    lastIndexTime: Date.now(),
                });
                return { indexed: result.indexed, errors: result.errors };
            }
            // 回退:全量路径(backend 未实现 smartReindex)。
            const result = await this.backend.fullReindex();
            this.status$.set({
                state: 'Ready',
                totalDocs: result.indexed,
                lastIndexTime: Date.now(),
            });
            return result;
        } catch (err) {
            this.status$.set({ state: 'Failed', reason: String(err) });
            devLogger.error('index', '启动索引失败', err);
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

    /**
     * 重新索引 — 清队列 + 清 .index/ + 清 manifest + 走全量(spec §4.4)。
     *
     * 关键路径:用户手动 /reindex 想强制全量,必须绕过 smartReindex 的 hash diff。
     * 若不清 manifest,smartReindex 会跳过未变更文件,违反用户预期。
     * dropIndex 可选:backend 未实现时退化为 onLayoutReady(走 smartReindex)。
     */
    async reindex(): Promise<void> {
        this.queue.clear();
        // 关键路径:先清 .index/ 目录 + manifest,确保 onLayoutReady 走全量路径。
        if (this.backend.dropIndex) {
            try {
                await this.backend.dropIndex();
            } catch (err) {
                devLogger.error('index', 'reindex: dropIndex 失败,仍继续走 onLayoutReady', err);
            }
        }
        if (this.onManifestReset) {
            try {
                await this.onManifestReset();
            } catch (err) {
                devLogger.error('index', 'reindex: manifest 清理失败,仍继续', err);
            }
        }
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
