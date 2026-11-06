/**
 * @file src/core/index-task-coordinator.ts
 * @description 流式扫描、按路径合并的变更队列与文件新鲜度核对
 * @module core/index-task-coordinator
 * @depends core/index-persistence-types, core/index-search-visibility(仅类型)
 *
 * 设计要点:
 * - 事件监听在首次枚举之前装配:枚举与监听之间的空隙由「扫描结束后逐文件核对 + 队列收敛」覆盖。
 * - 每个路径维护单调递增的事件序号;队列按路径合并(同路径多次事件只保留最新),序号继续增长。
 * - 枚举、读取、hash 与调度走有界队列:扫描核对并发上限固定,同一时刻只有一个文件在准备/提交,
 *   不为吞吐擅自并发写入;启动核对的开销随文件数增长,不承诺常数时间。
 * - 队列上界只丢弃「入队动作」,不丢弃路径:被丢弃的路径记入 `overflowedPaths`,队列出现空位后由收敛
 *   循环重新入队;回收完成前它们计入 `queued`,`isReady()` 与阶段判据一律不成立(溢出不得伪装成 ready)。
 * - 初始扫描只用轻量路径列表 + 逐文件内容,不构造全库正文数组。
 * - 「读取前后、推理后与提交前」三个检查点是同一组判据(事件序号 + 配置指纹 + 内容 hash),读取次数不同:
 *   「读取前」= 读取前捕获 `sequenceBefore` 写进快照;「读取后」只比对内存中的序号与配置(零额外读盘);
 *   「推理后」与「提交前」再各读一次文件核对 hash。读取期间到达的事件必被读取后检查点发现,
 *   因此不需要为「读取前」单独再读一次文件,语义与计划原文等价而不放大读盘次数。
 *   提交后若仍有新事件则保留队列项,只有本次输入 hash 完成,绝不清空后来事件。
 * - 读失败区分「文件已删除」与「无法读取」:后者按失败上报并保留队列项,绝不当成空文件提交;
 *   失败按路径记账 —— 同一路径后续成功处理即清除该路径的失败,不吃掉其它路径的失败,也不靠显式恢复假装成功。
 * - 重试预算收敛:处理失败用尽 `maxReadAttempts` 时保留队列项但不再自动重试;此后**任何**成功处理、
 *   新事件或新一轮 `start()` 都必须清除该标记,否则同一实例内 `queued` 永远非零、`ready` 永久不可达。
 * - 普通修改先标记 `known-stale`(检索立即过滤旧版本);删除、排除、损坏立即 deny;
 *   路径隔离/不可用与代际隔离直接消费日志的只读信号(`listPathStates` / `isGenerationQuarantined` /
 *   `listTombstones`),被隔离路径在本模块口径下也是 `corrupt`(deny),不新增日志写入口。
 * - 记忆有界:`sequenceByPath` / `knownPaths` / `freshness` 在每轮收敛后按「本轮枚举 + 仍有队列项/
 *   未决事务/已核实状态」回收;`total` 口径是「本轮已知文件数」,不是历史出现过的路径数。
 *
 * 归属边界:活动/停滞/取消(T5)与状态文案/i18n(T7)不在本模块;本模块只提供阶段、计数与终态判据。
 */

import type { FileCommit, IndexPhase, IndexActivity, EmbedOptions } from './index-persistence-types';
import type { BlockedPathState, FileFreshness } from './index-search-visibility';
import { assertSafeRecordPath } from './index-persistence-types';
import { isEmbedAbortError } from '../ports/embedding';
import { devLogger } from '../logging/dev-logger';
import { sha256 } from '../utils/hash';

// ==================== 公共契约 ====================

/** 路径事件操作。 */
export const COORDINATOR_EVENT_OPS = ['upsert', 'delete'] as const;

/** 路径事件操作。 */
export type CoordinatorEventOp = (typeof COORDINATOR_EVENT_OPS)[number];

/** 输入过期原因 — 与 {@link VerifyResult} 与重排日志共用。 */
export const COORDINATOR_EXPIRY_REASONS = ['event', 'config', 'content', 'missing', 'unreadable'] as const;

/** 输入过期原因。 */
export type CoordinatorExpiryReason = (typeof COORDINATOR_EXPIRY_REASONS)[number];

/** 一个待写入的块 — 与 T2 `replaceFile` / T3 `prepare` 的输入结构兼容。 */
export interface CoordinatorBlock {
	/** 块 ID,同一文件内唯一。 */
	id: string;
	/** 向量值。 */
	vector: number[];
	/** 块元数据。 */
	metadata: Record<string, unknown>;
}

/** `prepare` 输入的最小子集 — `IndexFileJournal.prepare` 的输入结构兼容。 */
export interface CoordinatorPrepareInput {
	/** vault 规范化相对路径。 */
	path: string;
	/** 操作类型。 */
	operation: 'replace' | 'delete';
	/** 本次输入内容 hash;删除为 null。 */
	inputHash: string | null;
	/** 目标版本号,必须大于声明的前驱 revision。 */
	revision: number;
	/** 声明的前驱提交 ID;首次提交为 null。 */
	previousCommitId: string | null;
	/** 声明的前驱 revision;首次提交为 0。 */
	previousRevision: number;
	/** 完整新块集合;零块表示空文件或删除。 */
	blocks: readonly CoordinatorBlock[];
}

/** `commit` 结论的最小子集 — `JournalCommitResult` 结构兼容。 */
export interface CoordinatorCommitResult {
	/** 该路径当前生效的完成记录。 */
	commit: {
		/** 版本号。 */
		revision: number;
		/** 输入内容 hash;删除记录为 null。 */
		inputHash: string | null;
		/** 块数量。 */
		chunkCount: number;
	};
	/** 完成记录已指向更高 revision,本次只清理旧日志。 */
	superseded: boolean;
}

/** 协调器写入日志的窄端口 — `IndexFileJournal` 结构上直接满足。 */
export interface CoordinatorJournalPort {
	/** 准备一个待提交事务(分片 + `prepared.json`)。 */
	prepare(input: CoordinatorPrepareInput): Promise<{ transactionId: string }>;
	/** 提交事务:替换向量并写完成记录。 */
	commit(transactionId: string): Promise<CoordinatorCommitResult>;
	/** 清理一个未提交事务(丢弃过期结果时使用)。 */
	cleanup(transactionId: string): Promise<void>;
	/** 读取某路径的完成记录(含删除凭据)。 */
	readReceipt(path: string): Promise<FileCommit | null>;
	/** 列出全部完成记录;缺失时无法发现「已提交但已从 Vault 消失」的路径。 */
	listReceipts?(): Promise<readonly FileCommit[]>;
	/**
	 * 列出路径隔离/不可用状态(只读)。
	 *
	 * 关键路径:这是「损坏/隔离」在协调器口径里成为 deny 的唯一来源;缺失时不做该项核对
	 * (装配层负责保证与日志同源),但绝不因此把它当成「已核实」。
	 */
	listPathStates?(): Promise<readonly BlockedPathState[]>;
	/** 代际是否被隔离(只读);为真时整个代际的路径都不得作为检索依据。 */
	isGenerationQuarantined?(): Promise<boolean>;
	/** 列出删除凭据(只读);用于让「已删除」在协调器口径里也是 deny。 */
	listTombstones?(): Promise<readonly CoordinatorTombstone[]>;
}

/** 删除凭据的最小视图 — 与 `IndexFileJournal.listTombstones()` 的返回结构兼容。 */
export interface CoordinatorTombstone {
	/** vault 规范化相对路径。 */
	path: string;
}

/** 协调器读取 Vault 的窄端口 — 与 `PersistentIndexBackendOptions.vault` 结构兼容。 */
export interface CoordinatorVaultPort {
	/** 枚举当前可索引的 markdown 相对路径(轻量列表,不含正文)。 */
	listMarkdownFiles(): string[];
	/** 读取单个文件内容。 */
	readFile(path: string): Promise<string>;
	/** 读取文件 stat;文件不存在时返回 null。 */
	stat(path: string): { mtime: number; size?: number } | null;
}

/**
 * 协调器的分块 + 嵌入端口。
 *
 * 关键路径:只负责「内容 → 完整块集合」,不读盘、不写盘;验收用可计数实现断言
 * 「只有变更的那一篇进入嵌入调用」。
 */
export interface CoordinatorProcessorPort {
	/**
	 * 把一份内容切块并嵌入;返回完整新块集合(空内容返回空数组)。
	 *
	 * @param input - 路径与内容。
	 * @param options - 可选取消信号与批次活动回调;实现方应在每个真实完成的批次回报一次。
	 */
	prepareBlocks(
		input: { path: string; content: string },
		options?: EmbedOptions,
	): Promise<readonly CoordinatorBlock[]>;
}

/** 任务进度计数 — 状态展示与终态判据的同一份口径。 */
export interface IndexTaskCounters {
	/** 本轮任务标识,每次 `start()` 递增;用于区分新旧任务进度。 */
	taskId: number;
	/** 当前阶段。 */
	phase: IndexPhase;
	/** 本轮扫描是否已结束。 */
	scanComplete: boolean;
	/**
	 * 本轮已知文件总数 — 本轮枚举结果 + 运行期新出现的路径,再扣除收敛后回收的「既不在本轮枚举、
	 * 也没有队列项/未决事务/已核实状态」的路径。口径是「本轮已知文件数」,不是历史出现过的路径数。
	 */
	total: number;
	/** 已核实且可作为检索依据的文件数。 */
	committed: number;
	/** 尚未核实且没有失败记录的唯一文件数；展示专用，不与事务数相加。 */
	pendingFiles?: number;
	/** 本轮真正写入完成记录的次数(替换 + 删除);内容未变的复用不计入。 */
	committedThisRound: number;
	/** 本轮真正写入的块数;缺省时按 0 处理(主线程协调器暂不提供)。 */
	committedBlocksThisRound?: number;
	/** 仍有待处理工作的文件数(待重试、失败保留项与被队列上界丢弃尚未回收的路径)。 */
	queued: number;
	/** 在途提交数(0 或 1)。 */
	active: number;
	/** 未结算事务数。 */
	pendingTransactions: number;
	/**
	 * 本轮未清除的失败数 — 按路径记账:同一路径后续成功处理即清除该路径的失败,
	 * 其它路径的失败与其他来源(启动枚举失败)不受影响。
	 */
	failures: number;
}

/** 协调器选项。 */
export interface IndexTaskCoordinatorOptions {
	/** 读取 Vault 的端口。 */
	vault: CoordinatorVaultPort;
	/** 文件日志端口(写所有权由装配层保证)。 */
	journal: CoordinatorJournalPort;
	/** 分块 + 嵌入端口。 */
	processor: CoordinatorProcessorPort;
	/** 捕获当前配置指纹 — 每次核对都会重新捕获,配置变化即视为过期。 */
	getConfigFingerprint: () => string;
	/**
	 * 事件订阅 — `start()` 会在**首次枚举之前**调用它,并把退订句柄留给 `destroy()`。
	 *
	 * 关键路径:这是「监听器先于枚举装配」的结构保证;省略时调用方必须自行保证
	 * 已在 `start()` 前接好事件并调用 {@link IndexTaskCoordinator.notify}。
	 */
	subscribe?: (notify: (path: string, op: CoordinatorEventOp) => void) => () => void;
	/** 该路径当前是否被排除(黑名单)。被排除路径立即 deny 并排队删除。 */
	isExcluded?: (path: string) => boolean;
	/** 扫描核对的并发上限,默认 4。 */
	scanConcurrency?: number;
	/** 路径队列上界,默认 100000;按路径合并后正常不超过文件数。 */
	maxQueueEntries?: number;
	/** 同一路径连续处理失败的重试上限,默认 3。 */
	maxReadAttempts?: number;
	/** 事件到达后是否自动触发处理,默认 true;扫描未结束时只入队,由扫描后的收敛统一处理。 */
	autoDrain?: boolean;
}

/** 队列终态判据 — 与计划锁定片段逐字一致。 */
export function canMarkReady(s: {
	scanComplete: boolean;
	queued: number;
	active: number;
	pendingTransactions: number;
	failures: number;
}): boolean {
	return s.scanComplete && s.queued === 0 && s.active === 0
		&& s.pendingTransactions === 0 && s.failures === 0;
}

// ==================== 停滞与活动(T5 §4)====================

/**
 * 停滞看护的时钟接缝 — 判定完全不依赖协调器内部的墙上时间。
 *
 * 关键路径:时间相关用例必须由可控时钟驱动,不能用真实定时器赛跑。
 */
export interface IndexStallWatchdogClock {
	/** 设定一次性定时器。 */
	setTimeout(handler: () => void, timeoutMs: number): unknown;
	/** 取消定时器。 */
	clearTimeout(handle: unknown): void;
}

/**
 * 停滞判定的进展来源 — 协调器结构上满足本接口。
 *
 * 关键路径:进展只由**真实完成**的步骤产生(接受的批次活动、真实提交与核实),
 * 路径事件到达本身不算进展 —— 这正是「有事件但无进展」仍能被判定的原因。
 */
export interface IndexStallSource {
	/** 有效进展代数。 */
	progressMark(): number;
	/** 最后一次被接受的活动。 */
	lastActivity(): IndexActivity | null;
	/** 进入停滞(保留任务与未决事务,不清库)。 */
	markStalled(): void;
	/** 迟到有效活动后回到处理中。 */
	markResumed(): void;
	/** 本轮过期重排次数 — 「有事件但无进展」的诊断补充。 */
	expiredRequeues(): number;
}

/** 停滞 / 恢复诊断 — 阶段、持续时间、批次与数量;不含正文、向量、路径或密钥。 */
export interface IndexStallInfo {
	/** 采样到的有效进展代数。 */
	progressMark: number;
	/** 无有效进展的累计时长(按阈值整数倍累计)。 */
	idleMs: number;
	/** 判定阈值。 */
	stallAfterMs: number;
	/** 最后一次被接受的活动;从无活动时为 null。 */
	lastActivity: IndexActivity | null;
	/** 本轮过期重排次数。 */
	expiredRequeues: number;
}

/** 停滞看护选项。 */
export interface IndexStallWatchdogOptions {
	/** 进展来源 — 一般是协调器。 */
	source: IndexStallSource;
	/** 无有效进展达到该时长即判定停滞,默认 60 秒。 */
	stallAfterMs?: number;
	/** 时钟接缝;默认 `globalThis` 定时器。 */
	clock?: IndexStallWatchdogClock;
	/** 首次判定停滞时回调一次。 */
	onStall?: (info: IndexStallInfo) => void;
	/** 停滞后出现有效进展时回调一次。 */
	onResume?: (info: IndexStallInfo) => void;
}

/** 默认时钟 — 不依赖 `window`,便于测试与子进程复用同一实现。 */
const defaultStallClock: IndexStallWatchdogClock = {
	setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 停滞看护 — 外部计时器,周期性采样有效进展代数。
 *
 * 关键路径:
 * - 只采样「真实完成」的进展,事件到达、重排与计时器本身都不算活动;
 * - 停滞只更新状态,任务仍由协调器继续持有,不清库、不启动替代写任务;
 * - 停滞期间继续轮询:迟到的有效活动一到就回到处理中,真实完成仍能提交。
 */
export class IndexStallWatchdog {
	private readonly source: IndexStallSource;
	private readonly stallAfterMs: number;
	private readonly clock: IndexStallWatchdogClock;
	private readonly onStall?: (info: IndexStallInfo) => void;
	private readonly onResume?: (info: IndexStallInfo) => void;
	private timer: unknown = null;
	private running = false;
	private stalled = false;
	private idleMs = 0;
	private lastProgress = 0;

	/**
	 * @param options - 进展来源、阈值、时钟与回调。
	 */
	constructor(options: IndexStallWatchdogOptions) {
		this.source = options.source;
		this.stallAfterMs = Math.max(1, Math.floor(options.stallAfterMs ?? 60_000));
		this.clock = options.clock ?? defaultStallClock;
		this.onStall = options.onStall;
		this.onResume = options.onResume;
	}

	/** 开始看护 — 以当前进展为基线。 */
	start(): void {
		if (this.running) return;
		this.running = true;
		this.stalled = false;
		this.idleMs = 0;
		this.lastProgress = this.source.progressMark();
		this.arm();
	}

	/** 停止看护并清理计时器。 */
	stop(): void {
		this.running = false;
		this.clearTimer();
	}

	/** 当前是否判定为停滞。 */
	isStalled(): boolean {
		return this.stalled;
	}

	/** 诊断快照。 */
	info(): IndexStallInfo {
		return {
			progressMark: this.lastProgress,
			idleMs: this.idleMs,
			stallAfterMs: this.stallAfterMs,
			lastActivity: this.source.lastActivity(),
			expiredRequeues: this.source.expiredRequeues(),
		};
	}

	/** 手动采样一次 — 与定时器触发等价,供显式驱动与测试使用。 */
	sample(): void {
		this.tick();
	}

	/** 武装下一次采样。 */
	private arm(): void {
		this.clearTimer();
		this.timer = this.clock.setTimeout(() => this.tick(), this.stallAfterMs);
	}

	/** 一次采样:有进展则清零并(必要时)恢复;否则累计无进展时长。 */
	private tick(): void {
		this.timer = null;
		if (!this.running) return;
		const current = this.source.progressMark();
		if (current > this.lastProgress) {
			this.lastProgress = current;
			this.idleMs = 0;
			if (this.stalled) {
				this.stalled = false;
				this.source.markResumed();
				this.onResume?.(this.info());
			}
			this.arm();
			return;
		}
		this.idleMs += this.stallAfterMs;
		if (!this.stalled) {
			this.stalled = true;
			this.source.markStalled();
			this.onStall?.(this.info());
		}
		// 继续轮询:迟到有效活动一到就恢复处理中。
		this.arm();
	}

	/** 清理计时器。 */
	private clearTimer(): void {
		if (this.timer === null || this.timer === undefined) return;
		this.clock.clearTimeout(this.timer);
		this.timer = null;
	}
}

// ==================== 内部类型 ====================

/** 单个路径的队列项 — 同路径只保留最新事件。 */
interface QueueEntry {
	/** 最新事件操作。 */
	op: CoordinatorEventOp;
	/** 最新事件序号。 */
	sequence: number;
	/** 本次处理消费的事件序号(核对与提交后判据都用它)。 */
	startedSequence: number;
	/** 连续处理失败次数。 */
	attempts: number;
	/** 是否正在处理。 */
	active: boolean;
	/**
	 * 重试次数已用尽:保留队列项但不再自动重试。
	 *
	 * 关键路径:这不是终态 —— 同路径的新事件、任何一次成功处理或新一轮 `start()` 都会清除它,
	 * 否则该路径会被永久搁置,同一实例内 `ready` 不可达。
	 */
	exhausted: boolean;
}

/** 一次内容快照及生成它时的事件/配置依据。 */
interface CoordinatorSnapshot {
	/** 文件内容。 */
	content: string;
	/** 内容 hash。 */
	inputHash: string;
	/** 读取前捕获的事件序号 — 读取或推理期间到达的新事件会被核对发现。 */
	sequence: number;
	/** 读取时的配置指纹。 */
	configFingerprint: string;
	/** 读取时的 mtime(辅助信息,不单独证明内容未变)。 */
	mtime: number;
	/** 读取时的字节数(辅助信息)。 */
	size: number | null;
}

/** 读取结论。 */
type ReadResult =
	| { kind: 'content'; content: string; hash: string; mtime: number; size: number | null }
	| { kind: 'missing' }
	| { kind: 'unreadable'; code: string };

/** 核对结论。 */
type VerifyResult = { ok: true } | { ok: false; reason: CoordinatorExpiryReason };

/** 单文件处理结论 — `retry` 表示已计入失败并保留待重试项。 */
type ProcessOutcome = 'done' | 'retry';

// ==================== 协调器实现 ====================

/**
 * 持久任务协调器 — 流式扫描、路径事件队列、文件新鲜度与单文件提交的唯一调度入口。
 *
 * 关键路径:
 * - 同一时刻只有一个路径处于准备/提交(不为吞吐并发写入);
 * - 提交成功不等于「本轮完成」:`canMarkReady` 还要求扫描结束、队列为空、无在途与无未决事务;
 * - 失败只影响对应路径,其他路径继续推进。
 *
 * @example
 *   const coordinator = new IndexTaskCoordinator({ vault, journal, processor, getConfigFingerprint, subscribe });
 *   await coordinator.start();
 *   coordinator.counters().phase; // 'ready' | 'partial-failure' | ...
 */
export class IndexTaskCoordinator {
	private readonly options: IndexTaskCoordinatorOptions;
	private readonly scanConcurrency: number;
	private readonly maxQueueEntries: number;
	private readonly maxReadAttempts: number;
	private readonly autoDrain: boolean;
	/** 每路径单调递增的事件序号。 */
	private readonly sequenceByPath = new Map<string, number>();
	/** 路径 → 队列项(同路径只保留最新事件)。 */
	private readonly queue = new Map<string, QueueEntry>();
	/** 当前有待消费队列项的路径集合。 */
	private readonly pendingPaths = new Set<string>();
	/** 待消费顺序(可能含已消费的名字,由 `pendingPaths` 过滤)。 */
	private order: string[] = [];
	/** 本轮新鲜度视图。 */
	private readonly freshness = new Map<string, FileFreshness>();
	/** 本轮已核实且可检索的路径。 */
	private readonly verified = new Set<string>();
	/** 存在未结算事务或在途写入的路径。 */
	private readonly unresolved = new Set<string>();
	/** 未结算事务 ID。 */
	private readonly pendingTransactions = new Set<string>();
	/** 本轮已知路径集合(`total` 口径)。 */
	private readonly knownPaths = new Set<string>();
	/** 本轮枚举结果 — 记忆回收的保留依据之一。 */
	private readonly enumeratedPaths = new Set<string>();
	/** 被队列上界丢弃、等待重新入队的路径 → 被丢弃时的操作。 */
	private readonly overflowedPaths = new Map<string, CoordinatorEventOp>();
	/** 路径 → 日志声明的隔离/不可用状态(只读信号)。 */
	private readonly journalBlocked = new Set<string>();
	/** 日志中已有删除凭据的路径(只读信号)。 */
	private readonly journalTombstoned = new Set<string>();
	/** 当前处于失败状态、尚未清除的路径。 */
	private readonly failingPaths = new Set<string>();
	private activeCount = 0;
	private committedThisRound = 0;
	private scanComplete = false;
	/** 不归属单个路径的失败数(启动枚举失败)。 */
	private unattributedFailures = 0;
	/** 本轮已处理的队列项数 — 收敛循环用它判断「这一趟有没有进展」。 */
	private processedEntries = 0;
	/** 代际级隔离(只读信号) — 为真时本代际整体不可检索。 */
	private generationQuarantined = false;
	private overflow = 0;
	private taskId = 0;
	private paused = false;
	private unloaded = false;
	private failed = false;
	/** 有效进展代数 — 只由真实完成的步骤递增(见 `IndexStallSource`)。 */
	private progress = 0;
	/** 本轮过期重排次数。 */
	private expiredRequeueCount = 0;
	/** 最近一次被接受的外部活动(带单调序号)。 */
	private lastSeenActivity: IndexActivity | null = null;
	/** 外部活动序号基线 — 只接受单调递增的序号。 */
	private lastActivitySequence = 0;
	/** 当前批次的已完成单位数 — 每个文件重新计数。 */
	private lastBatchDone = 0;
	/** 停滞状态 — 由外部看护驱动,不改变终态判据。 */
	private stalled = false;
	/** 取消中 — 停止调度新文件并中止可取消的调用。 */
	private aborting = false;
	/** 当前处理项的取消句柄。 */
	private activeAbort: AbortController | null = null;
	/** 未启动时按「未在工作」报告 — `IndexPhase` 没有空闲态。 */
	private phase: IndexPhase = 'paused';
	private draining: Promise<void> | null = null;
	private unsubscribe: (() => void) | null = null;

	/**
	 * @param options - Vault/日志/嵌入端口、配置指纹来源与可选事件订阅。
	 */
	constructor(options: IndexTaskCoordinatorOptions) {
		this.options = options;
		this.scanConcurrency = Math.max(1, Math.floor(options.scanConcurrency ?? 4));
		this.maxQueueEntries = Math.max(1, Math.floor(options.maxQueueEntries ?? 100_000));
		this.maxReadAttempts = Math.max(1, Math.floor(options.maxReadAttempts ?? 3));
		this.autoDrain = options.autoDrain ?? true;
	}

	/**
	 * 启动一轮任务:先装配事件监听,再枚举、逐文件核对,最后收敛队列。
	 *
	 * 关键路径:
	 * - 监听在首次枚举之前装配(结构保证,不依赖调用顺序);
	 * - 只读的路径状态 / 代际隔离信号在核对之前刷新,被隔离路径在本轮一律不作为检索依据;
	 * - 扫描期间的变更靠「逐文件 hash 核对 + 已入队事件」双重覆盖,包括没有事件到达的情况;
	 * - 扫描结束后的队列收敛处理期间积累的事件与自身触发的重排;
	 * - 新一轮重置上一轮的重试预算(否则上一轮用尽重试的路径会永久搁置本轮的收敛);
	 * - 收敛结束后回收记忆,`total` 只表达本轮已知文件数。
	 *
	 * @returns 本轮收敛后的计数快照。
	 */
	async start(): Promise<IndexTaskCounters> {
		if (this.unloaded) return this.counters();
		// 关键路径:新任务重置旧任务的失败、重试预算与阶段,旧任务进度不得污染新任务。
		this.taskId += 1;
		this.scanComplete = false;
		this.committedThisRound = 0;
		this.failingPaths.clear();
		this.unattributedFailures = 0;
		this.failed = false;
		this.stalled = false;
		this.aborting = false;
		this.phase = 'scanning';
		this.resetRetryBudget();
		if (this.unsubscribe === null && this.options.subscribe !== undefined) {
			this.unsubscribe = this.options.subscribe((path, op) => this.notify(path, op));
		}
		let paths: string[] = [];
		try {
			paths = this.enumerate();
			this.enumeratedPaths.clear();
			for (const path of paths) {
				this.enumeratedPaths.add(path);
				this.knownPaths.add(path);
			}
			await this.refreshJournalSignals();
			await this.reconcile(paths);
			await this.scheduleMissingPaths(new Set(paths));
		}
		catch (error) {
			this.failed = true;
			this.unattributedFailures += 1;
			this.scanComplete = true;
			this.phase = 'failed';
			devLogger.error('index', '启动扫描失败', error);
			return this.counters();
		}
		this.scanComplete = true;
		// 关键路径:收敛期间可能继续到达新事件,循环到没有进展或被显式暂停/卸载。
		for (let guard = 0; guard < 1000; guard += 1) {
			if (this.unloaded || this.paused || this.pendingPaths.size === 0) break;
			const processed = this.processedEntries;
			await this.drain();
			// 收敛判据按「这一趟是否处理过队列项」,不能按待处理集合大小:处理完一批又回收溢出路径时
			// 集合大小可以不变,但那不是收敛。
			if (this.processedEntries === processed && this.overflowedPaths.size === 0) break;
		}
		if (!this.paused && !this.unloaded) this.compactMemory();
		this.phase = this.computePhase();
		return this.counters();
	}

	/**
	 * 记录一次路径事件。
	 *
	 * 关键路径:序号按路径单调递增;同路径多次事件只在队列里保留最新一项,
	 * 但序号继续增长,因此「提交期间又有新事件」不会被批次结束清空。
	 *
	 * @param path - vault 相对路径。
	 * @param op - 事件操作。
	 */
	notify(path: string, op: CoordinatorEventOp): void {
		if (this.unloaded) return;
		const normalized = normalizePath(path);
		if (normalized === null) return;
		this.recordEvent(normalized, op);
	}

	/**
	 * 收敛队列 — 串行处理,同一时刻只有一个路径在准备/提交。
	 *
	 * @returns 队列收敛(或被暂停/卸载打断)后完成。
	 */
	drain(): Promise<void> {
		const running = this.draining;
		if (running !== null) return running;
		const task = this.runDrainLoop();
		this.draining = task;
		void task.finally(() => {
			if (this.draining !== task) return;
			this.draining = null;
			// 关键路径:收敛退出窗口内到达的新事件必须接力处理,不能在退出窗口被丢弃。
			if (this.autoDrain && !this.paused && !this.unloaded && this.pendingPaths.size > 0) {
				void this.drain().catch((error: unknown) => devLogger.error('index', '队列接力收敛失败', error));
			}
		});
		return task;
	}

	/** 当前计数快照。 */
	counters(): IndexTaskCounters {
		let pendingFiles = 0;
		for (const path of this.knownPaths) {
			if (!this.verified.has(path) && !this.failingPaths.has(path)) pendingFiles += 1;
		}
		return {
			taskId: this.taskId,
			phase: this.phase,
			scanComplete: this.scanComplete,
			total: this.knownPaths.size,
			committed: this.verified.size,
			pendingFiles,
			committedThisRound: this.committedThisRound,
			// 关键路径:被队列上界丢弃但尚未回收的路径仍有待处理工作,必须计入 queued,
			// 否则 canMarkReady 会在「已知路径没有完成记录也没有失败」的情况下成立。
			queued: this.queue.size + this.overflowedPaths.size,
			active: this.activeCount,
			pendingTransactions: this.pendingTransactions.size,
			failures: this.failures(),
		};
	}

	/**
	 * 本轮是否可以标记 ready — 判据与 {@link canMarkReady} 完全一致,另加两条协调器侧的前置条件:
	 * 没有「被上界丢弃且尚未回收」的路径,也没有被日志判定为损坏/隔离的现行路径。
	 */
	isReady(): boolean {
		if (this.unloaded) return false;
		if (this.overflowedPaths.size > 0) return false;
		if (this.generationQuarantined) return false;
		if (this.hasBlockedKnownPath()) return false;
		return canMarkReady(this.counters());
	}

	/**
	 * 路径新鲜度 — 供检索可见性门使用。
	 *
	 * 关键路径:损坏/隔离/已删除在**本模块口径下**就是 deny,不只依赖可见性门的快照:
	 * 代际隔离与日志路径状态(隔离/不可用)一律报 `corrupt`,日志有删除凭据的路径报 `deleted`,
	 * 因此只消费 `freshnessOf()` 的调用方也不会把已隔离路径当成 `verified`。
	 *
	 * @param path - vault 相对路径。
	 * @returns 新鲜度;未核对路径为 `unknown`(不等于过期)。
	 */
	freshnessOf(path: string): FileFreshness {
		if (this.options.isExcluded?.(path) === true) return 'excluded';
		if (this.unresolved.has(path)) return 'unresolved-transaction';
		if (this.isJournalDenied(path)) return 'corrupt';
		if (this.journalTombstoned.has(path)) return 'deleted';
		return this.freshness.get(path) ?? 'unknown';
	}

	/** 未结算事务路径 — 可见性门必须过滤这些路径。 */
	unresolvedPaths(): ReadonlySet<string> {
		return new Set(this.unresolved);
	}

	/** 本轮已核实且可检索的路径。 */
	verifiedPaths(): ReadonlySet<string> {
		return new Set(this.verified);
	}

	/** 已丢弃的越界事件数(队列上界保护),用于诊断而非静默。 */
	overflowedEvents(): number {
		return this.overflow;
	}

	// ==================== 活动与停滞(T5)====================

	/**
	 * 有效进展代数 — 每次真实完成的步骤递增。
	 *
	 * 关键路径:事件到达、重排与计时器空转都**不**递增它,因此外部看护能区分
	 * 「有事件但无进展」与真实推进。
	 */
	progressMark(): number {
		return this.progress;
	}

	/** 最近一次被接受的外部活动;从无活动时为 null。 */
	lastActivity(): IndexActivity | null {
		return this.lastSeenActivity;
	}

	/** 本轮过期重排次数 — 「有事件但无进展」情形需要另设计数时的诊断补充。 */
	expiredRequeues(): number {
		return this.expiredRequeueCount;
	}

	/**
	 * 接收一次外部活动(来自 Worker 侧真实完成的批次 / IO 步骤)。
	 *
	 * 关键路径:只接受单调递增的序号;接受的算真实进展,并清除停滞状态
	 * (迟到的有效活动可恢复处理中)。
	 *
	 * @param activity - 活动包。
	 * @returns 是否被接受为有效进展。
	 */
	observeActivity(activity: IndexActivity): boolean {
		if (this.unloaded) return false;
		if (activity.sequence <= this.lastActivitySequence) return false;
		this.lastActivitySequence = activity.sequence;
		this.lastSeenActivity = { ...activity };
		this.progress += 1;
		if (this.stalled) this.markResumed();
		return true;
	}

	/**
	 * 进入停滞 — 保留任务、队列与未决事务,不清库、不并发启动替代写任务。
	 *
	 * 关键路径:停滞不是终态;`canMarkReady` 仍是唯一终态判据,这里只改阶段显示。
	 */
	markStalled(): void {
		if (this.unloaded || this.stalled) return;
		this.stalled = true;
		this.phase = this.computePhase();
	}

	/** 离开停滞 — 回到处理中。 */
	markResumed(): void {
		if (!this.stalled) return;
		this.stalled = false;
		this.phase = this.computePhase();
	}

	/** 当前是否处于停滞。 */
	isStalled(): boolean {
		return this.stalled;
	}

	/**
	 * 当前是否已停止调度新文件(暂停或卸载)。
	 *
	 * 关键路径(I6):取消路径的顺序断言需要能观察到「撤销在途调用」发生在
	 * 「停止调度新文件」之前,而停止调度的事实状态就是本方法。
	 */
	isPaused(): boolean {
		return this.paused || this.unloaded;
	}

	/**
	 * 取消在途处理 — 先撤销在途可取消的调用,再停止调度新文件。
	 *
	 * 关键路径:调用方必须先撤销 epoch 再调本方法(epoch 属于写所有权,见 T2 协调器);
	 * 已进入的磁盘提交由访问门收尾,不会被重叠写入。
	 *
	 * 关键路径(I6):顺序必须是「先撤销在途调用、再置停止调度」—— 反序会在
	 * 「已停止调度」与「撤销在途调用」之间留出一个仍持有证书的窗口;`isPaused()` 是可观察判决点。
	 *
	 * @param reason - 诊断文案;不含路径、正文或密钥。
	 */
	abortActive(reason = '索引任务已取消'): void {
		if (this.unloaded && this.aborting) return;
		this.activeAbort?.abort();
		this.aborting = true;
		this.paused = true;
		devLogger.debug('index', `索引任务取消:${reason}`);
		this.phase = this.computePhase();
	}

	/** 暂停 — 队列继续累积,不消费。 */
	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.phase = 'paused';
	}

	/**
	 * 恢复 — 清除「重试已用尽」标记、回收被上界丢弃的路径并继续消费队列。
	 *
	 * 关键路径:这是**显式**重试入口,不是失败收敛的唯一出路(新事件或新一轮 `start()` 同样清除预算);
	 * 失败只在该路径真的处理成功时才清除,恢复本身不假装成功。
	 */
	resume(): void {
		if (this.unloaded) return;
		this.paused = false;
		this.aborting = false;
		this.stalled = false;
		for (const [path, entry] of this.queue) {
			if (entry.exhausted) {
				entry.exhausted = false;
				entry.attempts = 0;
			}
			if (entry.active || this.pendingPaths.has(path)) continue;
			this.pendingPaths.add(path);
			this.order.push(path);
		}
		this.requeueOverflowed();
		this.compactOrder();
		this.phase = this.computePhase();
		if (this.autoDrain) void this.drain().catch((error: unknown) => devLogger.error('index', '恢复后队列收敛失败', error));
	}

	/** 卸载 — 退订事件,释放记忆,不再消费队列。 */
	destroy(): void {
		if (this.unloaded) return;
		this.unloaded = true;
		this.phase = 'stopping';
		// 关键路径:卸载时停止调度并中止可取消的调用;耗时写入不依赖卸载回调收尾。
		this.activeAbort?.abort();
		if (this.unsubscribe !== null) {
			try {
				this.unsubscribe();
			}
			catch (error) {
				devLogger.warn('index', '退订索引事件失败', error);
			}
			this.unsubscribe = null;
		}
		this.queue.clear();
		this.pendingPaths.clear();
		this.order = [];
		// 关键路径:进程内不再持有可能无限增长的历史路径视图。
		this.knownPaths.clear();
		this.enumeratedPaths.clear();
		this.sequenceByPath.clear();
		this.freshness.clear();
		this.verified.clear();
		this.unresolved.clear();
		this.overflowedPaths.clear();
		this.journalBlocked.clear();
		this.journalTombstoned.clear();
		this.failingPaths.clear();
	}

	// ==================== 事件与队列 ====================

	/** 记录事件序号、更新新鲜度并合并进队列。 */
	private recordEvent(path: string, op: CoordinatorEventOp): void {
		if (this.unloaded) return;
		const sequence = (this.sequenceByPath.get(path) ?? 0) + 1;
		this.sequenceByPath.set(path, sequence);
		this.knownPaths.add(path);
		const excluded = this.isExcluded(path);
		// 关键路径:删除/排除/损坏立即 deny;普通修改只标记 known-stale,等新版本提交后恢复。
		if (op === 'delete' || excluded) {
			this.markDenied(path, excluded ? 'excluded' : 'deleted');
		}
		else {
			this.markDenied(path, 'known-stale');
		}
		this.mergeQueued(path, op === 'delete' || excluded ? 'delete' : 'upsert', sequence);
		this.phase = this.computePhase();
		this.scheduleDrain();
	}

	/** 把事件合并进队列 — 同路径只保留最新一项,序号继续增长。 */
	private mergeQueued(path: string, op: CoordinatorEventOp, sequence: number): void {
		const existing = this.queue.get(path);
		if (existing !== undefined) {
			existing.op = op;
			existing.sequence = sequence;
			// 关键路径:新事件给该路径一个新的重试预算 —— 否则「上界/失败保留 + 用尽重试」会永久搁置路径。
			existing.exhausted = false;
			existing.attempts = 0;
			this.overflowedPaths.delete(path);
			if (!existing.active && !this.pendingPaths.has(path)) {
				this.pendingPaths.add(path);
				this.order.push(path);
			}
			return;
		}
		if (this.queue.size >= this.maxQueueEntries) {
			// 有界保护:队列已达上界时丢弃本事件的入队动作(序号仍保留),但路径必须记账,
			// 由 `requeueOverflowed()` 在出现空位后重新入队;回收完成前它计入 `queued` 并阻止 ready。
			this.overflow += 1;
			this.overflowedPaths.set(path, op);
			return;
		}
		this.queue.set(path, { op, sequence, startedSequence: sequence, attempts: 0, active: false, exhausted: false });
		this.pendingPaths.add(path);
		this.order.push(path);
		this.overflowedPaths.delete(path);
		this.compactOrder();
	}

	/** 取出下一个待处理项 — 跳过已被消费的顺序占位。 */
	private takeNextEntry(): { path: string; entry: QueueEntry } | null {
		while (this.order.length > 0) {
			const path = this.order.shift();
			if (path === undefined) break;
			if (!this.pendingPaths.has(path)) continue;
			const entry = this.queue.get(path);
			if (entry === undefined) {
				this.pendingPaths.delete(path);
				continue;
			}
			if (entry.active) continue;
			this.pendingPaths.delete(path);
			entry.active = true;
			entry.startedSequence = entry.sequence;
			return { path, entry };
		}
		return null;
	}

	/** 顺序数组的有界整理 — 只在明显膨胀时执行,保证内存不随键入无限增长。 */
	private compactOrder(): void {
		const limit = this.pendingPaths.size * 2 + 64;
		if (this.order.length <= limit) return;
		const seen = new Set<string>();
		const compacted: string[] = [];
		for (const path of this.order) {
			if (seen.has(path) || !this.pendingPaths.has(path)) continue;
			seen.add(path);
			compacted.push(path);
		}
		for (const path of this.pendingPaths) {
			if (!seen.has(path)) compacted.push(path);
		}
		this.order = compacted;
	}

	/** 保证该路径仍有队列项 — 提交后仍有新事件时保留,不清空后来事件。 */
	private retain(path: string): void {
		if (!this.queue.has(path)) return;
		if (this.pendingPaths.has(path)) return;
		this.pendingPaths.add(path);
		this.order.push(path);
		this.compactOrder();
	}

	/** 交付一次事件后安排收敛(扫描未结束时只入队,由扫描后的收敛统一处理)。 */
	private scheduleDrain(): void {
		if (!this.autoDrain || this.paused || this.unloaded || !this.scanComplete) return;
		void this.drain().catch((error: unknown) => devLogger.error('index', '队列收敛失败', error));
	}

	/** 收敛主循环 — 逐项处理,失败只影响对应路径;有空位就回收被上界丢弃的路径。 */
	private async runDrainLoop(): Promise<void> {
		while (!this.unloaded && !this.paused) {
			const next = this.takeNextEntry();
			if (next === null) {
				// 关键路径:上界丢弃的路径在队列出现空位后必须回收,否则「已知但没有完成记录」的路径
				// 会在无人再发事件时被静默漏掉(而阶段却可能报 ready)。
				if (!this.requeueOverflowed()) break;
				continue;
			}
			await this.processEntry(next.path, next.entry);
		}
		if (!this.paused && !this.unloaded) this.compactMemory();
		this.phase = this.computePhase();
	}

	/**
	 * 把因队列上界被丢弃的路径重新入队 — 只在有空位时成功,否则保留记账等待下一次。
	 *
	 * @returns 是否有路径重新入队(或有队列项被恢复为待消费)。
	 */
	private requeueOverflowed(): boolean {
		if (this.overflowedPaths.size === 0) return false;
		let requeued = false;
		for (const [path, op] of [...this.overflowedPaths]) {
			const existing = this.queue.get(path);
			if (existing !== undefined) {
				existing.exhausted = false;
				existing.attempts = 0;
				if (!existing.active && !this.pendingPaths.has(path)) {
					this.pendingPaths.add(path);
					this.order.push(path);
				}
				this.overflowedPaths.delete(path);
				requeued = true;
				continue;
			}
			if (this.queue.size >= this.maxQueueEntries) continue;
			const sequence = Math.max(this.latestSequence(path), 1);
			this.queue.set(path, { op, sequence, startedSequence: sequence, attempts: 0, active: false, exhausted: false });
			this.pendingPaths.add(path);
			this.order.push(path);
			this.overflowedPaths.delete(path);
			requeued = true;
		}
		if (requeued) this.compactOrder();
		return requeued;
	}

	// ==================== 扫描核对 ====================

	/** 枚举当前可索引路径 — 轻量列表,不含正文。 */
	private enumerate(): string[] {
		const raw = this.options.vault.listMarkdownFiles();
		const paths: string[] = [];
		const seen = new Set<string>();
		for (const candidate of raw) {
			const normalized = normalizePath(candidate);
			if (normalized === null || seen.has(normalized)) continue;
			seen.add(normalized);
			paths.push(normalized);
		}
		return paths;
	}

	/** 有界并发核对枚举结果。 */
	private async reconcile(paths: readonly string[]): Promise<void> {
		if (paths.length === 0) return;
		// 关键路径:并发上限固定,核对期间最多持有这么多份正文,不构造全库正文数组。
		const pool = [...paths];
		const workers: Promise<void>[] = [];
		const workerCount = Math.min(this.scanConcurrency, pool.length);
		for (let index = 0; index < workerCount; index += 1) workers.push(this.reconcileWorker(pool));
		await Promise.all(workers);
	}

	/** 单个核对协程:逐个取出路径核对到池空。 */
	private async reconcileWorker(pool: string[]): Promise<void> {
		for (;;) {
			const path = pool.shift();
			if (path === undefined) return;
			try {
				await this.reconcilePath(path);
			}
			catch (error) {
				this.recordFailure(path);
				devLogger.warn('index', `启动核对失败:${path}`, error);
				this.recordEvent(path, 'upsert');
			}
		}
	}

	/**
	 * 核对单个路径 — mtime/size 只作辅助,内容 hash 决定是否复用。
	 *
	 * 关键路径:逐文件核实后立即解锁已提交部分(标记 verified),扫描未结束不阻止其被检索;
	 * 但被日志隔离/不可用或被代际隔离的路径不得复用 —— 即使 hash 相同也重新入队,由处理阶段
	 * 按 `corrupt` 拒绝(`markVerified` 是最后一道闸门)。
	 */
	private async reconcilePath(path: string): Promise<void> {
		if (this.isExcluded(path)) {
			this.markDenied(path, 'excluded');
			this.recordEvent(path, 'delete');
			return;
		}
		const receipt = await this.options.journal.readReceipt(path);
		if (receipt === null || receipt.state !== 'present') {
			// 新增或只有删除凭据:入队按最新内容处理,不在此处嵌入。
			this.recordEvent(path, 'upsert');
			return;
		}
		if (this.isJournalDenied(path)) {
			// 损坏/隔离/代际隔离:不得复用旧版本,入队走一次写路径由 `markVerified` 拒绝。
			this.recordEvent(path, 'upsert');
			return;
		}
		const read = await this.readFileSafely(path);
		if (read.kind === 'content') {
			if (read.hash === receipt.inputHash && receipt.configFingerprint === this.options.getConfigFingerprint()) {
				// 未变化且配置兼容:复用,不调用嵌入模型,不重写向量。
				this.markVerified(path);
				return;
			}
			// 内容变化或配置不兼容:标记过期并入队重算(含 mtime/size 未变而正文变化的情况)。
			this.recordEvent(path, 'upsert');
			return;
		}
		if (read.kind === 'missing') {
			this.recordEvent(path, 'delete');
			return;
		}
		// 无法读取:不当作变更,也不当作删除;计入失败并保留待重试项。
		this.recordFailure(path);
		this.recordEvent(path, 'upsert');
	}

	/** 已提交但已从 Vault 消失的路径 — 枚举与监听之间的空隙在此补齐。 */
	private async scheduleMissingPaths(enumerated: ReadonlySet<string>): Promise<void> {
		const journal = this.options.journal;
		if (journal.listReceipts === undefined) return;
		for (const receipt of await journal.listReceipts()) {
			if (receipt.state !== 'present' || enumerated.has(receipt.path)) continue;
			if (this.isExcluded(receipt.path)) this.markDenied(receipt.path, 'excluded');
			this.recordEvent(receipt.path, 'delete');
		}
	}

	// ==================== 单文件处理 ====================

	/**
	 * 处理一个队列项 — 失败只影响该路径。
	 *
	 * 关键路径:处理成功(未计入失败)时清除该路径的「重试已用尽」标记与失败归属。
	 * 只靠 `resume()` 清除会让同一实例在「瞬时失败后自愈」时永久停在 `queued>0`。
	 */
	private async processEntry(path: string, entry: QueueEntry): Promise<void> {
		this.activeCount = 1;
		this.processedEntries += 1;
		// 关键路径:每个处理项持有自己的取消句柄;取消只中止这一次可取消调用。
		const controller = new AbortController();
		this.activeAbort = controller;
		let outcome: ProcessOutcome = 'done';
		try {
			outcome = entry.op === 'delete' ? await this.processDelete(path) : await this.processUpsert(path, entry);
		}
		catch (error) {
			if (isEmbedAbortError(error)) {
				// 关键路径:取消/撤销不是文件故障 —— 不计失败、不消耗重试预算,
				// 保留待处理项由后续恢复继续,已提交记录与未决事务都不动。
				outcome = 'retry';
				this.retain(path);
				devLogger.debug('index', `路径处理已取消,保留待处理项:${path}`);
			}
			else {
				outcome = 'retry';
				this.recordFailure(path);
				devLogger.warn('index', `文件处理失败:${path}`, error);
				this.retainAfterFailure(path, entry);
			}
		}
		finally {
			if (this.activeAbort === controller) this.activeAbort = null;
			this.activeCount = 0;
			entry.active = false;
			if (outcome === 'done') {
				// 关键路径:本次处理没有再失败,重试预算与失败归属都必须清除,否则该路径被永久搁置。
				entry.attempts = 0;
				entry.exhausted = false;
				this.clearFailure(path);
				this.overflowedPaths.delete(path);
			}
			if (!entry.exhausted && !this.pendingPaths.has(path)) {
				// 关键路径:提交后若仍有新事件则保留队列项,只有本次输入 hash 完成才可移除。
				if (this.latestSequence(path) > entry.startedSequence) {
					this.pendingPaths.add(path);
					this.order.push(path);
				}
				else {
					this.queue.delete(path);
				}
			}
			this.phase = this.computePhase();
		}
	}

	/**
	 * 处理一次 upsert:读取 → 读取后核对 → 复用或嵌入 → 推理后核对 → prepare → 提交前核对 → commit。
	 *
	 * @returns `done` 表示该项已被处理(成功、复用、删除或按新输入重排);`retry` 表示已计入失败并保留待重试项。
	 */
	private async processUpsert(path: string, entry: QueueEntry): Promise<ProcessOutcome> {
		// 关键路径:序号在读取之前捕获(至少吸收本项已消费的序号),读取期间到达的新事件会被核对发现。
		const sequenceBefore = Math.max(this.latestSequence(path), entry.startedSequence);
		entry.startedSequence = sequenceBefore;
		const read = await this.readFileSafely(path);
		if (read.kind === 'missing') {
			// 读取时发现已被删除:走 durable 删除事务,不提交旧快照。
			return this.processDelete(path);
		}
		if (read.kind === 'unreadable') {
			this.recordFailure(path);
			devLogger.warn('index', `文件无法读取,按失败处理(不得当作空文件提交):${path}`);
			this.retainAfterFailure(path, entry);
			return 'retry';
		}
		const snapshot: CoordinatorSnapshot = {
			content: read.content,
			inputHash: read.hash,
			sequence: sequenceBefore,
			configFingerprint: this.options.getConfigFingerprint(),
			mtime: read.mtime,
			size: read.size,
		};
		// 读取后、推理前的独立检查点:只比对内存中的事件序号与配置指纹,零额外读盘。
		const afterRead = this.verifyInMemory(path, snapshot);
		if (!afterRead.ok) {
			this.requeueAfterExpiry(path, afterRead.reason);
			return 'done';
		}
		const receipt = await this.options.journal.readReceipt(path);
		if (
			receipt !== null
			&& receipt.state === 'present'
			&& receipt.inputHash === snapshot.inputHash
			&& receipt.configFingerprint === snapshot.configFingerprint
		) {
			// 内容与配置都未变:复用已提交版本,零嵌入。
			this.markVerified(path);
			return 'done';
		}
		// 普通修改:先标记 known-stale,旧版本在检索中立即失效。
		this.markDenied(path, 'known-stale');
		// 关键路径:提示批次活动 — 每个真实完成的批次推进有效进展(单位数按文件重新计数)。
		this.lastBatchDone = 0;
		const blocks = await this.options.processor.prepareBlocks({ path, content: snapshot.content }, {
			signal: this.activeAbort?.signal,
			onBatchComplete: (done, total) => this.recordBatch(done, total),
		});
		const afterEmbed = await this.verifySnapshot(path, snapshot);
		if (!afterEmbed.ok) {
			// 输入在推理期间过期:丢弃这次未提交结果,按当前内容重新排队。
			this.requeueAfterExpiry(path, afterEmbed.reason);
			return 'done';
		}
		const preparation = await this.options.journal.prepare({
			path,
			operation: 'replace',
			inputHash: snapshot.inputHash,
			revision: (receipt?.revision ?? 0) + 1,
			previousCommitId: receipt?.commitId ?? null,
			previousRevision: receipt?.revision ?? 0,
			blocks,
		});
		this.pendingTransactions.add(preparation.transactionId);
		this.unresolved.add(path);
		let committed: CoordinatorCommitResult;
		try {
			const beforeCommit = await this.verifySnapshot(path, snapshot);
			if (!beforeCommit.ok) {
				await this.discardTransaction(preparation.transactionId, path);
				this.requeueAfterExpiry(path, beforeCommit.reason);
				return 'done';
			}
			committed = await this.options.journal.commit(preparation.transactionId);
		}
		finally {
			this.pendingTransactions.delete(preparation.transactionId);
		}
		this.unresolved.delete(path);
		if (!committed.superseded) this.committedThisRound += 1;
		// 关键路径:真实写盘完成的步骤才算有效进展。
		this.progress += 1;
		if (committed.superseded || this.latestSequence(path) > entry.startedSequence) {
			// 提交后仍有新事件(或已有后继版本):保留队列项重新核对,不把旧快照当成最新版。
			this.markDenied(path, 'known-stale');
			this.retain(path);
			return 'done';
		}
		// 成功提交同一路径的新版本:日志会清除该路径的隔离状态,本模块的只读视图同步解除。
		this.journalBlocked.delete(path);
		this.journalTombstoned.delete(path);
		this.markVerified(path);
		return 'done';
	}

	/** 处理一次删除:durable 事务(零块 + 删除凭据);无完成记录时不必写盘。 */
	private async processDelete(path: string): Promise<ProcessOutcome> {
		const receipt = await this.options.journal.readReceipt(path);
		this.markDenied(path, 'deleted');
		this.journalTombstoned.add(path);
		this.journalBlocked.delete(path);
		if (receipt === null || receipt.state !== 'present') return 'done';
		const preparation = await this.options.journal.prepare({
			path,
			operation: 'delete',
			inputHash: null,
			revision: receipt.revision + 1,
			previousCommitId: receipt.commitId,
			previousRevision: receipt.revision,
			blocks: [],
		});
		this.pendingTransactions.add(preparation.transactionId);
		this.unresolved.add(path);
		try {
			await this.options.journal.commit(preparation.transactionId);
			this.committedThisRound += 1;
			this.progress += 1;
		}
		finally {
			this.pendingTransactions.delete(preparation.transactionId);
			this.unresolved.delete(path);
		}
		this.markDenied(path, 'deleted');
		return 'done';
	}

	/** 输入已过期时的重新排队 — 保留后续事件并标记过期。 */
	private requeueAfterExpiry(path: string, reason: CoordinatorExpiryReason): void {
		// 关键路径:过期重排不推进有效进展,也不消耗重试预算(由真实事件与磁盘状态驱动);
		// 单独计数,供外部看护区分「有事件但无进展」与真实推进。
		this.expiredRequeueCount += 1;
		devLogger.debug('index', `路径输入已过期(${reason}),按当前内容重新排队:${path}`);
		this.markDenied(path, 'known-stale');
		this.retain(path);
	}

	/** 丢弃一个未提交事务 — 清理失败时保留恢复依据并计入失败。 */
	private async discardTransaction(transactionId: string, path: string): Promise<void> {
		try {
			await this.options.journal.cleanup(transactionId);
		}
		catch (error) {
			this.recordFailure(path);
			devLogger.warn('index', `丢弃过期事务失败,保留恢复依据:${transactionId}`, error);
		}
	}

	/** 处理失败后的重试保留 — 用尽重试上限后保留队列项但不再自动重试。 */
	private retainAfterFailure(path: string, entry: QueueEntry): void {
		entry.attempts += 1;
		if (entry.attempts >= this.maxReadAttempts) {
			entry.exhausted = true;
			devLogger.warn('index', `路径连续处理失败 ${entry.attempts} 次,保留待处理项:${path}`);
			return;
		}
		this.retain(path);
	}

	// ==================== 核对与读取 ====================

	/**
	 * 内存检查点 — 只比对事件序号与配置指纹,绝不读盘。
	 *
	 * 关键路径:读取后、推理前用它;配合读取前捕获的 `sequenceBefore`,等价于计划原文的「读取前后」核对,
	 * 且不增加整文件读取次数(整文件核对只在推理后与提交前各做一次)。
	 */
	private verifyInMemory(path: string, expected: CoordinatorSnapshot): VerifyResult {
		if (this.latestSequence(path) !== expected.sequence) return { ok: false, reason: 'event' };
		if (this.options.getConfigFingerprint() !== expected.configFingerprint) return { ok: false, reason: 'config' };
		return { ok: true };
	}

	/** 核对内容 + 事件序号 + 配置 — 内存检查点 + 重新读盘核对 hash;推理后与提交前共用。 */
	private async verifySnapshot(path: string, expected: CoordinatorSnapshot): Promise<VerifyResult> {
		const inMemory = this.verifyInMemory(path, expected);
		if (!inMemory.ok) return inMemory;
		const read = await this.readFileSafely(path);
		if (read.kind === 'missing') return { ok: false, reason: 'missing' };
		if (read.kind === 'unreadable') return { ok: false, reason: 'unreadable' };
		if (read.hash !== expected.inputHash) return { ok: false, reason: 'content' };
		return { ok: true };
	}

	/**
	 * 安全读取一个文件。
	 *
	 * 关键路径:只有明确的「文件不存在」才归类为删除;其他读取错误一律归类为「无法读取」,
	 * 由调用方按失败处理 —— 把读取错误当成空文件会让下一轮把清空内容写成合法版本。
	 */
	private async readFileSafely(path: string): Promise<ReadResult> {
		try {
			const content = await this.options.vault.readFile(path);
			const stat = this.options.vault.stat(path);
			return {
				kind: 'content',
				content,
				hash: await sha256(content),
				mtime: stat?.mtime ?? 0,
				size: stat?.size ?? null,
			};
		}
		catch (error) {
			const code = errorCodeOf(error);
			if (code === 'ENOENT') return { kind: 'missing' };
			// 无 errno 的读取失败:只有 stat 明确报告不存在时才按删除处理。
			if (code === undefined && this.options.vault.stat(path) === null) return { kind: 'missing' };
			return { kind: 'unreadable', code: code ?? 'unknown' };
		}
	}

	/** 某路径当前的事件序号。 */
	private latestSequence(path: string): number {
		return this.sequenceByPath.get(path) ?? 0;
	}

	// ==================== 状态 ====================

	/** 该路径当前是否被排除(黑名单)。 */
	private isExcluded(path: string): boolean {
		return this.options.isExcluded?.(path) === true;
	}

	/**
	 * 该路径是否被日志判定为损坏/隔离。
	 *
	 * 关键路径:代际隔离对全代际生效;路径状态(隔离/不可用)按路径生效。两者都是 deny,
	 * 不允许任何调用点绕过(`markVerified` 与 `freshnessOf` 都走这里)。
	 */
	private isJournalDenied(path: string): boolean {
		return this.generationQuarantined || this.journalBlocked.has(path);
	}

	/** 标记为已核实且可检索 — 被排除或被日志判定为损坏/隔离的路径不得标记为已核实。 */
	private markVerified(path: string): void {
		if (this.isExcluded(path)) {
			this.markDenied(path, 'excluded');
			return;
		}
		if (this.isJournalDenied(path)) {
			this.markDenied(path, 'corrupt');
			return;
		}
		this.freshness.set(path, 'verified');
		this.verified.add(path);
		this.unresolved.delete(path);
		// 关键路径:一个路径真正变为可检索(新提交或核对后复用)就是真实完成的一步。
		this.progress += 1;
	}

	/** 标记为不可检索并给出确定原因。 */
	private markDenied(path: string, freshness: FileFreshness): void {
		this.freshness.set(path, freshness);
		this.verified.delete(path);
	}

	// ==================== 失败与计数 ====================

	/** 记录一个路径进入失败状态(按路径去重)。 */
	private recordFailure(path: string): void {
		this.failingPaths.add(path);
	}

	/** 清除一个路径的失败状态 — 只在该路径真的处理成功时调用。 */
	private clearFailure(path: string): void {
		this.failingPaths.delete(path);
	}

	/**
	 * 记录一个真实完成的嵌入批次 — 只接受单调递增、合法的完成数。
	 *
	 * 关键路径:非法或重复的回报不算进展,避免畸形消息把停滞状态续期。
	 */
	private recordBatch(done: number, total: number): void {
		if (!Number.isInteger(done) || !Number.isInteger(total)) return;
		if (total <= 0 || done <= 0 || done > total) return;
		if (done <= this.lastBatchDone) return;
		this.lastBatchDone = done;
		this.progress += 1;
	}

	/** 本轮未清除的失败数。 */
	private failures(): number {
		return this.failingPaths.size + this.unattributedFailures;
	}

	// ==================== 只读日志信号 ====================

	/**
	 * 刷新只读的路径状态 / 代际隔离 / 删除凭据视图。
	 *
	 * 关键路径:只读端口缺失时不做该项核对(装配层负责同源),读取失败时保留上一次的保守视图,
	 * 绝不把「读不到」当成「没有损坏」。本方法不新增日志写入口。
	 */
	private async refreshJournalSignals(): Promise<void> {
		const journal = this.options.journal;
		if (journal.listPathStates !== undefined) {
			try {
				const states = await journal.listPathStates();
				this.journalBlocked.clear();
				for (const state of states) {
					const normalized = normalizePath(state.path);
					if (normalized === null) continue;
					this.journalBlocked.add(normalized);
					this.markDenied(normalized, 'corrupt');
				}
			}
			catch (error) {
				devLogger.warn('index', '读取路径隔离状态失败,保留上一次视图', error);
			}
		}
		if (journal.isGenerationQuarantined !== undefined) {
			try {
				this.generationQuarantined = await journal.isGenerationQuarantined();
			}
			catch (error) {
				devLogger.warn('index', '读取代际隔离状态失败,保留上一次视图', error);
			}
		}
		if (journal.listTombstones !== undefined) {
			try {
				const tombstones = await journal.listTombstones();
				this.journalTombstoned.clear();
				for (const tombstone of tombstones) {
					const normalized = normalizePath(tombstone.path);
					if (normalized === null) continue;
					this.journalTombstoned.add(normalized);
					this.markDenied(normalized, 'deleted');
				}
			}
			catch (error) {
				devLogger.warn('index', '读取删除凭据失败,保留上一次视图', error);
			}
		}
	}

	/** 是否存在「本轮已知且被日志判定为损坏/隔离」的路径 — 这类路径让本轮不能算完成。 */
	private hasBlockedKnownPath(): boolean {
		for (const path of this.journalBlocked) {
			if (this.knownPaths.has(path)) return true;
		}
		return false;
	}

	// ==================== 记忆回收 ====================

	/**
	 * 收敛后回收记忆 — `sequenceByPath` / `knownPaths` / `freshness` 都只保留仍与本轮相关的路径。
	 *
	 * 关键路径:保留依据是「本轮枚举 + 仍有队列项/未决事务/已核实状态」;被删除且已收敛的路径
	 * (其 deny 口径由日志的删除凭据提供)不再占内存,`total` 因此只表达本轮已知文件数。
	 */
	private compactMemory(): void {
		const keep = (path: string): boolean => this.enumeratedPaths.has(path)
			|| this.queue.has(path) || this.pendingPaths.has(path)
			|| this.unresolved.has(path) || this.verified.has(path)
			|| this.overflowedPaths.has(path);
		for (const path of [...this.knownPaths]) {
			if (!keep(path)) this.knownPaths.delete(path);
		}
		for (const path of [...this.sequenceByPath.keys()]) {
			if (!this.knownPaths.has(path)) this.sequenceByPath.delete(path);
		}
		for (const path of [...this.freshness.keys()]) {
			if (!this.knownPaths.has(path)) this.freshness.delete(path);
		}
		for (const path of [...this.overflowedPaths.keys()]) {
			if (!this.knownPaths.has(path)) this.overflowedPaths.delete(path);
		}
	}

	/**
	 * 新一轮重置重试预算并恢复消费 — 上一轮用尽重试的路径必须在本轮重新获得被处理的机会。
	 *
	 * 关键路径:只清标记不够 —— 用尽的队列项不在 `pendingPaths` 里,不重新排队就永远留在 `queued` 里,
	 * 同一实例内 `ready` 仍然不可达。
	 */
	private resetRetryBudget(): void {
		for (const [path, entry] of this.queue) {
			entry.exhausted = false;
			entry.attempts = 0;
			if (entry.active || this.pendingPaths.has(path)) continue;
			this.pendingPaths.add(path);
			this.order.push(path);
		}
		this.compactOrder();
	}

	/** 阶段判据 — ready 只在扫描结束且无待处理失败/事务/事件/溢出/隔离时成立。 */
	private computePhase(): IndexPhase {
		if (this.unloaded || this.aborting) return 'stopping';
		if (this.failed || this.generationQuarantined) return 'failed';
		if (this.paused) return 'paused';
		if (this.isReady()) return 'ready';
		// 关键路径:停滞不是终态 —— 就绪仍由 canMarkReady 唯一裁定,这里只更新阶段显示。
		if (this.stalled) return 'stalled';
		if (!this.scanComplete) return 'scanning';
		if (this.failures() > 0 || this.overflowedPaths.size > 0 || this.hasBlockedKnownPath()) return 'partial-failure';
		return 'processing';
	}
}

// ==================== 工具 ====================

/** 规范化并校验路径;不合法时返回 null(事件一律忽略,不猜测归属)。 */
function normalizePath(path: string): string | null {
	try {
		return assertSafeRecordPath(path);
	}
	catch {
		return null;
	}
}

/** 读取错误里的稳定 errno 码。 */
function errorCodeOf(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' && code.length > 0 ? code : undefined;
}