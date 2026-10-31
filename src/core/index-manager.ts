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
 * - 注入 T4 协调器后,扫描/事件/新鲜度/提交都由协调器持有:管理器只转发事件与展示状态,
 *   不再走「整批成功才存清单」的路径(清单提交由文件完成记录承担);未注入时保持既有语义。
 * - 状态展示区分总文件数、已提交数、待处理/失败数与当前阶段;新一轮 taskId 递增时旧进度不复用。
 */

import { writable, get } from 'svelte/store';
import { devLogger } from '../logging/dev-logger';
import { tNow } from '../i18n';
import type { IndexPhase } from './index-persistence-types';
import type { IndexTaskCounters } from './index-task-coordinator';

/** 索引状态机(10 态)。Diffing = smartReindex hash diff 阶段。 */
export type IndexStatus =
    | { state: 'Idle' }
    | { state: 'Init' }
    | { state: 'Diffing' }
    | { state: 'Scanning'; scanned: number; total: number; committed?: number; pending?: number; failed?: number; phase?: IndexPhase }
    | { state: 'Queueing'; pending: number; reverifying?: boolean; committed?: number; total?: number; failed?: number; phase?: IndexPhase }
    | { state: 'Processing'; currentBatch: string[] }
    | { state: 'Ready'; totalDocs: number; lastIndexTime: number; committedDocs?: number; totalFiles?: number; pendingDocs?: number; failedDocs?: number; phase?: IndexPhase }
    | { state: 'Paused'; pending: number }
    | { state: 'Failed'; reason: string }
    | { state: 'Unloaded' };

/** 已提交索引的只读摘要，不包含本次扫描或嵌入统计。 */
export interface CommittedIndexState {
    totalDocs: number;
    lastIndexTime: number;
}

/**
 * 文件完成记录的最小结构视图 — 与 `PersistentIndexBackend` 的记录视图结构兼容。
 *
 * 关键路径:可见性判定与部分可用性必须读记录,不能只凭全量清单布尔值;
 * `null` 表示不可判定(记录端口未装配),与空集是两件不同的事。
 */
export interface SearchableFileRecord {
    /** vault 规范化相对路径。 */
    path: string;
    /** 版本状态;tombstone 不在可检索集内。 */
    state: 'present' | 'deleted';
    /** 同路径单调递增版本号。 */
    revision: number;
    /** 输入内容 hash;删除记录为 null。 */
    inputHash: string | null;
    /** 块数量。 */
    chunkCount: number;
}

/** 可检索文件记录视图。 */
export interface SearchableFileRecords {
    /** 可检索文件总数。 */
    total: number;
    /** 可检索文件记录。 */
    records: ReadonlyArray<SearchableFileRecord>;
}

/**
 * 索引任务协调器端口 — 由 `IndexTaskCoordinator` 结构上满足。
 *
 * 关键路径:注入后管理器不再直接驱动扫描与提交;事件、新鲜度、队列与终态判据都由协调器持有。
 */
export interface IndexTaskCoordinatorPort {
    /** 启动一轮任务(装配监听 → 枚举核对 → 队列收敛)。 */
    start(): Promise<IndexTaskCounters>;
    /** 当前计数快照。 */
    counters(): IndexTaskCounters;
    /** 记录一次路径事件。 */
    notify(path: string, op: 'upsert' | 'delete'): void;
    /** 收敛队列。 */
    drain(): Promise<void>;
    /** 本轮是否已可标记 ready。 */
    isReady(): boolean;
    /** 暂停队列消费。 */
    pause(): void;
    /** 恢复队列消费与失败重试。 */
    resume(): void;
    /** 卸载并退订事件。 */
    destroy(): void;
}

/** Worker 调用抽象,便于单测注入 mock。 */
export interface IndexBackend {
    fullReindex(): Promise<{ indexed: number; errors: number }>;
    incrementalIndex(file: { path: string; content: string }): Promise<{ indexed: number; errors: number; chunkCount?: number }>;
    deleteFile(filePath: string): Promise<number>;
    // 关键路径:smartReindex 是可选方法,未实现时 onLayoutReady 回退到 fullReindex。
    smartReindex?(): Promise<{ indexed: number; errors: number; skipped: number }>;
    isIndexCreated?(): Promise<boolean>;
    readCommittedState?(): Promise<CommittedIndexState | null>;
    /** 全库持久化凭据是否完整；缺少凭据的增量写入不能宣告全库Ready。 */
    isIndexComplete?(): Promise<boolean>;
    /** 可检索文件记录视图；返回 null 表示不可判定（记录端口未装配），不能当作空集。 */
    searchableFileRecords?(): Promise<SearchableFileRecords | null>;
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
    private scanFailed = false;
    private previousState: IndexStatus = { state: 'Idle' };
    /** 最近一次已发布状态对应的协调器任务标识 — 旧任务的进度不得污染新任务。 */
    private lastTaskId = 0;
    // 兼容额外清单清理器；实际持久化 backend 的 dropIndex 已清理同目录元数据。
    private onManifestReset: (() => Promise<void>) | null = null;

    /**
     * @param backend - 索引后端(未注入协调器时由本类驱动扫描与提交)。
     * @param coordinator - 可选的任务协调器;注入后扫描/事件/新鲜度/终态由它持有。
     */
    constructor(private backend: IndexBackend, private coordinator?: IndexTaskCoordinatorPort) {}

    /** 是否接入了任务协调器。 */
    hasCoordinator(): boolean {
        return this.coordinator !== undefined;
    }

    /**
     * 可检索文件记录视图 — 后端口未实现时返回 null(不可判定,不是空集)。
     */
    searchableFileRecords(): Promise<SearchableFileRecords | null> {
        return this.backend.searchableFileRecords?.() ?? Promise.resolve(null);
    }

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
        // 关键路径:注入协调器后不再调用智能/全量重扫入口 —— 文件级提交由协调器与文件记录承担。
        const task = this.serialize(() => this.coordinator ? this.runCoordinator() : this.scan());
        this.startup = task;
        void task.finally(() => {
            if (this.startup === task) this.startup = null;
            if (!this.paused && !this.unloaded && !this.failed) void this.scheduleFlush();
        });
        return task;
    }

    /** 关闭自动扫描时只读恢复已有成功状态；缺少成功凭据时保持Idle。 */
    restoreCommittedState(): Promise<void> {
        return this.serialize(async () => {
            if (this.unloaded || this.failed) return;
            try {
                const committed = await this.backend.readCommittedState?.();
                if (this.unloaded) return;
                this.status$.set(committed ? { state: 'Ready', ...committed } : { state: 'Idle' });
            } catch (err) {
                this.failed = true;
                this.scanFailed = true;
                if (!this.unloaded) this.status$.set({ state: 'Failed', reason: String(err) });
                devLogger.error('index', '读取已提交索引状态失败', err);
            }
        });
    }

    /**
     * 协调器驱动的一轮任务 — 启动扫描、展示阶段与计数,不直接提交清单。
     *
     * 关键路径:
     * - 本方法不调用 `smartReindex` / `fullReindex`,因此不存在「整批成功才存清单」这条路径;
     * - `taskId` 递增时旧任务的进度不再复用(重新核对);
     * - `failures > 0` 时保持 Failed,单文件成功不得伪装全库完成。
     */
    private async runCoordinator(): Promise<{ indexed: number; errors: number } | null> {
        if (this.unloaded) return null;
        const coordinator = this.coordinator;
        if (!coordinator) return null;
        this.failed = false;
        this.status$.set({
            state: 'Scanning', scanned: 0, total: 0, committed: 0, pending: 0, failed: 0, phase: 'scanning',
        });
        try {
            const counters = await coordinator.start();
            if (this.unloaded) return null;
            this.scanFailed = counters.failures > 0 || counters.phase === 'failed';
            this.failed = this.scanFailed;
            // 修复:先发布再更新 `lastTaskId` —— 反序会让 `publishCoordinatorStatus` 里的
            // `counters.taskId !== this.lastTaskId` 在本轮恒假,新一轮永远不显示「重新核对中」。
            this.publishCoordinatorStatus(counters);
            this.lastTaskId = counters.taskId;
            return { indexed: counters.committedThisRound, errors: counters.failures };
        }
        catch (err) {
            this.failed = true;
            this.scanFailed = true;
            if (!this.unloaded) this.status$.set({ state: 'Failed', reason: String(err) });
            devLogger.error('index', '协调器启动索引失败', err);
            return null;
        }
    }

    /**
     * 按协调器计数发布状态 — 区分总文件数、已提交数、待处理数与当前阶段。
     *
     * 关键路径:未 ready 时不发布 Ready;阶段为 partial-failure 时保持 Failed 并沿用既有文案键。
     */
    private publishCoordinatorStatus(counters: IndexTaskCounters): void {
        if (this.unloaded) return;
        const pending = counters.queued + counters.active + counters.pendingTransactions;
        if (this.paused) {
            this.status$.set({ state: 'Paused', pending });
            return;
        }
        if (counters.phase === 'ready' && counters.failures === 0) {
            this.status$.set({
                state: 'Ready',
                totalDocs: counters.committed,
                lastIndexTime: Date.now(),
                committedDocs: counters.committed,
                totalFiles: counters.total,
                pendingDocs: 0,
                failedDocs: 0,
                phase: counters.phase,
            });
            return;
        }
        if (counters.failures > 0) {
            this.status$.set({ state: 'Failed', reason: tNow('notice.indexPartialFailure', { count: counters.failures }) });
            return;
        }
        if (!counters.scanComplete) {
            this.status$.set({
                state: 'Scanning',
                scanned: counters.committed,
                total: counters.total,
                committed: counters.committed,
                pending,
                failed: counters.failures,
                phase: counters.phase,
            });
            return;
        }
        // 关键路径:扫描已结束但队列/事务未收敛 → 明确为「重新核对中」,不沿用旧任务的完成统计。
        // `reverifying` 有两个独立来源:本轮 taskId 尚未记入 `lastTaskId`(新一轮),
        // 或本轮已真正写入过完成记录;任一成立都必须显示重新核对中。
        this.status$.set({
            state: 'Queueing',
            pending,
            reverifying: counters.taskId !== this.lastTaskId || counters.committedThisRound > 0,
            committed: counters.committed,
            total: counters.total,
            failed: counters.failures,
            phase: counters.phase,
        });
    }

    /** 待处理量口径 — 协调器接入时读协调器计数,否则读本地队列。 */
    private pendingCount(): number {
        if (!this.coordinator) return this.queue.size;
        const counters = this.coordinator.counters();
        return counters.queued + counters.active + counters.pendingTransactions;
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
            this.scanFailed = false;
            if (!this.unloaded) this.status$.set({
                state: 'Ready',
                totalDocs: result.indexed + (result.skipped ?? 0),
                lastIndexTime: Date.now(),
            });
            return { indexed: result.indexed, errors: result.errors };
        } catch (err) {
            this.failed = true;
            this.scanFailed = true;
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
        const coordinator = this.coordinator;
        if (coordinator) {
            // 关键路径:事件内容不进入协调器 —— 它在读取/推理/提交前后自行核对磁盘内容,
            // 因此「事件内容早于当前 stat」不会把旧快照写成最新版。
            coordinator.notify(path, op);
            const counters = coordinator.counters();
            if (this.paused) this.status$.set({ state: 'Paused', pending: this.pendingCount() });
            else this.publishCoordinatorStatus(counters);
            return;
        }
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
        this.coordinator?.pause();
        this.status$.set({ state: 'Paused', pending: this.pendingCount() });
    }

    /** 恢复 — 追平累积的队列。 */
    resume(): void {
        if (this.unloaded || (!this.paused && !this.failed)) return;
        this.paused = false;
        const coordinator = this.coordinator;
        if (coordinator) {
            coordinator.resume();
            const counters = coordinator.counters();
            if (this.failed || this.scanFailed || counters.queued > 0 || counters.failures > 0 || !coordinator.isReady()) {
                // 关键路径:失败或仍有待处理项 → 重新核对一轮;新一轮 taskId 递增,旧进度不复用。
                this.failed = false;
                this.scanFailed = false;
                const startup = this.startup;
                void Promise.resolve(startup).then(() => {
                    if (!this.unloaded) return this.onLayoutReady();
                    return null;
                });
                return;
            }
            this.publishCoordinatorStatus(counters);
            return;
        }
        if (this.scanFailed) {
            // 修复:扫描失败意味着全库尚未核实；无关文件的增量成功不能解除该失败。
            // 等待上一轮启动完成，避免复用刚刚失败的 startup Promise 而漏掉重扫。
            void Promise.resolve(this.startup).then(() => {
                if (!this.unloaded) return this.onLayoutReady();
                return null;
            });
            return;
        }
        if (this.queue.size > 0) {
            // 关键路径:显式恢复有待处理条目时才解除失败锁存，重试成功后才能Ready。
            this.failed = false;
            this.status$.set({ state: 'Queueing', pending: this.queue.size });
            void this.scheduleFlush();
        } else if (get(this.status$).state === 'Paused') {
            // 修复:暂停期间扫描可能已成功或失败；不能用旧快照覆盖真实终态。
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
                await (this.coordinator ? this.runCoordinator() : this.scan(true));
            } catch (err) {
                this.failed = true;
                this.scanFailed = true;
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

    /**
     * 取出队首并处理 — 仅在未接入协调器时可达。
     *
     * 关键路径:协调器接入后本地队列始终为空,这里不做任何提交动作,避免出现第二条提交路径。
     */
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

    /**
     * 把队列中所有项消费完。
     *
     * 关键路径:协调器分支同样挂到 `this.tail` —— 否则在途 `journal.commit`(由 `drain()` 驱动)
     * 会与 `reindex()` 的 `dropIndex()`/重扫交错,清库可能抹掉尚未落盘的提交。
     * 两个入口的「失败」短路语义保持一致:`scheduleFlush()` 与本方法都检查 `this.failed`。
     */
    flush(): Promise<void> {
        if (this.coordinator) {
            if (this.paused || this.unloaded || this.failed) return Promise.resolve();
            if (this.flushing) return this.flushing;
            const task = this.serialize(() => this.coordinator!.drain());
            this.flushing = task;
            void task.finally(() => { if (this.flushing === task) this.flushing = null; });
            return task;
        }
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
        this.coordinator?.destroy();
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
        // 修复:运行状态也原样保存；暂停和恢复都不能凭空制造成功状态。
        this.previousState = get(this.status$);
    }
}
