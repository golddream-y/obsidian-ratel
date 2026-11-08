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
    | { state: 'Scanning'; scanned: number; total: number; committed?: number; pending?: number; failed?: number; phase?: IndexPhase; secondsPerBlock?: number; restoring?: boolean; restoredFiles?: number; restoredTotal?: number }
    | { state: 'Queueing'; pending: number; reverifying?: boolean; restoring?: boolean; restoredFiles?: number; restoredTotal?: number; committed?: number; total?: number; failed?: number; phase?: IndexPhase; secondsPerBlock?: number }
    | { state: 'Processing'; currentBatch: string[]; restoring?: boolean; restoredFiles?: number; restoredTotal?: number }
    | { state: 'Ready'; totalDocs: number; lastIndexTime: number; committedDocs?: number; totalFiles?: number; pendingDocs?: number; failedDocs?: number; phase?: IndexPhase }
    | { state: 'Paused'; pending: number }
    /**
     * 失败态 — `reason` 是开发向说明,`errorCode` 是**稳定错误码**(存在时)。
     *
     * 关键路径(T7/I1):上屏文案必须能按码查表。`String(err)` 早已丢掉错误对象,
     * 因此失败路径必须在这里把码留下来,否则 `index-directory-not-owned`/`drop-refused`/
     * `owner-not-writable` 等新码只能落成 `error.index.unknown` + 开发向 message。
     */
    | { state: 'Failed'; reason: string; errorCode?: string; committed?: number; total?: number; pending?: number; failed?: number; phase?: IndexPhase; secondsPerBlock?: number }
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
    /**
     * 取消在途处理 — 先撤销在途可取消的调用,再停止调度新文件(T5 的顺序契约)。
     *
     * 关键路径:引入协调器后「暂停」不再只是停止消费队列 —— 在途的推理/提交必须被撤销,
     * 否则用户以为停了,后台仍在写盘。
     */
    abortActive(reason?: string): void;
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
    /** 仅采样展示计数，不产生任务活动，也不延长停滞预算。 */
    private coordinatorProgressTimer: ReturnType<typeof globalThis.setInterval> | null = null;
    /** 上一次已发布的进度签名 — 计数未变时不再写 store。 */
    private lastCoordinatorSignature: string | null = null;
    /**
     * 速率采样窗口 — 仅记录「发布时」的 (时间, 已提交篇数) 对。
     *
     * 关键路径:速率必须由真实完成计数推导,不能用定时器次数或估算篇数冒充;
     * 窗口只保留最近 10 秒,避免整轮平均掩盖当前速度。
     */
    private rateSamples: Array<{ at: number; committed: number }> = [];
    /** 速率样本上限 — 按样本数保留,不按固定时长淘汰(见 `sampleSecondsPerBlock`)。 */
    private static readonly RATE_MAX_SAMPLES = 8;
    /** 超过该时长没有新的完成计数即视为停滞,不再显示速率。 */
    private static readonly RATE_STALE_MS = 20_000;
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
                if (!this.unloaded) this.status$.set(this.failedStatus(err));
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
        // 修复：start 等待整轮收敛，不能等它返回才发布进度，否则长索引始终显示扫描中 0/0。
        // 关键路径:进度采样只在计数真的变化时发布 —— 每 250ms 无条件写 store 会让
        // 状态栏/抽屉以 4Hz 重渲染,索引期间反而制造主线程卡顿。
        this.lastCoordinatorSignature = null;
        this.coordinatorProgressTimer = globalThis.setInterval(() => {
            if (this.unloaded) return;
            const counters = coordinator.counters();
            const signature = [
                counters.taskId, counters.phase, counters.total, counters.committed,
                counters.pendingFiles ?? 0, counters.failures, counters.active,
                // 关键路径:恢复窗口到期本身要触发一次发布。
                // 若签名不含恢复态,窗口到期后 counters 其它字段不变,定时器直接 return,
                // UI 就永远停在「正在恢复已索引进度」——这正是上一版的残留症状。
                counters.restoring === true, counters.restoredFiles ?? 0,
            ].join('|');
            if (signature === this.lastCoordinatorSignature) return;
            this.lastCoordinatorSignature = signature;
            this.publishCoordinatorStatus(counters);
          // 关键路径:GPU 推理后单篇耗时可低至 0.3 秒,500ms 采样会让计数一次跳两篇;
          // 250ms 既能逐篇上屏,又不会把重绘压力抬到不可接受。
        }, 250);
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
            if (!this.unloaded) this.status$.set(this.failedStatus(err));
            devLogger.error('index', '协调器启动索引失败', err);
            return null;
        } finally {
            this.stopCoordinatorProgress();
        }
    }

    /** 整轮结束或卸载时停止展示采样，避免悬挂任务保留定时器。 */
    private stopCoordinatorProgress(): void {
        if (this.coordinatorProgressTimer === null) return;
        globalThis.clearInterval(this.coordinatorProgressTimer);
        this.coordinatorProgressTimer = null;
    }

    /**
     * 按协调器计数发布状态 — 区分总文件数、已提交数、待处理数与当前阶段。
     *
     * 关键路径:未 ready 时不发布 Ready;阶段为 partial-failure 时保持 Failed 并沿用既有文案键。
     */
    /** 由真实完成计数算当前速率(篇/秒);样本不足或窗口内零进展时返回 undefined。 */
    private sampleSecondsPerBlock(counters: IndexTaskCounters): number | undefined {
        const now = Date.now();
        const last = this.rateSamples[this.rateSamples.length - 1];
        // 关键路径:同一 committed 不重复入窗,否则重复发布会把速率压到 0。
        // 关键路径(2026-11-06):速率必须基于**本轮真正写入**的篇数,不能基于「已核实」——
        // 重载后大量未变更笔记按完成记录秒跳过,用核实数会算出 40+ 篇/秒这种假速度。
        // 关键路径:按**块**计量 —— 按篇会被超大文档(最大 215 块)拉偏,
        // 生产库平均 14 块/篇,同一速度在两种口径下能差一个数量级。
        const written = counters.committedBlocksThisRound ?? 0;
        if (last === undefined || last.committed !== written) {
            this.rateSamples.push({ at: now, committed: written });
            if (this.rateSamples.length > IndexManager.RATE_MAX_SAMPLES) {
                this.rateSamples.splice(0, this.rateSamples.length - IndexManager.RATE_MAX_SAMPLES);
            }
        }
        const newest = this.rateSamples[this.rateSamples.length - 1];
        if (newest === undefined) return undefined;
        // 关键路径:停滞后不显示速率,避免"卡住了还显示 0.4 篇/秒"的误导。
        if (now - newest.at > IndexManager.RATE_STALE_MS) return undefined;
        // 关键路径(2026-11-06):此前用「最近 10 秒窗口 + 至少两个样本」。
        // 大库一批常超过 10 秒,上一个样本总被淘汰,窗口恒只剩 1 个 → 永不显示速率。
        // 改为按样本数保留(最多 8 个),跨多次发布计算;样本不足两个才返回 undefined。
        if (this.rateSamples.length < 2) return undefined;
        const first = this.rateSamples[0]!;
        const elapsedMs = newest.at - first.at;
        const delta = newest.committed - first.committed;
        // 窗口内没有真正写入(只是在跳过未变更文件)时不显示速率。
        if (elapsedMs < 1000 || delta <= 0) return undefined;
        // 关键路径(2026-11-06):对外展示「多少秒一篇」而不是「篇/秒」——
        // 索引通常几秒到几十秒一篇,换算成速率会得到 0.1 这类没有直观意义的小数。
        const secondsPerBlock = elapsedMs / (delta * 1000);
        // 秒数越大越该给小数位:≥10 取整,≥1 保留一位,更快的保留两位。
        if (secondsPerBlock >= 10) return Math.round(secondsPerBlock);
        if (secondsPerBlock >= 1) return Math.round(secondsPerBlock * 10) / 10;
        return Math.round(secondsPerBlock * 100) / 100;
    }

    private publishCoordinatorStatus(counters: IndexTaskCounters): void {
        if (this.unloaded) return;
        // 关键路径:对外是「秒/块」,沿用 rate 字段名会让人误读成速率,统一改名为 secondsPerBlock。
        const secondsPerBlock = this.sampleSecondsPerBlock(counters);
        // 展示按唯一文件计数；调度与 canMarkReady 仍保留原始队列/事务口径。
        const pending = counters.pendingFiles ?? Math.max(0, counters.total - counters.committed - counters.failures);
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
            this.status$.set({ state: 'Failed', reason: tNow('notice.indexPartialFailure', { count: counters.failures }),
                committed: counters.committed, total: counters.total, pending, failed: counters.failures, phase: counters.phase, secondsPerBlock });
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
                phase: counters.phase, secondsPerBlock,
                restoring: counters.restoring,
                restoredFiles: counters.restoredFiles,
                restoredTotal: counters.restoredTotal,
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
            // 关键路径:恢复阶段单独透传,让 UI 显示「正在恢复已索引进度」而非低值进度。
            restoring: counters.restoring,
            restoredFiles: counters.restoredFiles,
            restoredTotal: counters.restoredTotal,
            committed: counters.committed,
            total: counters.total,
            failed: counters.failures,
            phase: counters.phase, secondsPerBlock,
        });
    }

    /** 待处理量口径 — 协调器接入时读协调器计数,否则读本地队列。 */
    private pendingCount(): number {
        if (!this.coordinator) return this.queue.size;
        const counters = this.coordinator.counters();
        return counters.pendingFiles ?? Math.max(0, counters.total - counters.committed - counters.failures);
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
            if (!this.unloaded) this.status$.set(this.failedStatus(err));
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

    /** 暂停 — 队列继续累积,不消费;在途调用先被撤销(T5/I6 的顺序契约)。 */
    pause(): void {
        if (this.paused) return;
        this.paused = true;
        this.snapshotForResume();
        // 关键路径:顺序必须是「先撤销在途调用、再停止调度新文件」—— 反序会留下一个
        // 「已停止调度但调用仍持证书」的窗口。协调器的 `abortActive` 自带置暂停,`pause()` 幂等。
        this.coordinator?.abortActive();
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
     *
     * 关键路径(代际装配后的语义变化):注入协调器时**不再清库** —— 清库会连带抹掉
     * 当前代际的向量与日志凭据,等于静默丢弃当前有效索引(spec 明确禁止);重建改为
     * 「撤销在途调用 → 重新跑一轮逐文件核对」,每个文件的替换仍由同一 owner/代际流程
     * 在单文件事务里完成,失败只影响该文件,已有版本保持可用。
     * 未注入协调器时保持旧语义(清库 + 全量),该分支在生产装配下已不可达。
     */
    reindex(): Promise<void> {
        if (this.rebuilding) return this.rebuilding;
        const task = this.serialize(async () => {
            if (this.unloaded) return;
            try {
                // 修复:不清事件队列；扫描期间的最新变动必须在重建后追平。
                const coordinator = this.coordinator;
                if (coordinator) {
                    // 关键路径:理由只进开发日志,不是用户可见字符串(文案归 i18n 任务)。
                    coordinator.abortActive('用户手动重建索引');
                    coordinator.resume();
                }
                else {
                    await this.backend.dropIndex?.();
                }
                await this.onManifestReset?.();
                await (coordinator ? this.runCoordinator() : this.scan(true));
            } catch (err) {
                this.failed = true;
                this.scanFailed = true;
                if (!this.unloaded) this.status$.set(this.failedStatus(err));
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
            if (!this.unloaded) this.status$.set(this.failedStatus(err));
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
        this.stopCoordinatorProgress();
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
     * 构造失败状态 — 保留错误的稳定码,让上屏文案能按码表映射(T7/I1)。
     *
     * 关键路径:`reason` 仍是开发向说明(日志/诊断用);`errorCode` 只在错误对象确实带字符串码时
     * 出现 —— 没有码的对象保持既有语义,不伪造一个码。
     *
     * @param error - 捕获到的错误。
     * @param reason - 覆盖用的说明文案(已本地化时传入,例如部分失败计数)。
     * @returns 失败状态。
     */
    private failedStatus(error: unknown, reason?: string): IndexStatus {
        const code = errorCodeOf(error);
        return {
            state: 'Failed',
            reason: reason ?? String(error),
            ...(code === undefined ? {} : { errorCode: code }),
        };
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

/**
 * 读取错误的稳定码 — 没有字符串码时为 undefined。
 *
 * 关键路径:本模块不能依赖 `feedback-controller`(反向依赖会成环),因此这里保留一份最小实现;
 * 它只回答「错误对象带没带码」,不参与文案映射。
 *
 * @param error - 任意捕获到的错误。
 * @returns 稳定错误码;不存在时为 undefined。
 */
function errorCodeOf(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
}
