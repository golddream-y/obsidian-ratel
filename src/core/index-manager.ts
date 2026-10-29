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
import { tNow } from '../i18n';

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
    /** 全库持久化凭据是否完整；缺少凭据的增量写入不能宣告全库Ready。 */
    isIndexComplete?(): Promise<boolean>;
    listMarkdownFiles?(): Promise<Array<{ path: string; content: string }>>;
    // 关键路径:reindex 命令需清 .index/ + manifest 后全量(spec §4.4)。
    // 可选 — backend 未实现时仍直接全量扫描。
    dropIndex?(): Promise<void>;
}

interface QueueEntry {
    op: 'upsert' | 'delete';
    content?: string;
}

/**
 * 串行协调启动扫描、手动重建和增量队列；失败锁存到显式恢复，卸载后不开始新任务。
 */
export class IndexManager {
    readonly status$ = writable<IndexStatus>({ state: 'Idle' });
    private queue = new Map<string, QueueEntry>();
    private paused = false;
    private flushing: Promise<void> | null = null;
    private tail: Promise<unknown> = Promise.resolve();
    private startup: Promise<{ indexed: number; errors: number } | null> | null = null;
    private rebuilding: Promise<void> | null = null;
    private unloaded = false;
    private failed = false;
    private previousState: IndexStatus = { state: 'Idle' };
    // 兼容额外清单清理器；实际持久化 backend 的 dropIndex 已清理同目录元数据。
    private onManifestReset: (() => Promise<void>) | null = null;

    constructor(private backend: IndexBackend) {}

    /**
     * 注入 manifest 清理回调(reindex 时调用)。
     *
     * 关键路径:IndexManager 不直接依赖 IndexManifest(core 层 purity),
     * 供需要额外清理清单的 backend 装配层注入；抛错会停止重建。
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
    onLayoutReady(): Promise<{ indexed: number; errors: number } | null> {
        if (this.startup) return this.startup;
        const task = this.serialize(() => this.scan());
        this.startup = task;
        void task.finally(() => {
            if (this.startup === task) this.startup = null;
            if (!this.paused && !this.unloaded && !this.failed) void this.scheduleFlush();
        });
        return task;
    }

    private async scan(forceFull = false): Promise<{ indexed: number; errors: number } | null> {
        if (this.unloaded) return null;
        this.failed = false;
        this.status$.set({ state: 'Init' });
        try {
            const smart = !forceFull && !!this.backend.smartReindex;
            if (smart) this.status$.set({ state: 'Diffing' });
            const result: { indexed: number; errors: number; skipped?: number } = smart
                ? await this.backend.smartReindex!() : await this.backend.fullReindex();
            if (result.errors > 0) throw new Error(tNow('notice.indexPartialFailure', { count: result.errors }));
            if (!this.unloaded) this.status$.set({
                state: 'Ready',
                totalDocs: result.indexed + (result.skipped ?? 0),
                lastIndexTime: Date.now(),
            });
            return { indexed: result.indexed, errors: result.errors };
        } catch (err) {
            this.failed = true;
            if (!this.unloaded) this.status$.set({ state: 'Failed', reason: String(err) });
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
        if (this.unloaded) return;
        this.queue.set(path, { op, content });
        if (this.failed) return;
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
        if (!this.paused && !this.failed) return;
        this.paused = false;
        this.failed = false;
        if (this.queue.size > 0) {
            this.status$.set({ state: 'Queueing', pending: this.queue.size });
            void this.scheduleFlush();
        } else {
            this.status$.set(this.previousState);
        }
    }

    /**
     * 重新索引 — 等待当前操作、清库并全量扫描，保留期间的文件事件。
     *
     * 关键路径:用户手动 /reindex 想强制全量,必须绕过 smartReindex 的 hash diff。
     * 若不清 manifest,smartReindex 会跳过未变更文件,违反用户预期。
     * 清理失败立即停止；backend 未提供清理时仍执行全量。
     */
    reindex(): Promise<void> {
        if (this.rebuilding) return this.rebuilding;
        const task = this.serialize(async () => {
            if (this.unloaded) return;
            try {
                // 修复:不清事件队列；扫描期间的最新变动必须在重建后追平。
                await this.backend.dropIndex?.();
                await this.onManifestReset?.();
                await this.scan(true);
            } catch (err) {
                this.failed = true;
                if (!this.unloaded) this.status$.set({ state: 'Failed', reason: String(err) });
                devLogger.error('index', '重新索引失败', err);
            }
        });
        this.rebuilding = task;
        void task.finally(() => {
            if (this.rebuilding === task) this.rebuilding = null;
            if (!this.paused && !this.unloaded && !this.failed) void this.scheduleFlush();
        });
        return task;
    }

    /** 取出队首并处理。 */
    private async processNext(): Promise<void> {
        const iter = this.queue.entries().next();
        if (iter.done) return;
        const [path, entry] = iter.value;
        this.queue.delete(path);
        this.status$.set({ state: 'Processing', currentBatch: [path] });
        try {
            if (entry.op === 'upsert') {
                const result = await this.backend.incrementalIndex({ path, content: entry.content ?? '' });
                if (result.errors > 0) throw new Error(tNow('notice.indexPartialFailure', { count: result.errors }));
            } else {
                await this.backend.deleteFile(path);
            }
            const complete = await this.backend.isIndexComplete?.() ?? true;
            if (!this.unloaded) this.status$.set(complete
                ? { state: 'Ready', totalDocs: 0, lastIndexTime: Date.now() }
                : { state: 'Idle' });
        } catch (err) {
            this.failed = true;
            if (!this.queue.has(path)) this.queue.set(path, entry);
            if (!this.unloaded) this.status$.set({ state: 'Failed', reason: String(err) });
        }
    }

    /** 把队列中所有项消费完。 */
    flush(): Promise<void> {
        if (this.flushing) return this.flushing;
        if (this.paused || this.unloaded || this.failed) return Promise.resolve();
        const task = this.serialize(async () => {
            while (this.queue.size > 0 && !this.paused && !this.unloaded && !this.failed) {
                await this.processNext();
            }
        });
        this.flushing = task;
        void task.finally(() => { if (this.flushing === task) this.flushing = null; });
        return task;
    }

    /** 卸载后不再开始新写入；正在运行的底层任务由 WorkerManager 负责清理等待。 */
    destroy(): void {
        this.unloaded = true;
        this.queue.clear();
        this.status$.set({ state: 'Unloaded' });
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const task = this.tail.then(operation);
        this.tail = task.catch(() => undefined);
        return task;
    }

    /**
     * 内部调度 — 防止并发消费。
     * 多次 enqueue 复用正在等待或执行的 flush。
     */
    private async scheduleFlush(): Promise<void> {
        if (this.paused || this.unloaded || this.failed) return;
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
