/**
 * @file src/core/index-search-visibility.ts
 * @description 统一候选可见性判定与关闭自动索引时的只读通道
 * @module core/index-search-visibility
 * @depends 无(来源端口由调用方注入,结构上兼容 T3 的文件日志与后端记录视图)
 *
 * 设计要点:
 * - 唯一判定入口:原始向量候选**必须**在进入融合、重排与工具返回之前经过本模块;
 *   禁止先把片段交给模型再事后过滤最终结果(那样模型已经看过不允许使用的内容)。
 * - 唯一准入依据是「可信已提交记录」:未解决事务路径、删除凭据、路径隔离记录、
 *   当前黑名单、本轮已知过期(`known-stale`)与配置指纹不符一律拒绝。
 * - `searchableFileRecords()` 返回 `null` 是「不可判定」而不是「空集」:本模块按失败关闭
 *   (deny)处理,并把 `unjudgeable` 状态保留给调用方,使「记录端口未装配」不能被伪装成
 *   「已核对的空索引」(spec A11 要求关闭自动索引时不假装已核对)。
 * - 只读通道(`ReadOnlySearchView`)不取写所有权锁、不写盘、不嵌入:只读消费可信完成记录,
 *   新鲜度一律 `unknown`,不声称已核对当前 Vault。
 * - 推荐的只读装配是 `createReadOnlyOwnerGuard()` + `createJournalVisibilitySource(journal)`:
 *   这条路径**完全不依赖 `PersistentIndexBackend.fileRecords`**,因此不会因为后端端口未注入
 *   而把「不可判定」伪装成「已核对的空索引」。`fileRecords` 只服务于部分可用性/完整性判定,
 *   不是可见性门的装配前提。
 * - 来源端口给出两个显式信号,避免只读视图把「不确定」显示成「0 篇可检索」:
 *   `listPendingPaths()`(已 prepared、未写完成记录的未决事务路径)与
 *   `countConfigMismatchedRecords()`(因配置代际变化作废的记录数)。
 *   端口未提供时按「无此信号」处理,端口提供但读取失败一律失败关闭。
 */

// ==================== 新鲜度词汇 ====================

/**
 * 文件新鲜度 — 检索可见性与状态展示共用的一份口径。
 *
 * 关键路径:
 * - `unknown` 表示「未在本轮核对」,不等于过期:关闭自动索引时可信完成记录就是这种状态,
 *   准入策略决定它能否进入检索(见 {@link UNVERIFIED_ADMISSION_POLICIES})。
 * - `known-stale` 表示「已确认磁盘内容与已提交版本不同」,必须过滤(普通修改的最小标记)。
 * - `deleted` / `excluded` / `corrupt` 是立即 deny 的三类:删除、黑名单、损坏或隔离。
 * - `unresolved-transaction` 表示该路径存在未结算事务,禁止作为检索依据。
 */
export const FILE_FRESHNESS_STATES = [
	'unknown',
	'verified',
	'known-stale',
	'deleted',
	'excluded',
	'corrupt',
	'unresolved-transaction',
] as const;

/** 文件新鲜度。 */
export type FileFreshness = (typeof FILE_FRESHNESS_STATES)[number];

/** 未核对候选的准入策略 — 两种口径都显式声明,避免静默扩大或缩小检索面。 */
export const UNVERIFIED_ADMISSION_POLICIES = ['admit-trusted', 'deny'] as const;

/** 未核对候选的准入策略。 */
export type UnverifiedAdmissionPolicy = (typeof UNVERIFIED_ADMISSION_POLICIES)[number];

/** 拒绝原因 — 稳定字符串,供 T7 映射为用户可见状态,不在此处生成文案。 */
export const SEARCH_VISIBILITY_DENY_REASONS = [
	'unjudgeable',
	'not-committed',
	'deleted',
	'blocked',
	'excluded',
	'known-stale',
	'unresolved-transaction',
	'config-mismatch',
	'missing',
	'unverified',
] as const;

/** 拒绝原因。 */
export type SearchVisibilityDenyReason = (typeof SEARCH_VISIBILITY_DENY_REASONS)[number];

/**
 * 记录集与当前配置的关系 — 让「配置已变」成为可判定信号,而不是「已知空集」。
 *
 * 关键路径:`current` 表示没有配置不符记录;`mismatch` 表示存在被丢弃的旧配置记录;
 * `unknown` 表示该信号读取失败 —— 后两者都必须失败关闭(按 `config-mismatch` 拒绝)。
 */
export const RECORDS_CONFIG_STATES = ['current', 'mismatch', 'unknown'] as const;

/** 记录集与当前配置的关系。 */
export type RecordsConfigState = (typeof RECORDS_CONFIG_STATES)[number];

// ==================== 记录来源 ====================

/**
 * 可见性判定消费的完成记录视图 — 与 T3/T2 的 `CommittedFileRecord` / `FileCommit` 结构兼容。
 *
 * 关键路径:`configFingerprint` 是可选的:日志侧已在读取时按当前配置指纹校验并跳过不符记录,
 * 提供该字段的端口(如 `IndexFileJournal.listSearchableReceipts`)让本模块能再做一次显式核对。
 */
export interface SearchVisibilityRecord {
	/** vault 规范化相对路径。 */
	path: string;
	/** 版本状态。 */
	state: 'present' | 'deleted';
	/** 同路径单调递增版本号。 */
	revision: number;
	/** 输入内容 hash;删除记录为 null。 */
	inputHash: string | null;
	/** 块数量。 */
	chunkCount: number;
	/** 生成该版本时的配置指纹;端口未提供时为 undefined。 */
	configFingerprint?: string;
}

/** 可检索记录视图。 */
export interface SearchVisibilityRecords {
	/** 可检索文件总数。 */
	total: number;
	/** 可检索完成记录。 */
	records: readonly SearchVisibilityRecord[];
}

/** 路径隔离/不可用状态 — 与 T3 的 `JournalPathState` 结构兼容。 */
export interface BlockedPathState {
	/** vault 规范化相对路径。 */
	path: string;
	/** 状态种类:`quarantined` 坏日志隔离,`unavailable` 磁盘存在未记账提交。 */
	kind: 'quarantined' | 'unavailable';
	/** 状态原因(日志侧稳定字符串)。 */
	reason: string;
}

/**
 * 可见性记录来源 — 只读端口。
 *
 * 关键路径:本模块只调用这些只读方法,不构造写所有权、不调用 `prepare/commit/cleanup`;
 * `searchableFileRecords` 返回 `null` 与返回空集是两件不同的事(见模块头注释)。
 */
export interface SearchVisibilitySource {
	/** 可检索完成记录视图;`null` 表示不可判定,不得当作空集。 */
	searchableFileRecords(): Promise<SearchVisibilityRecords | null>;
	/** 删除凭据 — 与 `searchableFileRecords` 的 present 集互斥。 */
	listTombstones(): Promise<readonly SearchVisibilityRecord[]>;
	/**
	 * 未决事务声明的目标路径 — 只读枚举,不要求写所有权。
	 *
	 * 关键路径:关闭自动索引时 `recover()` 不会运行,「向量已替换、完成记录未落盘」的路径
	 * 不会留下任何路径状态记录;缺失该信号又未显式传入 `unresolvedPaths` 时,
	 * 旧 present 记录会被误判为可检索。端口提供但读取失败按不可判定处理。
	 */
	listPendingPaths?(): Promise<readonly string[]>;
	/** 因配置指纹不符而被丢弃的记录数;缺失时不做该项核对。 */
	countConfigMismatchedRecords?(): Promise<number>;
	/** 路径隔离/不可用状态;缺失时不做该项核对。 */
	listPathStates?(): Promise<readonly BlockedPathState[]>;
	/** 代际级隔离;缺失时按未隔离处理(装配层负责保证同源)。 */
	isGenerationQuarantined?(): Promise<boolean>;
}

/** T3 日志的只读端口 — `IndexFileJournal` 结构上直接满足。 */
export interface ReadOnlyJournalPort {
	/** 可检索的 present 完成记录(已排除 tombstone 与路径状态)。 */
	listSearchableReceipts(): Promise<readonly SearchVisibilityRecord[]>;
	/** 删除凭据。 */
	listTombstones(): Promise<readonly SearchVisibilityRecord[]>;
	/** 未决事务声明的目标路径(纯读,不要求写所有权)。 */
	listPendingPaths?(): Promise<readonly string[]>;
	/** 因配置指纹不符而被丢弃的完成记录数(纯读)。 */
	countConfigMismatchedReceipts?(): Promise<number>;
	/** 路径状态记录。 */
	listPathStates?(): Promise<readonly BlockedPathState[]>;
	/** 代际是否被隔离。 */
	isGenerationQuarantined?(): Promise<boolean>;
}

/**
 * 用 T3 日志的只读入口组装可见性来源 — **只读装配的默认推荐路径**。
 *
 * 关键路径:日志的只读入口不要求写所有权(见 `IndexFileJournal` 只读 API 注释),
 * 因此本函数可以在不取锁、不写盘的装配下使用;它与 `PersistentIndexBackend.fileRecords`
 * 完全无关 —— 只读可见性不依赖后端记录端口是否注入。`journal` 提供的每个可选只读入口
 * (未决路径、配置作废计数、路径状态、代际隔离)都会被原样接线,不再让调用方手工补齐。
 *
 * @param journal - 日志的只读端口(`IndexFileJournal` 实例结构兼容)。
 * @returns 可见性记录来源。
 */
export function createJournalVisibilitySource(journal: ReadOnlyJournalPort): SearchVisibilitySource {
	const source: SearchVisibilitySource = {
		searchableFileRecords: () => journal.listSearchableReceipts().then((records) => ({
			total: records.length,
			records,
		})),
		listTombstones: () => journal.listTombstones(),
	};
	if (journal.listPendingPaths !== undefined) {
		source.listPendingPaths = () => journal.listPendingPaths!();
	}
	if (journal.countConfigMismatchedReceipts !== undefined) {
		source.countConfigMismatchedRecords = () => journal.countConfigMismatchedReceipts!();
	}
	if (journal.listPathStates !== undefined) {
		source.listPathStates = () => journal.listPathStates!();
	}
	if (journal.isGenerationQuarantined !== undefined) {
		source.isGenerationQuarantined = () => journal.isGenerationQuarantined!();
	}
	return source;
}

/**
 * 只读装配用的写所有权哨兵 — 任何写入口调用都会失败,且不创建 `owner.lock`。
 *
 * 关键路径:`IndexWriteOwner` 的唯一工厂 `acquire()` 必定写锁文件,因此关闭自动索引时
 * 不能通过它获得只读能力;该哨兵与 `JournalWriteOwner` 结构一致,只用于构造只读日志实例。
 * 它**不做任何 IO**,因此构造日志本身不产生磁盘写入。
 */
export interface ReadOnlyOwnerGuard {
	/** 固定为 0 — 只读装配没有可用的写 epoch。 */
	readonly epoch: number;
	/** 只读装配下任何写所有权断言都失败。 */
	assertWritable(): void;
	/** 只读装配下任何在途提交登记都失败。 */
	beginCommit(): { settle(): void };
}

/**
 * 创建只读装配用的写所有权哨兵。
 *
 * @returns 结构上与日志写门面兼容、但拒绝一切写操作的哨兵。
 */
export function createReadOnlyOwnerGuard(): ReadOnlyOwnerGuard {
	return {
		epoch: 0,
		assertWritable(): void {
			throw new Error('只读装配不得获取写所有权(未建立 owner 锁)');
		},
		beginCommit(): never {
			throw new Error('只读装配不得登记在途提交(未建立 owner 锁)');
		},
	};
}

// ==================== 快照 ====================

/** 一次可见性快照 — 判定与展示共享同一次读取结果。 */
export interface SearchVisibilitySnapshot {
	/** `known` 表示记录已判定(空集也算判定);`unjudgeable` 表示不可判定。 */
	recordsKind: 'known' | 'unjudgeable';
	/** 代际级隔离是否生效。 */
	generationQuarantined: boolean;
	/** 生成快照时的配置指纹。 */
	configFingerprint: string;
	/** 记录集与当前配置的关系 — `mismatch`/`unknown` 时不得显示为「0 篇可检索」。 */
	recordsConfig: RecordsConfigState;
	/** 因配置指纹不符被丢弃的完成记录数(仅统计配置不符,不含损坏/代际不符)。 */
	discardedByConfig: number;
	/** 可信可检索记录,按路径索引。 */
	visible: ReadonlyMap<string, SearchVisibilityRecord>;
	/** 删除凭据路径集合。 */
	tombstones: ReadonlySet<string>;
	/** 路径隔离/不可用状态,按路径索引。 */
	blocked: ReadonlyMap<string, BlockedPathState>;
	/** 未决事务路径(来源端口枚举 ∪ 调用方传入);这些路径一律不得作为检索依据。 */
	unresolvedPaths: ReadonlySet<string>;
	/** 快照时间戳(毫秒)。 */
	capturedAt: number;
}

/** 快照捕获选项。 */
export interface CaptureSearchVisibilitySnapshotOptions {
	/** 记录来源(只读)。 */
	source: SearchVisibilitySource;
	/** 当前配置指纹。 */
	configFingerprint: string;
	/** 调用方已知的未解决事务路径;与来源端口枚举结果取并集。 */
	unresolvedPaths?: ReadonlySet<string>;
	/** 时间来源(测试用);默认 `Date.now`。 */
	now?: () => number;
}

/**
 * 捕获一次可见性快照 — 只读,不写盘、不取锁。
 *
 * 关键路径:任何**必读**信号读取失败都归入 `unjudgeable`,不降级成「空集已判定」——
 * 记录视图、删除凭据、路径状态、未决事务路径都属此类;配置作废计数读取失败则把
 * `recordsConfig` 置为 `unknown` 并同样不可判定。只有端口**未提供**时才按「无此信号」处理,
 * 这不会凭空收紧或放宽检索面。
 *
 * @param options - 记录来源、当前配置指纹、已知识别的未解决路径与可选时间来源。
 * @returns 可见性快照。
 */
export async function captureSearchVisibilitySnapshot(
	options: CaptureSearchVisibilitySnapshotOptions,
): Promise<SearchVisibilitySnapshot> {
	const now = options.now ?? Date.now;
	const visible = new Map<string, SearchVisibilityRecord>();
	let recordsKind: 'known' | 'unjudgeable' = 'known';
	let recordsConfig: RecordsConfigState = 'current';
	let discardedByConfig = 0;
	try {
		const view = await options.source.searchableFileRecords();
		if (view === null) {
			recordsKind = 'unjudgeable';
		}
		else {
			for (const record of view.records) {
				// 关键路径:端口语义是 present-only;仍按 state 过滤,防止 tombstone 混入准入集。
				if (record.state === 'present') visible.set(record.path, record);
			}
		}
	}
	catch {
		// 读取失败与端口缺失同口径:不可判定,绝不当作空集。
		recordsKind = 'unjudgeable';
		visible.clear();
	}
	const tombstones = new Set<string>();
	try {
		for (const tombstone of await options.source.listTombstones()) tombstones.add(tombstone.path);
	}
	catch {
		// 修复:删除凭据读取失败不能按「无删除凭据」放行 —— 无法证明任何路径未被删除时,
		// 记录集不可判定(失败关闭),否则已删除路径可能凭旧 present 记录继续可见。
		recordsKind = 'unjudgeable';
		tombstones.clear();
	}
	const blocked = new Map<string, BlockedPathState>();
	if (options.source.listPathStates !== undefined) {
		try {
			for (const state of await options.source.listPathStates()) blocked.set(state.path, state);
		}
		catch {
			// 修复:路径状态不可读时无法排除隔离/不可用路径,同样按不可判定处理。
			recordsKind = 'unjudgeable';
			blocked.clear();
		}
	}
	const unresolvedPaths = new Set<string>(options.unresolvedPaths ?? []);
	if (options.source.listPendingPaths !== undefined) {
		try {
			for (const path of await options.source.listPendingPaths()) unresolvedPaths.add(path);
		}
		catch {
			// 未决事务不可枚举 → 无法证明任何路径不在途 → 不可判定(失败关闭)。
			recordsKind = 'unjudgeable';
		}
	}
	if (options.source.countConfigMismatchedRecords !== undefined) {
		try {
			const discarded = await options.source.countConfigMismatchedRecords();
			if (!Number.isFinite(discarded) || discarded < 0) {
				recordsConfig = 'unknown';
			}
			else {
				discardedByConfig = discarded;
				if (discarded > 0) recordsConfig = 'mismatch';
			}
		}
		catch {
			// 配置信号不可读 → 不得声称「记录集适用于当前配置」;失败关闭。
			recordsConfig = 'unknown';
			recordsKind = 'unjudgeable';
		}
	}
	let generationQuarantined = false;
	if (options.source.isGenerationQuarantined !== undefined) {
		try {
			generationQuarantined = await options.source.isGenerationQuarantined();
		}
		catch {
			// 隔离状态不可读时失败关闭:宁可显示不可检索,也不假设未隔离。
			generationQuarantined = true;
		}
	}
	return {
		recordsKind,
		generationQuarantined,
		configFingerprint: options.configFingerprint,
		recordsConfig,
		discardedByConfig,
		visible,
		tombstones,
		blocked,
		unresolvedPaths,
		capturedAt: now(),
	};
}

// ==================== 判定 ====================

/** 单条判定结论。 */
export type SearchVisibilityVerdict =
	| {
			/** 可进入融合/重排。 */
			visible: true;
			/** 候选路径。 */
			path: string;
			/** 该候选的新鲜度 — `unknown` 表示未在本轮核对,不得对外声称已核对。 */
			freshness: FileFreshness;
			/** 准入依据的完成记录。 */
			record: SearchVisibilityRecord;
	  }
	| {
			/** 被拒绝。 */
			visible: false;
			/** 候选路径。 */
			path: string;
			/** 稳定拒绝原因。 */
			reason: SearchVisibilityDenyReason;
			/** 拒绝时的新鲜度。 */
			freshness: FileFreshness;
	  };

/** 一次过滤中被拒绝的候选。 */
export interface SearchVisibilityDenial {
	/** 候选路径。 */
	path: string;
	/** 稳定拒绝原因。 */
	reason: SearchVisibilityDenyReason;
}

/** 过滤结果。 */
export interface SearchVisibilityFilterResult<T> {
	/** 可进入融合/重排的候选(保持原顺序)。 */
	visible: T[];
	/** 被过滤的候选与原因。 */
	denied: SearchVisibilityDenial[];
}

/** 门控选项。 */
export interface SearchVisibilityGateOptions {
	/** 当前可见性快照。 */
	snapshot: SearchVisibilitySnapshot;
	/** 未核对候选准入策略 — 必须显式选择。 */
	unverified: UnverifiedAdmissionPolicy;
	/** 当前配置指纹;与快照不一致时快照作废(宁可拒绝)。 */
	configFingerprint: string;
	/** 运行期新鲜度视图;返回 `undefined` 时按 `unknown`。 */
	freshnessOf?: (path: string) => FileFreshness | undefined;
	/** 未解决事务路径;只读模式下无法枚举时为 undefined。 */
	unresolvedPaths?: ReadonlySet<string>;
	/** 当前黑名单判定 — 黑名单变化立即收回可见性。 */
	isExcluded?: (path: string) => boolean;
	/** 候选存在性核对 — 每次检索只核验候选,不扫描全库。 */
	exists?: (path: string) => boolean | Promise<boolean>;
}

/**
 * 候选可见性门 — 原始向量候选进入融合/重排前的唯一闸门。
 *
 * 关键路径:判定顺序固定为「快照配置指纹 → 黑名单 → 未解决事务 → 隔离 → 删除凭据 →
 * 不可判定/记录集配置 → 记录 → 新鲜度 → 存在性」,
 * 使最确定的拒绝原因先返回,避免同一候选因读取顺序不同给出不同结论。
 * 未解决事务路径取「快照内(来源端口枚举)∪ 构造时传入」两处并集:
 * 只读模式靠前者,运行期已知在途集合靠后者。
 *
 * @example
 *   const gate = new SearchVisibilityGate({ snapshot, unverified: 'admit-trusted', configFingerprint });
 *   const { visible } = await gate.filter(rawCandidates);
 */
export class SearchVisibilityGate {
	private readonly options: SearchVisibilityGateOptions;

	/**
	 * @param options - 快照、准入策略、配置指纹与可选运行期视图。
	 */
	constructor(options: SearchVisibilityGateOptions) {
		if (options.unverified !== 'admit-trusted' && options.unverified !== 'deny') {
			throw new Error('SearchVisibilityGate 需要显式的未核对候选准入策略');
		}
		this.options = options;
	}

	/** 当前快照 — 供状态展示读取「记录是否可判定」。 */
	snapshot(): SearchVisibilitySnapshot {
		return this.options.snapshot;
	}

	/**
	 * 判定单个候选。
	 *
	 * @param path - 候选路径。
	 * @returns 可见性结论;拒绝时给出稳定原因。
	 */
	async decide(path: string): Promise<SearchVisibilityVerdict> {
		const snapshot = this.options.snapshot;
		const freshness = this.freshnessOf(path);
		// 关键路径:快照是按配置指纹生成的;调用方换配置后必须重新捕获,这里失败关闭。
		if (snapshot.configFingerprint !== this.options.configFingerprint) {
			return { visible: false, path, reason: 'config-mismatch', freshness };
		}
		if (this.options.isExcluded?.(path) === true) {
			return { visible: false, path, reason: 'excluded', freshness: 'excluded' };
		}
		// 关键路径:未解决事务路径有两个来源 —— 快照(只读来源端口枚举)与运行期已知集合。
		if (snapshot.unresolvedPaths.has(path) || this.options.unresolvedPaths?.has(path) === true) {
			return { visible: false, path, reason: 'unresolved-transaction', freshness: 'unresolved-transaction' };
		}
		if (snapshot.blocked.has(path)) {
			return { visible: false, path, reason: 'blocked', freshness: 'corrupt' };
		}
		if (snapshot.generationQuarantined) {
			// 关键路径:代际隔离是「无法归属的坏日志」结论,整代际停止检索。
			return { visible: false, path, reason: 'blocked', freshness: 'corrupt' };
		}
		if (freshness === 'deleted' || snapshot.tombstones.has(path)) {
			return { visible: false, path, reason: 'deleted', freshness: 'deleted' };
		}
		if (freshness === 'excluded') {
			return { visible: false, path, reason: 'excluded', freshness };
		}
		if (freshness === 'corrupt') {
			return { visible: false, path, reason: 'blocked', freshness };
		}
		if (snapshot.recordsKind === 'unjudgeable') {
			return { visible: false, path, reason: 'unjudgeable', freshness };
		}
		// 关键路径:记录集里有因配置代际变化而作废的记录时,空的可检索集不是「已核对的空索引」;
		// 失败关闭并把「配置已变/不可判定」作为稳定原因交给调用方展示(而不是 not-committed)。
		if (snapshot.recordsConfig !== 'current') {
			return { visible: false, path, reason: 'config-mismatch', freshness };
		}
		const record = snapshot.visible.get(path);
		if (record === undefined || record.state !== 'present') {
			return { visible: false, path, reason: 'not-committed', freshness };
		}
		if (record.configFingerprint !== undefined && record.configFingerprint !== this.options.configFingerprint) {
			return { visible: false, path, reason: 'config-mismatch', freshness };
		}
		if (freshness === 'known-stale') {
			return { visible: false, path, reason: 'known-stale', freshness };
		}
		if (freshness === 'unknown' && this.options.unverified === 'deny') {
			return { visible: false, path, reason: 'unverified', freshness };
		}
		if (freshness === 'verified' || freshness === 'unknown') {
			if (this.options.exists !== undefined) {
				const exists = await this.options.exists(path);
				if (!exists) return { visible: false, path, reason: 'missing', freshness: 'unknown' };
			}
			return { visible: true, path, freshness, record };
		}
		// 其余新鲜度(含运行期视图给出的未知取值)按拒绝处理。
		return { visible: false, path, reason: 'unverified', freshness };
	}

	/**
	 * 过滤候选 — 在融合/重排之前调用,保持原顺序与原始对象。
	 *
	 * 关键路径:判定并发执行而不是逐个 await —— 调用方一旦注入会读盘的 `exists`,
	 * 串行判定会让 N 个候选变成 N 次串行 IO;`decide` 本身只读快照与注入的视图,不改状态。
	 * 结论按候选下标回填,输出顺序与输入一致。
	 *
	 * @param candidates - 原始向量候选(至少含 `path`)。
	 * @returns 可见候选与被拒绝候选的原因。
	 */
	async filter<T extends { path: string }>(
		candidates: readonly T[],
	): Promise<SearchVisibilityFilterResult<T>> {
		const verdicts = await Promise.all(candidates.map((candidate) => this.decide(candidate.path)));
		const visible: T[] = [];
		const denied: SearchVisibilityDenial[] = [];
		candidates.forEach((candidate, index) => {
			const verdict = verdicts[index]!;
			if (verdict.visible) visible.push(candidate);
			else denied.push({ path: candidate.path, reason: verdict.reason });
		});
		return { visible, denied };
	}

	private freshnessOf(path: string): FileFreshness {
		return this.options.freshnessOf?.(path) ?? 'unknown';
	}
}

// ==================== 只读通道 ====================

/** 只读视图的默认快照最大有效期 — 超期后一律按不可判定处理(失败关闭)。 */
export const DEFAULT_READ_ONLY_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/** 只读检索视图选项。 */
export interface ReadOnlySearchViewOptions {
	/** 记录来源(只读);推荐 `createJournalVisibilitySource(journal)`。 */
	source: SearchVisibilitySource;
	/** 当前配置指纹。 */
	configFingerprint: string;
	/** 当前黑名单判定。 */
	isExcluded?: (path: string) => boolean;
	/**
	 * 候选存在性核对。
	 *
	 * 关键路径:未提供时不额外过滤候选,但新鲜度仍是 `unknown` —— 装配层必须尽快注入
	 * 真实存在性核对,否则只能消费「历史上提交过」的记录,不能确认当前文件仍在。
	 */
	exists?: (path: string) => boolean | Promise<boolean>;
	/**
	 * 快照最大有效期(毫秒);缺省 {@link DEFAULT_READ_ONLY_SNAPSHOT_MAX_AGE_MS}。
	 *
	 * 关键路径:只读通道没有写路径监听,录制到的「已变更」路径也未必被消费;
	 * 久未刷新且未注入 `exists` 时,只读视图会无限期把已删除文件判为可见。
	 * 超期后本视图按不可判定处理,直到调用方 `refresh()`。
	 */
	maxSnapshotAgeMs?: number;
	/** 时间来源(测试用);默认 `Date.now`。 */
	now?: () => number;
}

/**
 * 关闭自动索引时的只读检索视图 — 不取锁、不写盘、不嵌入。
 *
 * 关键路径:
 * - 只消费可信已提交记录;未解决事务路径(来源端口枚举 ∪ 调用方传入)、删除凭据、
 *   隔离路径与未提交路径全部过滤;
 * - 新鲜度一律 `unknown`,不声称已核对当前 Vault(spec A11);
 * - 未核对候选按 `admit-trusted` 准入,因为可信完成记录本身就是唯一准入依据;
 * - 配置指纹可更新:配置变化后未重新 `refresh()` 前,所有候选按 `config-mismatch` 拒绝;
 * - 快照有最大有效期,超期按 `unjudgeable` 拒绝(失败关闭);
 * - 不提供任何写入口:需要恢复写事务时必须由用户启用索引后另建可写装配。
 *
 * @example
 *   const view = new ReadOnlySearchView({ source: createJournalVisibilitySource(journal), configFingerprint });
 *   await view.refresh();
 *   const { visible } = await view.filterCandidates(candidates);
 */
export class ReadOnlySearchView {
	private readonly options: ReadOnlySearchViewOptions;
	private readonly now: () => number;
	private readonly maxSnapshotAgeMs: number;
	/** 当前配置指纹 — 与快照内记录分开保存,配置变化后两者会短暂不一致。 */
	private currentFingerprint: string;
	/** 最近一次显式传入的未解决事务集合 — 缺省 `refresh()` 时沿用,传空集即清空。 */
	private callerUnresolvedPaths: ReadonlySet<string> = new Set();
	private gate: SearchVisibilityGate;

	/**
	 * @param options - 只读记录来源、配置指纹与可选黑名单/存在性核对、快照有效期。
	 * @throws {Error} 配置指纹为空或快照最大有效期非正数。
	 */
	constructor(options: ReadOnlySearchViewOptions) {
		if (options.configFingerprint.length === 0) {
			throw new Error('ReadOnlySearchView 需要非空配置指纹');
		}
		const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? DEFAULT_READ_ONLY_SNAPSHOT_MAX_AGE_MS;
		if (!Number.isFinite(maxSnapshotAgeMs) || maxSnapshotAgeMs <= 0) {
			throw new Error('ReadOnlySearchView 需要正的快照最大有效期(毫秒)');
		}
		this.options = options;
		this.now = options.now ?? Date.now;
		this.maxSnapshotAgeMs = maxSnapshotAgeMs;
		this.currentFingerprint = options.configFingerprint;
		this.gate = this.buildGate(emptySnapshot(this.currentFingerprint, this.now()));
	}

	/** 当前配置指纹 — 可能与最近一次快照记录的指纹不同(配置已变但尚未刷新)。 */
	configFingerprint(): string {
		return this.currentFingerprint;
	}

	/**
	 * 更新配置指纹 — 配置变化后必须调用,否则「快照指纹 ≠ 当前指纹」分支永远不成立。
	 *
	 * 关键路径:更新后沿用旧快照(其指纹仍是旧值),所有候选立即按 `config-mismatch`
	 * 拒绝(失败关闭),直到调用方 `refresh()` 重新捕获。
	 *
	 * @param fingerprint - 新的非空配置指纹。
	 */
	setConfigFingerprint(fingerprint: string): void {
		if (fingerprint.length === 0) {
			throw new Error('ReadOnlySearchView 需要非空配置指纹');
		}
		if (fingerprint === this.currentFingerprint) return;
		this.currentFingerprint = fingerprint;
		this.gate = this.buildGate(this.gate.snapshot());
	}

	/**
	 * 重新读取可信完成记录 — 只读,不写盘、不取锁。
	 *
	 * 关键路径:未传入 `unresolvedPaths` 时沿用上一次显式传入的集合 —— 先传后不传不会
	 * 丢掉在途过滤;来源端口枚举的未决路径每轮重新读取,不累积到本视图里(否则事务提交后
	 * 该路径会被永久拒绝)。
	 *
	 * @param unresolvedPaths - 运行期已知的未解决事务路径;省略时沿用上次显式传入的集合。
	 * @returns 最新可见性快照。
	 */
	async refresh(unresolvedPaths?: ReadonlySet<string>): Promise<SearchVisibilitySnapshot> {
		if (unresolvedPaths !== undefined) this.callerUnresolvedPaths = new Set(unresolvedPaths);
		const snapshot = await captureSearchVisibilitySnapshot({
			source: this.options.source,
			configFingerprint: this.currentFingerprint,
			...(this.callerUnresolvedPaths.size === 0 ? {} : { unresolvedPaths: this.callerUnresolvedPaths }),
			now: this.now,
		});
		this.gate = this.buildGate(snapshot);
		return snapshot;
	}

	/** 当前快照 — 供状态展示读取「记录是否可判定」。 */
	snapshot(): SearchVisibilitySnapshot {
		return this.gate.snapshot();
	}

	/** 快照是否已超过最大有效期 — 超期后本视图一律按不可判定处理。 */
	snapshotExpired(): boolean {
		return this.now() - this.gate.snapshot().capturedAt > this.maxSnapshotAgeMs;
	}

	/** 记录是否可判定 — `unjudgeable` 时调用方必须显示「状态未知」而不是「0 篇可检索」。 */
	recordsKind(): 'known' | 'unjudgeable' {
		if (this.snapshotExpired()) return 'unjudgeable';
		return this.gate.snapshot().recordsKind;
	}

	/** 记录集与当前配置的关系 — `mismatch`/`unknown` 时不得显示为「0 篇可检索」。 */
	recordsConfig(): RecordsConfigState {
		return this.gate.snapshot().recordsConfig;
	}

	/** 代际是否被隔离。 */
	generationQuarantined(): boolean {
		return this.gate.snapshot().generationQuarantined;
	}

	/**
	 * 候选新鲜度 — 只读模式下可信记录一律 `unknown`(不声称已核对)。
	 *
	 * @param path - 候选路径。
	 * @returns 新鲜度;删除/隔离/黑名单路径给出对应的确定状态。
	 */
	freshnessOf(path: string): FileFreshness {
		const snapshot = this.gate.snapshot();
		if (this.options.isExcluded?.(path) === true) return 'excluded';
		if (snapshot.tombstones.has(path)) return 'deleted';
		if (snapshot.blocked.has(path) || snapshot.generationQuarantined) return 'corrupt';
		return 'unknown';
	}

	/**
	 * 过滤候选 — 在融合/重排之前调用。
	 *
	 * @param candidates - 原始向量候选(至少含 `path`)。
	 * @returns 可见候选与被拒绝候选的原因;快照超期时全部拒绝并给出 `unjudgeable`。
	 */
	async filterCandidates<T extends { path: string }>(
		candidates: readonly T[],
	): Promise<SearchVisibilityFilterResult<T>> {
		if (this.snapshotExpired()) {
			// 关键路径:超期快照不能继续证明文件仍存在,失败关闭。
			return {
				visible: [],
				denied: candidates.map((candidate) => ({ path: candidate.path, reason: 'unjudgeable' as const })),
			};
		}
		return this.gate.filter(candidates);
	}

	/**
	 * 判定单个候选。
	 *
	 * @param path - 候选路径。
	 * @returns 可见性结论;快照超期时为 `unjudgeable`。
	 */
	async decide(path: string): Promise<SearchVisibilityVerdict> {
		if (this.snapshotExpired()) {
			return { visible: false, path, reason: 'unjudgeable', freshness: this.freshnessOf(path) };
		}
		return this.gate.decide(path);
	}

	/** 用当前指纹、黑名单、存在性与调用方未解决集合装配门。 */
	private buildGate(snapshot: SearchVisibilitySnapshot): SearchVisibilityGate {
		return new SearchVisibilityGate({
			snapshot,
			unverified: 'admit-trusted',
			configFingerprint: this.currentFingerprint,
			...(this.options.isExcluded === undefined ? {} : { isExcluded: this.options.isExcluded }),
			...(this.options.exists === undefined ? {} : { exists: this.options.exists }),
			...(this.callerUnresolvedPaths.size === 0 ? {} : { unresolvedPaths: this.callerUnresolvedPaths }),
		});
	}
}

/** 空快照 — 只读视图构造后未 `refresh()` 时的保守初值。 */
function emptySnapshot(configFingerprint: string, capturedAt: number): SearchVisibilitySnapshot {
	return {
		// 关键路径:未读取前是「不可判定」而不是「空集」,避免构造即被当成已核对。
		recordsKind: 'unjudgeable',
		generationQuarantined: false,
		configFingerprint,
		// 关键路径:未读取前不声明记录集配置状态,避免把未知说成「与当前配置一致」。
		recordsConfig: 'unknown',
		discardedByConfig: 0,
		visible: new Map(),
		tombstones: new Set(),
		blocked: new Map(),
		unresolvedPaths: new Set(),
		capturedAt,
	};
}