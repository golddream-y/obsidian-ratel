/**
 * @file src/core/index-file-journal.ts
 * @description 文件日志与恢复状态机 — 待提交事务(prepared 分片)、文件完成记录与按磁盘核对的重放/清理决策
 * @module core/index-file-journal
 * @depends node:fs, node:path, node:crypto, core/index-persistence-types, adapters/atomic-index-storage,
 *   adapters/vector-vectra
 *
 * 设计要点:
 * - 目录约定:`files/<pathHash>.json`(完成记录)、`pending/<transactionId>/`(分片与 `prepared.json`)、
 *   `quarantine/`(路径不可用/隔离记录与保留的旧事务)。`pathHash` 是规范化相对路径的 SHA-256,
 *   记录内保留原路径并校验匹配;所有拼接出的日志路径都先过 T1 的 `assertPathWithinRoot`,
 *   禁止用未校验的日志路径访问任意文件。
 * - 写入顺序:分片全部完整并回读核对后才原子写 `prepared.json`;`commit` 先替换目标向量
 *   (`replaceFile` 把 `next.commitId` 写进每个块),再原子写完成记录,最后清理事务目录。
 *   完成记录写完后用 `flushPath` 强制落盘,不依赖进程退出回写。
 * - 恢复只做「校验事务与磁盘 → 补写记录 / 重放 / 清理」,从不调用嵌入模型;
 *   重放需要 `currentInputs` 证明确实是当前内容,过期事务绝不发布为当前版本。
 * - 零块与删除事务的判据是「目标路径无块 + prepared + 完成记录共同证明」,
 *   不以「查到块」作为唯一恢复依据;块集合 hash 覆盖有序块 ID、版本元数据与向量值。
 * - 「空事务」判据是「无 `prepared.json` 且零可解析分片」:既无内容也无归属依据,按无内容直接清理,
 *   **不**升级为代际隔离。只有「有记录但不可信」或「解析出内容却无法归属」才隔离代际 —
 *   否则 `prepare` 建目录与写 `prepared.json` 之间的崩溃窗口会让整个代际永久不可写。
 * - 代际隔离只能由显式确认的 {@link IndexFileJournal.clearGenerationQuarantine} 解除;
 *   隔离区保留的旧事务由 {@link IndexFileJournal.listQuarantinedTransactions} 枚举、
 *   {@link IndexFileJournal.reclaimQuarantinedTransaction} 回收,并在当前版本成功提交且
 *   路径状态清除后自动回收对应依据。
 * - 恢复是「逐事务」的:单个事务失败只计入 {@link JournalRecoveryFailure},不中断整轮;
 *   但代际一旦被隔离,本代际的恢复与写入立即停止(spec:无法确定归属时停止该代际)。
 * - 同路径的 `prepare` 必须由调用方串行;类内另有 per-path 在途守卫,并发同路径会以
 *   `path-in-flight` 拒绝,避免产生两个同路径未决事务。
 * - 每个写入口先校验持有的 owner/epoch 并登记在途提交;只读 API 不要求写所有权
 *   (关闭自动索引时只读消费完成记录)。完成记录清单与路径状态清单在本实例内缓存,
 *   并在本实例的写操作后失效,调用方无需手动失效。
 * - 错误码稳定,不在此建 i18n key;用户可见文案由 T7 映射。裸 fs 错误(非 ENOENT)
 *   一律收敛为 `io-failure`,只保留 `errno` 与操作名,不把绝对路径与英文 errno 送进 UI。
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AtomicIndexStorage } from '../adapters/atomic-index-storage';
import { AtomicStorageError, isAtomicTempLeftoverName } from '../adapters/atomic-index-storage';
import type { FileReplaceStore, PreparedBlock } from '../adapters/vector-vectra';
import {
	EMPTY_BLOCK_SET_HASH,
	INDEX_RECORD_SCHEMA_VERSION,
	IndexValidationError,
	assertPathWithinRoot,
	assertSafePartName,
	assertSafeRecordPath,
	computeBlockSetHash,
	validateBlockSet,
	validateFileCommit,
	validatePreparedFile,
	verifyPreparedChecksums,
	type FileCommit,
	type IndexBlockInput,
	type PreparedFile,
	type PreparedPart,
} from './index-persistence-types';

// 记录契约的唯一事实源仍是 T1;这里只做便于消费方使用的再导出。
export type { FileCommit, PreparedFile, PreparedPart } from './index-persistence-types';

// ==================== 目录与文件命名 ====================

/** 完成记录目录名。 */
export const JOURNAL_FILES_DIRNAME = 'files';
/** 待提交事务目录名。 */
export const JOURNAL_PENDING_DIRNAME = 'pending';
/** 待提交事务记录文件名 — 只有它存在的事务才具备重放资格。 */
export const JOURNAL_PREPARED_FILENAME = 'prepared.json';
/** 路径状态与保留事务的目录名。 */
export const JOURNAL_QUARANTINE_DIRNAME = 'quarantine';
/** 隔离区中保留的旧事务子目录名。 */
export const JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME = 'transactions';
/** 代际级隔离记录文件名。 */
export const JOURNAL_GENERATION_QUARANTINE_FILENAME = 'generation.json';

/** 单个分片默认承载的块数 — 有界内存与有界单文件写入。 */
export const DEFAULT_JOURNAL_PART_SIZE = 64;

// ==================== 错误类型 ====================

/**
 * 日志层错误码。
 *
 * 关键路径:路径与记录本身的校验一律抛出 T1 的 `IndexValidationError`(错误码稳定且可被 T7 映射),
 * 这里只承载日志层自己的失败:所有权、归属不一致、前驱(prior version)不一致、清理失败与裸 IO 失败。
 *
 * 命名注意:`prior-version-*` 指「同路径的上一个版本事务」,与写所有权模块描述插件前驱实例的
 * `predecessor-not-closed` 不是一个概念,避免 T7 按码映射文案时撞名。
 */
export const INDEX_JOURNAL_ERROR_CODES = [
	'owner-epoch-mismatch',
	'generation-quarantined',
	'confirmation-required',
	'prepared-not-found',
	'transaction-mismatch',
	'receipt-path-mismatch',
	'prior-version-mismatch',
	'prior-version-unresolved',
	'path-in-flight',
	'cleanup-failed',
	'io-failure',
] as const;

/** 日志层错误码。 */
export type IndexJournalErrorCode = (typeof INDEX_JOURNAL_ERROR_CODES)[number];

/** 日志层错误 — 携带稳定错误码与不含笔记正文的诊断细节。 */
export class IndexFileJournalError extends Error {
	/** 稳定错误码。 */
	readonly code: IndexJournalErrorCode;
	/** 诊断细节;不含笔记正文、向量与密钥。 */
	readonly detail: Readonly<Record<string, unknown>>;

	constructor(code: IndexJournalErrorCode, message: string, detail: Record<string, unknown> = {}) {
		super(message);
		this.name = 'IndexFileJournalError';
		this.code = code;
		this.detail = detail;
	}
}

// ==================== 路径状态与代际隔离记录 ====================

/** 路径状态种类:`quarantined` 为坏日志隔离,`unavailable` 为磁盘存在未记账提交。 */
export const JOURNAL_PATH_STATE_KINDS = ['quarantined', 'unavailable'] as const;

/** 路径状态种类。 */
export type JournalPathStateKind = (typeof JOURNAL_PATH_STATE_KINDS)[number];

/** 路径状态原因。 */
export const JOURNAL_PATH_STATE_REASONS = [
	'invalid-prepared',
	'invalid-receipt',
	'expired-input-committed',
	'prior-version-unresolved',
	'unreceipted-disk-state',
] as const;

/** 路径状态原因。 */
export type JournalPathStateReason = (typeof JOURNAL_PATH_STATE_REASONS)[number];

/**
 * 单路径的持久状态记录 — 路径被隔离或不可检索的原因与恢复依据。
 *
 * 关键路径:记录不替代完成记录,只表达「该路径当前不得作为检索依据」;
 * 成功提交同一路径的新版本后由日志清除。
 */
export interface JournalPathState {
	/** 记录 schema 版本。 */
	schemaVersion: typeof INDEX_RECORD_SCHEMA_VERSION;
	/** 所属代际。 */
	generationId: string;
	/** vault 规范化相对路径。 */
	path: string;
	/** 状态种类。 */
	kind: JournalPathStateKind;
	/** 状态原因。 */
	reason: JournalPathStateReason;
	/** 关联的未决事务 ID;无关联时为 null。 */
	transactionId: string | null;
	/** 触发状态时磁盘上的未记账 commitId;无法确认时为 null。 */
	diskCommitId: string | null;
	/** 记录时间戳(毫秒)。 */
	at: number;
}

/**
 * 代际级隔离记录 — 存在无法归属的坏日志时停止该代际的恢复与检索。
 */
export interface JournalGenerationQuarantine {
	/** 记录 schema 版本。 */
	schemaVersion: typeof INDEX_RECORD_SCHEMA_VERSION;
	/** 被隔离的代际。 */
	generationId: string;
	/** 隔离原因。 */
	reason: 'unattributable-prepared';
	/** 触发隔离的事务 ID;无法确定时为 null。 */
	transactionId: string | null;
	/** 记录时间戳(毫秒)。 */
	at: number;
}

// ==================== 公共契约 ====================

/**
 * 日志使用的写所有权门面 — 与 `IndexWriteOwner` 结构兼容。
 *
 * 关键路径:日志只依赖「epoch + 可写断言 + 在途提交登记」三件事,不复制锁与恢复门实现。
 */
export interface JournalWriteOwner {
	/** 当前写所有权 epoch。 */
	readonly epoch: number;
	/**
	 * 断言仍持有写所有权。
	 *
	 * @throws {Error} 租约已释放或 epoch 已被接管,实现方按自己的错误码抛出。
	 */
	assertWritable(): void;
	/**
	 * 登记一次在途提交 — 重载交接会等它结算才允许新实例写盘。
	 *
	 * @returns 结算凭据。
	 */
	beginCommit(): { settle(): void };
}

/** 一个待写入的日志块 — 与 T2 `replaceFile` 的输入保持一致。 */
export interface JournalBlock {
	/** 块 ID,同一文件内唯一。 */
	id: string;
	/** 向量值。 */
	vector: number[];
	/** 块元数据;日志会统一补写 path/commitId/revision/docId/documentId。 */
	metadata: Record<string, unknown>;
}

/** `prepare` 输入。 */
export interface JournalPrepareInput {
	/** vault 规范化相对路径。 */
	path: string;
	/** 操作类型。 */
	operation: 'replace' | 'delete';
	/** 本次输入内容 hash;`delete` 必须为 null。 */
	inputHash: string | null;
	/** 目标版本号,必须大于声明的前驱 revision。 */
	revision: number;
	/** 声明的前驱提交 ID;首次提交为 null。 */
	previousCommitId: string | null;
	/** 声明的前驱 revision;首次提交为 0。 */
	previousRevision: number;
	/** 完整新块集合;零块表示空文件或删除。 */
	blocks: readonly JournalBlock[];
	/** 每个分片承载的块数;默认 {@link DEFAULT_JOURNAL_PART_SIZE}。 */
	partSize?: number;
}

/** `prepare` 结果。 */
export interface JournalPrepareResult {
	/** 事务目录名(由 path/revision/commitId 推导)。 */
	transactionId: string;
	/** 已落盘的事务记录。 */
	prepared: PreparedFile;
}

/** `commit` 结果。 */
export interface JournalCommitResult {
	/** 该路径当前生效的完成记录。 */
	commit: FileCommit;
	/** 是否跳过了向量替换(磁盘已是目标提交,只补完成记录)。 */
	replayed: boolean;
	/** 完成记录已更新到更高 revision,本次只清理旧日志。 */
	superseded: boolean;
	/** 日志清理是否仍待重试(不影响已提交结果)。 */
	cleanupPending: boolean;
}

/** 恢复动作清单。 */
export const JOURNAL_RECOVERY_ACTIONS = [
	'cleanup-only',
	'repaired-receipt',
	'replayed',
	'requeue-current',
	'blocked-current',
	'quarantined-path',
	'quarantined-generation',
] as const;

/** 恢复动作。 */
export type JournalRecoveryAction = (typeof JOURNAL_RECOVERY_ACTIONS)[number];

/** 恢复原因 — 与 spec 的恢复决策逐行对应。 */
export const JOURNAL_RECOVERY_REASONS = [
	'empty-transaction',
	'receipt-ahead',
	'receipt-matches-prepared',
	'receipt-missing-vectors-present',
	'input-matches-replay',
	'expired-input-old-disk',
	'expired-input-committed',
	'prior-version-mismatch',
	'incomplete-prepared',
	'invalid-prepared',
	'invalid-receipt',
	'unreceipted-disk-state',
	'unattributable-prepared',
] as const;

/** 恢复原因。 */
export type JournalRecoveryReason = (typeof JOURNAL_RECOVERY_REASONS)[number];

/** 单条恢复决策。 */
export interface JournalRecoveryDecision {
	/** 应采取的动作。 */
	action: JournalRecoveryAction;
	/** 决策原因。 */
	reason: JournalRecoveryReason;
	/** 关联路径;代际级隔离时为 null。 */
	path: string | null;
	/** 关联事务 ID。 */
	transactionId: string | null;
	/** 是否要求调用方按当前内容重新处理该路径。 */
	requiresReindex: boolean;
	/** 该路径当前能否作为检索依据。 */
	searchable: boolean;
}

/** 单条恢复失败 — 失败范围可定位到具体事务,不影响其余事务的恢复。 */
export interface JournalRecoveryFailure {
	/** 失败的事务 ID。 */
	transactionId: string;
	/** 稳定错误码;裸错误为 `unknown`。 */
	code: string;
	/** 诊断信息;不含笔记正文。 */
	message: string;
}

/** 一次恢复的完整报告。 */
export interface JournalRecoveryReport {
	/** 逐事务的恢复决策。 */
	decisions: JournalRecoveryDecision[];
	/** 代际级隔离记录;正常时为 null。 */
	generationQuarantine: JournalGenerationQuarantine | null;
	/** 清理仍失败、待下次重试的事务 ID。 */
	cleanupPending: string[];
	/** 本轮失败的事务 — 只有该事务受影响,其余事务照常恢复。 */
	failures: JournalRecoveryFailure[];
}

/** 恢复选项。 */
export interface JournalRecoverOptions {
	/**
	 * 当前内容 hash 视图 — 缺失的路径按「未知」处理(视为不匹配,不重放)。
	 *
	 * 关键路径:`null` 表示该路径已不存在,用于核对删除事务。
	 */
	currentInputs?: ReadonlyMap<string, string | null>;
}

/**
 * 解除代际隔离的显式确认选项。
 *
 * 关键路径:隔离代表「本代际存在无法归属的坏日志」,解除是不可自动化的运维决策,
 * 因此必须由调用方显式表态,默认一律拒绝。
 */
export interface JournalGenerationQuarantineReleaseOptions {
	/** 必须显式为 `true`;缺省、`false` 或非布尔值都会以 `confirmation-required` 拒绝。 */
	confirm: boolean;
}

/** 隔离区回收结论。 */
export interface JournalQuarantineReclaimResult {
	/** 已回收(删除)的事务 ID。 */
	reclaimed: string[];
	/** 仍需保留依据、未回收的事务 ID。 */
	retained: string[];
}

/** 完成记录与实际块的核对结果。 */
export interface ReceiptVerification {
	/** vault 规范化相对路径。 */
	path: string;
	/** 磁盘上的完成记录。 */
	receipt: FileCommit;
	/** 磁盘上的实际块集合(索引顺序)。 */
	blocks: PreparedBlock[];
	/** 完成记录与块集合是否逐一匹配(数量、commitId、块集合 hash、维度)。 */
	matches: boolean;
	/** 实际块集合的 hash。 */
	blockSetHash: string;
}

/** 日志构造选项。 */
export interface IndexFileJournalOptions {
	/** 代际根绝对路径;所有日志路径必须落在其内。 */
	generationRoot: string;
	/** 当前活动代际 ID。 */
	generationId: string;
	/** 当前配置指纹。 */
	configFingerprint: string;
	/** 写所有权门面;写入口每次调用都会校验。 */
	owner: JournalWriteOwner;
	/** 文件级替换存储(T2 契约)。 */
	store: FileReplaceStore;
	/** 原子存储 — 完成记录与分片的原子写与 flush。 */
	storage: AtomicIndexStorage;
	/** 期望向量维度;不传则不做维度断言。 */
	expectedDimension?: number;
	/** 时间来源(测试用);默认 `Date.now`。 */
	now?: () => number;
}

// ==================== 内部类型 ====================

/** 磁盘上的一个待提交事务。 */
interface PendingTransaction {
	/** 事务目录名。 */
	readonly transactionId: string;
	/** 事务目录绝对路径。 */
	readonly dir: string;
}

/** 待提交事务的读取结论。 */
type PreparedRead =
	| { readonly kind: 'ok'; readonly prepared: PreparedFile }
	| {
			readonly kind: 'not-replayable';
			/**
			 * `empty-transaction` — 无 `prepared.json` 且零可解析分片:无内容、无依据,直接清理;
			 * `incomplete-prepared` — 有分片但没有 `prepared.json`;
			 * `invalid-prepared` — 有记录但不可信。
			 */
			readonly reason: 'empty-transaction' | 'incomplete-prepared' | 'invalid-prepared';
			readonly attributedPath: string | null;
			readonly derivedTransactionId: string | null;
	  };

/** 单事务恢复的内部结论。 */
interface TransactionRecovery {
	readonly decisions: JournalRecoveryDecision[];
	/** 是否保留事务目录(保留恢复依据)。 */
	readonly keepTransaction: boolean;
}

// ==================== 日志实现 ====================

/**
 * 文件日志 — prepared 分片、完成记录与恢复决策的唯一入口。
 *
 * 关键路径:同一路径的 `prepare`(以及 `prepare`→`commit` 的整段提交流程)**必须由调用方串行**,
 * 本类只保证同一实例内并发 `prepare` 同路径会以 `path-in-flight` 拒绝,不做跨实例/跨进程互斥。
 *
 * @example
 *   const journal = new IndexFileJournal({ generationRoot, generationId, configFingerprint, owner, store, storage });
 *   const { transactionId } = await journal.prepare({ path, operation: 'replace', inputHash, revision, previousCommitId, previousRevision, blocks });
 *   await journal.commit(transactionId);
 *   const report = await journal.recover({ currentInputs });
 */
export class IndexFileJournal {
	private readonly generationRoot: string;
	private readonly generationId: string;
	private readonly configFingerprint: string;
	private readonly owner: JournalWriteOwner;
	private readonly store: FileReplaceStore;
	private readonly storage: AtomicIndexStorage;
	private readonly expectedDimension: number | undefined;
	private readonly now: () => number;
	/** 构造时绑定的 epoch — 写入口拒绝跨越接管的旧实例。 */
	private readonly boundEpoch: number;
	/**
	 * 完成记录清单缓存 — `isIndexComplete()` 会在每处理一个文件后读取完成记录,
	 * 不缓存就会退化成一轮处理 O(N²) 次文件读。本实例自己的写操作后失效。
	 */
	private receiptFilesCache: FileCommit[] | null = null;
	/** 不可检索路径的 pathHash 缓存 — 与完成记录缓存同口径失效。 */
	private blockedPathHashesCache: Set<string> | null = null;
	/** 同路径在途 `prepare` — 同实例内防止两个并发调用产生两条同路径未决事务。 */
	private readonly pathsInFlight = new Set<string>();

	/**
	 * @param options - 代际根、代际身份、配置指纹、写所有权、向量存储与原子存储。
	 * @throws {Error} 缺少代际根、代际 ID、配置指纹或依赖。
	 */
	constructor(options: IndexFileJournalOptions) {
		if (typeof options !== 'object' || options === null) {
			throw new Error('IndexFileJournal 需要构造选项');
		}
		if (typeof options.generationRoot !== 'string' || options.generationRoot.length === 0) {
			throw new Error('IndexFileJournal 需要代际根目录绝对路径');
		}
		if (!path.isAbsolute(options.generationRoot)) {
			throw new Error('IndexFileJournal 的代际根必须是绝对路径');
		}
		if (typeof options.generationId !== 'string' || options.generationId.length === 0) {
			throw new Error('IndexFileJournal 需要非空 generationId');
		}
		if (typeof options.configFingerprint !== 'string' || options.configFingerprint.length === 0) {
			throw new Error('IndexFileJournal 需要非空 configFingerprint');
		}
		if (typeof options.owner !== 'object' || options.owner === null) {
			throw new Error('IndexFileJournal 需要写所有权门面');
		}
		if (typeof options.store !== 'object' || options.store === null) {
			throw new Error('IndexFileJournal 需要文件级替换存储');
		}
		if (typeof options.storage !== 'object' || options.storage === null) {
			throw new Error('IndexFileJournal 需要原子存储');
		}
		this.generationRoot = path.resolve(options.generationRoot);
		this.generationId = options.generationId;
		this.configFingerprint = options.configFingerprint;
		this.owner = options.owner;
		this.store = options.store;
		this.storage = options.storage;
		this.expectedDimension = options.expectedDimension;
		this.now = options.now ?? Date.now;
		this.boundEpoch = options.owner.epoch;
	}

	// ==================== 只读 API ====================

	/**
	 * 读取某路径的完成记录(含删除凭据)。
	 *
	 * 关键路径:只读入口不要求写所有权 — 关闭自动索引时检索只消费已提交记录。
	 * 记录内路径与文件名的 `pathHash` 必须一致,否则拒绝作为依据。
	 *
	 * @param relativePath - vault 相对路径。
	 * @returns 完成记录;不存在时为 null。
	 * @throws {IndexValidationError} 路径非法或记录不可信。
	 * @throws {IndexFileJournalError} 记录归属与该路径不一致(`receipt-path-mismatch`)。
	 */
	async readReceipt(relativePath: string): Promise<FileCommit | null> {
		const normalized = assertSafeRecordPath(relativePath);
		const target = await this.receiptPath(normalized);
		const raw = await this.readTextOrNull(target, 'read-receipt');
		if (raw === null) return null;
		const record = await this.parseReceipt(raw, target);
		if (record.path !== normalized || `${pathHash(normalized)}.json` !== path.basename(target)) {
			throw new IndexFileJournalError(
				'receipt-path-mismatch',
				`完成记录归属与文件名不一致:记录内 ${record.path},文件名 ${path.basename(target)}`,
				{ path: normalized, expectedPathHash: pathHash(normalized), fileName: path.basename(target) },
			);
		}
		return record;
	}

	/**
	 * 列出全部可信完成记录中的 present 版本(清单视图,排除 tombstone)。
	 *
	 * 关键路径:不可信记录被跳过,损坏记录不能作为成功依据。
	 *
	 * @returns 按路径排序的完成记录。
	 */
	async listReceipts(): Promise<FileCommit[]> {
		const records = await this.readReceiptFiles();
		return records.filter((record) => record.state === 'present');
	}

	/**
	 * 列出全部可信完成记录中的删除凭据。
	 *
	 * @returns 按路径排序的删除记录。
	 */
	async listTombstones(): Promise<FileCommit[]> {
		const records = await this.readReceiptFiles();
		return records.filter((record) => record.state === 'deleted');
	}

	/**
	 * 列出可检索的 present 完成记录 — 同时排除 tombstone 与存在路径状态记录的路径。
	 *
	 * 关键路径:部分检索可用性必须读文件记录并扣除被隔离/不可用的路径,
	 * 不能只凭全量清单布尔值。
	 *
	 * @returns 按路径排序的可检索记录。
	 */
	async listSearchableReceipts(): Promise<FileCommit[]> {
		const receipts = await this.listReceipts();
		const blocked = await this.blockedPathHashes();
		return receipts.filter((record) => !blocked.has(pathHash(record.path)));
	}

	/** 判断是否存在任何未决事务目录，包括无法解析或尚未写入 prepared 的条目。 */
	async hasPendingTransactions(): Promise<boolean> {
		const dir = await this.resolveInRoot(JOURNAL_PENDING_DIRNAME);
		return (await this.readDirOrEmpty(dir, 'has-pending-transactions')).length > 0;
	}

	/**
	 * 列出未决事务声明的目标路径 — 纯读入口,不要求写所有权、不做任何写入。
	 *
	 * 关键路径:`recover()` 首行就断言写所有权,关闭自动索引时永远不会运行,
	 * 因此「向量已替换、完成记录未落盘」这个崩溃窗口不会产生任何 `unavailable` 路径状态;
	 * 只读可见性必须靠本入口枚举这些路径,否则会把旧 present 记录当成本轮可检索依据
	 * (spec §5 只读契约、A11)。本入口只读 `pending/<transactionId>/prepared.json` 的 `next.path`,
	 * 不校验分片、不缓存、不修改磁盘,也不登记在途提交。
	 *
	 * 已知边界:没有 `prepared.json`、或记录不可解析/路径非法的事务无法归属,
	 * 不出现在结果里;这类事务由恢复流程或代际隔离处理。
	 *
	 * @returns 去重并按路径排序的未决事务目标路径。
	 */
	async listPendingPaths(): Promise<string[]> {
		const dir = await this.resolveInRoot(JOURNAL_PENDING_DIRNAME);
		const paths = new Set<string>();
		for (const entry of await this.readDirOrEmpty(dir, 'list-pending-paths')) {
			if (!entry.isDirectory()) continue;
			let name: string;
			try {
				name = assertSafePartName(entry.name);
			} catch {
				// 无法安全处理的名字不做任何猜测性读取。
				continue;
			}
			const raw = await this.readTextOrNull(
				path.join(await this.transactionDir(name), JOURNAL_PREPARED_FILENAME),
				'read-prepared',
			);
			if (raw === null) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			const declared = typeof parsed === 'object' && parsed !== null
				? (parsed as { next?: { path?: unknown } }).next?.path
				: undefined;
			if (typeof declared !== 'string') continue;
			try {
				paths.add(assertSafeRecordPath(declared));
			} catch {
				// 记录内路径非法 → 不可归属;该事务留给恢复/隔离流程,不在这里猜测。
				continue;
			}
		}
		return [...paths].sort((left, right) => left.localeCompare(right));
	}

	/**
	 * 统计因配置指纹不符而被丢弃的完成记录数 — 纯读入口,不要求写所有权、不做任何写入。
	 *
	 * 关键路径:`readReceiptFiles()` 对配置不符记录一律静默跳过,只读视图因此只能得出
	 * 「已知空集」;本入口把「有多少记录因配置代际变化而作废」变成可判定信号,
	 * 使调用方能显示「配置已变」而不是「0 篇可检索」。只统计**仅**因配置指纹不符
	 * (错误码 `config-fingerprint-mismatch`)而不被采用的记录:代际不符、schema 不符与
	 * 损坏记录都不计入,不把它们混成「配置已变」。
	 *
	 * @returns 配置指纹与当前实例不一致的完成记录数。
	 */
	async countConfigMismatchedReceipts(): Promise<number> {
		const dir = await this.resolveInRoot(JOURNAL_FILES_DIRNAME);
		let count = 0;
		for (const entry of await this.readDirOrEmpty(dir, 'list-receipts')) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
			const raw = await this.readTextOrNull(path.join(dir, entry.name), 'read-receipt');
			if (raw === null) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				continue;
			}
			try {
				await validateFileCommit(parsed, this.validationOptions());
			} catch (error) {
				if (error instanceof IndexValidationError && error.code === 'config-fingerprint-mismatch') count += 1;
			}
		}
		return count;
	}

	/**
	 * 读取某路径的持久状态记录。
	 *
	 * @param relativePath - vault 相对路径。
	 * @returns 路径状态;不存在或不可信时为 null。
	 */
	async readPathState(relativePath: string): Promise<JournalPathState | null> {
		const normalized = assertSafeRecordPath(relativePath);
		const target = await this.pathStatePath(normalized);
		const raw = await this.readTextOrNull(target, 'read-path-state');
		if (raw === null) return null;
		return parsePathState(raw, this.generationId);
	}

	/**
	 * 列出全部可信路径状态记录。
	 *
	 * @returns 按路径排序的状态记录。
	 */
	async listPathStates(): Promise<JournalPathState[]> {
		const dir = await this.resolveInRoot(JOURNAL_QUARANTINE_DIRNAME);
		const states: JournalPathState[] = [];
		for (const entry of await this.readDirOrEmpty(dir, 'list-path-states')) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
			if (entry.name === JOURNAL_GENERATION_QUARANTINE_FILENAME) continue;
			const raw = await this.readTextOrNull(path.join(dir, entry.name), 'read-path-state');
			if (raw === null) continue;
			const state = parsePathState(raw, this.generationId);
			if (state !== null) states.push(state);
		}
		return states.sort((left, right) => left.path.localeCompare(right.path));
	}

	/**
	 * 读取代际级隔离记录。
	 *
	 * 关键路径:这里只做「可解析记录」的视图;是否隔离由 `isGenerationQuarantined()` 按文件存在判定,
	 * 记录损坏时本方法返回 null 但代际仍然停止写入。
	 *
	 * @returns 隔离记录;不存在或不可信时为 null。
	 */
	async readGenerationQuarantine(): Promise<JournalGenerationQuarantine | null> {
		const target = await this.resolveInRoot(JOURNAL_QUARANTINE_DIRNAME, JOURNAL_GENERATION_QUARANTINE_FILENAME);
		const raw = await this.readTextOrNull(target, 'read-generation-quarantine');
		if (raw === null) return null;
		return parseGenerationQuarantine(raw, this.generationId);
	}

	/**
	 * 代际是否已被隔离。
	 *
	 * 关键路径:判定按「隔离记录文件是否存在」,不按记录能否解析 ——
	 * 记录损坏时仍必须停止写入,直到调用方用 `clearGenerationQuarantine({ confirm: true })` 显式解除。
	 *
	 * @returns 存在隔离记录(含损坏记录)时为 true。
	 */
	async isGenerationQuarantined(): Promise<boolean> {
		return this.hasGenerationQuarantineRecord();
	}

	/**
	 * 核对某路径的完成记录与实际磁盘块集合。
	 *
	 * 关键路径:这是本类唯一可能读到**陈旧视图**的只读通道 —— 结论来自 `store` 的内存视图,
	 * 被撤销 epoch 的旧实例若未 `reload()`,在交接后可能给出过时结论(例如仍认为块属于已被替换的
	 * commit)。调用方必须在拿到写所有权或交接完成后先 `reload()` 存储,再据此判定可用性;
	 * 其余只读入口都直接读日志目录,不经过 store 内存状态。
	 *
	 * @param relativePath - vault 相对路径。
	 * @returns 核对结果;无完成记录时为 null。
	 */
	async verifyReceipt(relativePath: string): Promise<ReceiptVerification | null> {
		const receipt = await this.readReceipt(relativePath);
		if (receipt === null) return null;
		const blocks = await this.store.inspectFile(receipt.path);
		const blockSetHash = await computeBlockSetHash(blocks);
		const matches = await this.blockSetMatchesCommit(blocks, receipt);
		return { path: receipt.path, receipt, blocks, matches, blockSetHash };
	}

	// ==================== prepare ====================

	/**
	 * 准备一个待提交事务:按批写分片,全部分片完整后才原子写 `prepared.json`。
	 *
	 * 关键路径:
	 * - 入口先校验 owner/epoch 与代际状态;
	 * - 同路径的并发调用必须由调用方串行;本实例内以 `path-in-flight` 拒绝同路径在途 prepare;
	 * - 同路径已有未决事务时先核验并结算上一个版本(已提交 / 已废止 / 已由其它未决事务解释);
	 * - 声明的上一个版本 revision/commitId 必须与磁盘完成记录一致,否则拒绝;
	 * - 没有 `prepared.json` 的不完整准备数据不具备重放资格;
	 * - 事务目录推迟到第一次实际写入之前才创建,缩小「空目录」窗口。
	 *
	 * @param input - 目标路径、操作、输入 hash、版本与上一个版本声明、块集合。
	 * @returns 事务 ID 与已落盘的事务记录。
	 * @throws {IndexValidationError} 路径、哈希、块集合或 revision 不合法。
	 * @throws {IndexFileJournalError} 所有权失效、代际隔离、同路径在途、上一个版本不一致或写入失败。
	 */
	async prepare(input: JournalPrepareInput): Promise<JournalPrepareResult> {
		this.assertOwned('prepare');
		await this.assertGenerationWritable();
		// 关键路径:同路径的 prepare 必须串行 —— 否则两条 prepare 会各写一条同路径未决事务,
		// 之后的前驱结算无法判定谁才是真实前驱。这里只守本实例的在途调用。
		const inFlightPath = assertSafeRecordPath(input.path);
		if (this.pathsInFlight.has(inFlightPath)) {
			throw new IndexFileJournalError(
				'path-in-flight',
				`同一路径的 prepare 必须串行,已有在途调用:${inFlightPath}`,
				{ path: inFlightPath },
			);
		}
		this.pathsInFlight.add(inFlightPath);
		try {
			const draft = await this.buildPreparedFile(input);
			const settlement = await this.settlePredecessor(draft.prepared);
			if (settlement === 'repaired-predecessor') {
				throw new IndexFileJournalError(
					'prior-version-mismatch',
					`同路径上一个版本的事务已按磁盘结算为 revision ${draft.prepared.previousRevision + 1},请重新读取完成记录后重试`,
					{ path: draft.prepared.next.path, transactionId: draft.prepared.next.commitId },
				);
			}
			await this.assertPredecessorMatches(draft.prepared);

			const transactionId = transactionIdOf(draft.prepared);
			const transactionDir = await this.transactionDir(transactionId);
			const ticket = this.owner.beginCommit();
			try {
				// 关键路径:事务目录推迟到第一次实际写入之前才创建,缩小「空目录」窗口。
				const parts = await this.writeShards(transactionDir, draft.augmentedBlocks, input.partSize);
				const prepared: PreparedFile = { ...draft.prepared, parts };
				// 关键路径:写 prepared.json 前用 T1 校验器自检,防止把非法事务写到磁盘。
				await validatePreparedFile(prepared, { ...this.validationOptions(), transactionRoot: transactionDir });
				const target = await assertPathWithinRoot(
					path.join(transactionDir, JOURNAL_PREPARED_FILENAME),
					this.generationRoot,
				);
				await this.ensureDir(transactionDir, 'create-transaction');
				await this.storage.upsertFile(target, JSON.stringify(prepared, null, 2));
				await this.flushJournalPath(target, 'write-prepared');
				return { transactionId, prepared };
			} finally {
				ticket.settle();
			}
		} finally {
			this.pathsInFlight.delete(inFlightPath);
		}
	}

	// ==================== commit ====================

	/**
	 * 提交一个待提交事务:先替换目标向量,再原子写完成记录,最后清理事务目录。
	 *
	 * 关键路径:
	 * - 完成记录已指向更高 revision 时只清理旧日志,绝不覆盖后继版本;
	 * - 磁盘已含目标提交(崩溃窗口)时跳过向量替换,只补完成记录;
	 * - 向量替换失败时不写完成记录,保留事务日志供恢复;
	 * - 清理失败不撤销已提交结果,只报告待重试;
	 * - 成功后路径状态被清除,并回收该路径在隔离区保留的上一个版本事务依据。
	 *
	 * @param transactionId - 事务目录名。
	 * @returns 提交结论。
	 * @throws {IndexValidationError} 事务或分片不可信。
	 * @throws {IndexFileJournalError} 所有权失效、事务缺失、上一个版本不一致。
	 * @throws {VectorStoreError} 向量替换失败。
	 */
	async commit(transactionId: string): Promise<JournalCommitResult> {
		this.assertOwned('commit');
		await this.assertGenerationWritable();
		const transaction = await this.resolveTransaction(transactionId);
		const prepared = await this.readValidatedPrepared(transaction);
		const ticket = this.owner.beginCommit();
		try {
			const receipt = await this.readReceiptOrNull(prepared.next.path);
			if (receipt !== null && receipt.revision >= prepared.next.revision) {
				// 关键路径:完成记录已是后继版本,旧日志只允许清理。
				return {
					commit: receipt,
					replayed: false,
					superseded: true,
					cleanupPending: !(await this.tryCleanup(transactionId)),
				};
			}
			if (!predecessorMatchesReceipt(prepared, receipt)) {
				throw new IndexFileJournalError(
					'prior-version-mismatch',
					`事务声明的上一个版本与磁盘完成记录不一致,拒绝提交:${prepared.next.path}`,
					{
						path: prepared.next.path,
						expectedRevision: prepared.previousRevision,
						actualRevision: receipt?.revision ?? 0,
					},
				);
			}
			// 关键路径:成功后要回收被本路径隔离区保留的旧事务依据,先记下它属于哪条事务。
			const blockedState = await this.readPathState(prepared.next.path);
			const before = await this.store.inspectFile(prepared.next.path);
			const diskDone = await this.blockSetMatchesCommit(before, prepared.next);
			if (!diskDone) {
				const blocks = await this.loadValidatedBlocks(transaction, prepared);
				await this.store.replaceFile({
					path: prepared.next.path,
					commitId: prepared.next.commitId,
					blocks,
				});
			}
			await this.writeReceipt(prepared.next);
			// 关键路径:清理失败(事务目录或路径状态)不撤销已提交结果,只报告待重试。
			const transactionCleaned = await this.tryCleanup(transactionId);
			const stateCleared = await this.tryClearPathState(prepared.next.path);
			// 关键路径:路径状态已清除说明保留依据不再需要,回收对应隔离事务目录(spec §6 及时回收)。
			if (stateCleared && blockedState !== null && blockedState.path === prepared.next.path) {
				await this.tryReclaimQuarantinedTransaction(blockedState.transactionId);
			}
			return {
				commit: prepared.next,
				replayed: !diskDone,
				superseded: false,
				cleanupPending: !transactionCleaned || !stateCleared,
			};
		} finally {
			ticket.settle();
		}
	}

	// ==================== recover ====================

	/**
	 * 恢复全部未决事务:先校验事务与磁盘,再补写完成记录、重放或清理。
	 *
	 * 关键路径:
	 * - 代际已被隔离时不再恢复,直接报告隔离记录;
	 * - 代际在本轮被隔离后立即停止本代际的恢复 —— 不再清理、不再重放、不再替换向量;
	 * - 逐事务 try/catch:单个事务失败只计入 `failures`,不影响其余事务(失败范围可定位);
	 * - 重放只使用磁盘分片,从不调用嵌入模型;过期事务绝不发布为当前版本;
	 * - 清理按 transactionId 幂等,失败只记录待重试,不撤销已提交结果;
	 * - 不可重放且无法归属的事务会隔离整个代际,不猜测归属后继续写入;
	 *   但「无记录且零分片」的空事务按无内容直接清理,不升级为代际隔离。
	 *
	 * @param options - 当前内容 hash 视图。
	 * @returns 逐事务决策、代际隔离记录、待重试清理列表与逐事务失败列表。
	 * @throws {IndexFileJournalError} 所有权失效。
	 */
	async recover(options: JournalRecoverOptions = {}): Promise<JournalRecoveryReport> {
		this.assertOwned('recover');
		if (await this.hasGenerationQuarantineRecord()) {
			// 关键路径:代际已隔离 → 不恢复、不写入,直接报告隔离记录(记录损坏时为 null,但仍在隔离)。
			return {
				decisions: [],
				generationQuarantine: await this.readGenerationQuarantine(),
				cleanupPending: [],
				failures: [],
			};
		}
		const decisions: JournalRecoveryDecision[] = [];
		const cleanupPending: string[] = [];
		const failures: JournalRecoveryFailure[] = [];
		for (const transaction of await this.listPendingTransactions()) {
			// 关键路径:代际一旦被隔离,立即停止本代际的恢复与检索 —— 不再清理、不再重放、
			// 不再替换向量,也不再继续处理后续事务(spec:无法确定关联文件或代际时停止该代际)。
			if (await this.hasGenerationQuarantineRecord()) break;
			let outcome: TransactionRecovery;
			try {
				outcome = await this.recoverTransaction(transaction, options);
			} catch (error) {
				// 关键路径:单个事务失败只影响该事务并计入报告,不中断整轮恢复(A6 失败范围可定位)。
				failures.push(failureOf(transaction.transactionId, error));
				continue;
			}
			decisions.push(...outcome.decisions);
			if (outcome.decisions.some((entry) => entry.action === 'quarantined-generation')) break;
			if (outcome.keepTransaction) continue;
			if (!(await this.tryCleanup(transaction.transactionId))) {
				cleanupPending.push(transaction.transactionId);
			}
		}
		// 关键路径:恢复过程中可能新写代际隔离记录,必须回读而不是沿用开头的 null。
		return {
			decisions,
			generationQuarantine: await this.readGenerationQuarantine(),
			cleanupPending,
			failures,
		};
	}

	/**
	 * 清理一个待提交事务目录 — 按 transactionId 校验归属,幂等。
	 *
	 * 关键路径:记录内推导出的 transactionId 与目录名不一致时拒绝删除,
	 * 避免误删他人事务;目录不存在视为已清理。本入口同样登记在途提交。
	 *
	 * @param transactionId - 事务目录名。
	 * @throws {IndexValidationError} 事务名不是安全的单段文件名。
	 * @throws {IndexFileJournalError} 归属不一致(`transaction-mismatch`)或清理失败(`cleanup-failed`)。
	 */
	async cleanup(transactionId: string): Promise<void> {
		this.assertOwned('cleanup');
		const transaction = await this.resolveTransaction(transactionId);
		const read = await this.readPreparedTransaction(transaction);
		if (read.kind === 'ok') {
			if (transactionIdOf(read.prepared) !== transaction.transactionId) {
				throw new IndexFileJournalError(
					'transaction-mismatch',
					`事务目录名与记录推导出的 transactionId 不一致,拒绝清理:${transaction.transactionId}`,
					{ transactionId: transaction.transactionId },
				);
			}
		} else if (read.derivedTransactionId !== null && read.derivedTransactionId !== transaction.transactionId) {
			throw new IndexFileJournalError(
				'transaction-mismatch',
				`事务目录名与记录推导出的 transactionId 不一致,拒绝清理:${transaction.transactionId}`,
				{ transactionId: transaction.transactionId, derived: read.derivedTransactionId },
			);
		}
		// 关键路径:cleanup 是写入口,交接期必须登记在途提交,否则 rm 中断会留下部分/空的 pending 目录。
		const ticket = this.owner.beginCommit();
		try {
			await this.removeTransaction(transaction.transactionId);
		} finally {
			ticket.settle();
		}
	}

	// ==================== 代际隔离解除与隔离区回收 ====================

	/**
	 * 显式解除代际隔离 — 唯一允许让被隔离代际重新可写的入口。
	 *
	 * 关键路径:隔离是「存在无法归属的坏日志」的运维结论,自动解除会把不确定性重新引入检索;
	 * 因此必须由调用方以 `confirm: true` 显式表态,默认一律拒绝(`confirmation-required`)。
	 * 记录损坏(无法解析)时同样按文件存在判定隔离,本入口按文件名删除,不依赖记录可解析。
	 *
	 * @param options - 显式确认选项。
	 * @returns 解除前存在隔离记录(含损坏记录)时为 true。
	 * @throws {IndexFileJournalError} 所有权失效、缺少显式确认或删除失败。
	 */
	async clearGenerationQuarantine(options: JournalGenerationQuarantineReleaseOptions): Promise<boolean> {
		this.assertOwned('clearGenerationQuarantine');
		if (typeof options !== 'object' || options === null || options.confirm !== true) {
			throw new IndexFileJournalError(
				'confirmation-required',
				`解除代际隔离需要显式确认(confirm: true):${this.generationId}`,
				{ generationId: this.generationId },
			);
		}
		const target = await this.resolveInRoot(
			JOURNAL_QUARANTINE_DIRNAME,
			JOURNAL_GENERATION_QUARANTINE_FILENAME,
		);
		const existed = (await this.readTextOrNull(target, 'read-generation-quarantine')) !== null;
		try {
			await fs.promises.rm(target, { force: true });
		} catch (error) {
			throw new IndexFileJournalError('cleanup-failed', '解除代际隔离失败', {
				generationId: this.generationId,
				errno: getErrorCode(error),
			});
		}
		return existed;
	}

	/**
	 * 列出隔离区中保留的旧事务目录名 — 无界累积的上界视图。
	 *
	 * @returns 按事务 ID 排序的目录名。
	 */
	async listQuarantinedTransactions(): Promise<string[]> {
		const dir = await this.resolveInRoot(
			JOURNAL_QUARANTINE_DIRNAME,
			JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
		);
		const names: string[] = [];
		for (const entry of await this.readDirOrEmpty(dir, 'list-quarantined-transactions')) {
			if (!entry.isDirectory()) continue;
			try {
				names.push(assertSafePartName(entry.name));
			} catch {
				// 无法安全处理的名字一律跳过,不做任何猜测性删除。
				continue;
			}
		}
		return names.sort((left, right) => left.localeCompare(right));
	}

	/**
	 * 回收一个隔离区保留事务目录 — 恢复依据不再需要时的上界控制入口。
	 *
	 * 关键路径:只在「当前版本已成功提交、对应路径状态已清除」后调用;
	 * 目录名与记录推导出的 transactionId 不一致时拒绝删除(不误删仍需保留的依据)。
	 *
	 * @param transactionId - 被保留的事务 ID。
	 * @returns 实际删除时为 true;目录已不存在时为 false(幂等)。
	 * @throws {IndexFileJournalError} 所有权失效、归属不一致(`transaction-mismatch`)或清理失败。
	 */
	async reclaimQuarantinedTransaction(transactionId: string): Promise<boolean> {
		this.assertOwned('reclaimQuarantinedTransaction');
		const id = assertSafePartName(transactionId);
		const dir = await this.resolveInRoot(
			JOURNAL_QUARANTINE_DIRNAME,
			JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
			id,
		);
		const exists = await this.pathExists(dir);
		if (!exists) return false;
		const read = await this.readPreparedTransaction({ transactionId: id, dir });
		const derived = read.kind === 'ok' ? transactionIdOf(read.prepared) : read.derivedTransactionId;
		if (derived !== null && derived !== id) {
			throw new IndexFileJournalError(
				'transaction-mismatch',
				`隔离事务目录名与记录推导出的 transactionId 不一致,拒绝回收:${id}`,
				{ transactionId: id, derived },
			);
		}
		const ticket = this.owner.beginCommit();
		try {
			await fs.promises.rm(dir, { recursive: true, force: true });
		} catch (error) {
			throw new IndexFileJournalError('cleanup-failed', `回收隔离事务依据失败:${id}`, {
				transactionId: id,
				errno: getErrorCode(error),
			});
		} finally {
			ticket.settle();
		}
		return true;
	}

	/**
	 * 回收所有「没有任何路径状态仍引用」的隔离事务目录 — 一次性上界收敛。
	 *
	 * 关键路径:路径状态记录里的 `transactionId` 就是「仍需保留依据」的唯一凭据;
	 * 没有任何当前状态引用的事务目录可以安全回收。
	 *
	 * @returns 已回收与仍需保留的事务 ID。
	 * @throws {IndexFileJournalError} 所有权失效或清理失败。
	 */
	async reclaimOrphanQuarantinedTransactions(): Promise<JournalQuarantineReclaimResult> {
		this.assertOwned('reclaimOrphanQuarantinedTransactions');
		const retainedByState = new Set<string>();
		for (const state of await this.listPathStates()) {
			if (state.transactionId !== null) retainedByState.add(state.transactionId);
		}
		const reclaimed: string[] = [];
		const retained: string[] = [];
		for (const transactionId of await this.listQuarantinedTransactions()) {
			if (retainedByState.has(transactionId)) {
				retained.push(transactionId);
				continue;
			}
			if (await this.reclaimQuarantinedTransaction(transactionId)) reclaimed.push(transactionId);
		}
		return { reclaimed, retained };
	}

	// ==================== 内部:所有权与路径 ====================

	/** 写入口校验:先核对绑定 epoch,再断言写所有权(先 epoch 再锁)。 */
	private assertOwned(operation: string): void {
		if (this.owner.epoch !== this.boundEpoch) {
			throw new IndexFileJournalError(
				'owner-epoch-mismatch',
				`日志绑定的 epoch(${this.boundEpoch}) 与当前写所有权 epoch(${this.owner.epoch}) 不一致,拒绝 ${operation}`,
				{ operation, boundEpoch: this.boundEpoch, currentEpoch: this.owner.epoch },
			);
		}
		this.owner.assertWritable();
	}

	/** 代际被隔离时拒绝任何索引写入。 */
	private async assertGenerationWritable(): Promise<void> {
		if (await this.isGenerationQuarantined()) {
			throw new IndexFileJournalError(
				'generation-quarantined',
				`代际 ${this.generationId} 已被隔离(存在无法归属的坏日志),拒绝继续写入`,
				{ generationId: this.generationId },
			);
		}
	}

	/** 解析代际根内的路径并做包含性校验。 */
	private async resolveInRoot(...segments: string[]): Promise<string> {
		return assertPathWithinRoot(path.join(this.generationRoot, ...segments), this.generationRoot);
	}

	/** 完成记录路径。 */
	private async receiptPath(relativePath: string): Promise<string> {
		return this.resolveInRoot(JOURNAL_FILES_DIRNAME, `${pathHash(relativePath)}.json`);
	}

	/** 路径状态记录路径。 */
	private async pathStatePath(relativePath: string): Promise<string> {
		return this.resolveInRoot(JOURNAL_QUARANTINE_DIRNAME, `${pathHash(relativePath)}.json`);
	}

	/** 事务目录路径 — 目录名先过 T1 的单段文件名校验。 */
	private async transactionDir(transactionId: string): Promise<string> {
		return this.resolveInRoot(JOURNAL_PENDING_DIRNAME, assertSafePartName(transactionId));
	}

	/** 解析事务并给出诊断信息。 */
	private async resolveTransaction(transactionId: string): Promise<PendingTransaction> {
		const name = assertSafePartName(transactionId);
		return { transactionId: name, dir: await this.transactionDir(name) };
	}

	/** 校验选项。 */
	private validationOptions(): { generationId: string; configFingerprint: string } {
		return { generationId: this.generationId, configFingerprint: this.configFingerprint };
	}

	// ==================== 内部:IO 收敛 ====================

	/** 读取文件文本;不存在返回 null,其他 IO 错误收敛为 `io-failure`。 */
	private async readTextOrNull(target: string, operation: string): Promise<string | null> {
		try {
			return await fs.promises.readFile(target, 'utf8');
		} catch (error) {
			if (getErrorCode(error) === 'ENOENT') return null;
			throw ioFailure(operation, error, { scope: 'read' });
		}
	}

	/** 读取目录项;不存在时返回空数组,其他 IO 错误收敛为 `io-failure`。 */
	private async readDirOrEmpty(target: string, operation: string): Promise<fs.Dirent[]> {
		try {
			return await fs.promises.readdir(target, { withFileTypes: true });
		} catch (error) {
			if (getErrorCode(error) === 'ENOENT') return [];
			throw ioFailure(operation, error, { scope: 'readdir' });
		}
	}

	/** 创建日志目录;失败收敛为 `io-failure`。 */
	private async ensureDir(target: string, operation: string): Promise<void> {
		try {
			await fs.promises.mkdir(target, { recursive: true });
		} catch (error) {
			throw ioFailure(operation, error, { scope: 'mkdir' });
		}
	}

	/** 强制落盘日志文件;失败收敛为 `io-failure`(原子存储自身的稳定错误码不覆盖)。 */
	private async flushJournalPath(target: string, operation: string): Promise<void> {
		try {
			await this.storage.flushPath(target);
		} catch (error) {
			if (error instanceof AtomicStorageError) throw error;
			throw ioFailure(operation, error, { scope: 'flush' });
		}
	}

	/** 路径是否存在(不区分文件与目录)。 */
	private async pathExists(target: string): Promise<boolean> {
		try {
			await fs.promises.stat(target);
			return true;
		} catch (error) {
			if (getErrorCode(error) === 'ENOENT') return false;
			throw ioFailure('stat', error, { scope: 'stat' });
		}
	}

	// ==================== 内部:构造事务记录 ====================

	/**
	 * 构造并自校验事务记录,同时给出写入分片用的块集合。
	 *
	 * 关键路径:块元数据由日志统一补写 path/commitId(与 T2 `replaceFile` 一致)、
	 * revision 与 docId/documentId,使块集合 hash 覆盖版本元数据,并保证
	 * 「`next.commitId` 同时写进块与完成记录」这一不变式。
	 */
	private async buildPreparedFile(
		input: JournalPrepareInput,
	): Promise<{ prepared: PreparedFile; augmentedBlocks: PreparedBlock[] }> {
		const normalizedPath = assertSafeRecordPath(input.path);
		if (!Number.isInteger(input.revision) || input.revision <= 0) {
			throw new IndexValidationError('record-shape-invalid', `revision 必须是正整数,实际 ${String(input.revision)}`);
		}
		if (!Number.isInteger(input.previousRevision) || input.previousRevision < 0) {
			throw new IndexValidationError(
				'record-shape-invalid',
				`previousRevision 必须是非负整数,实际 ${String(input.previousRevision)}`,
			);
		}
		if (input.revision <= input.previousRevision) {
			throw new IndexValidationError(
				'revision-not-monotonic',
				`后继 revision(${input.revision}) 必须大于前驱 revision(${input.previousRevision})`,
			);
		}
		if (input.operation === 'delete' && input.blocks.length > 0) {
			throw new IndexValidationError('record-state-inconsistent', 'delete 事务不得携带块');
		}
		if (input.operation === 'delete' && input.inputHash !== null) {
			throw new IndexValidationError('record-state-inconsistent', 'delete 事务的 inputHash 必须为 null');
		}
		if (input.operation === 'replace' && typeof input.inputHash !== 'string') {
			throw new IndexValidationError('record-state-inconsistent', 'replace 事务必须提供 inputHash');
		}

		const commitId = randomUUID();
		const augmentedBlocks: PreparedBlock[] = input.blocks.map((block) => ({
			id: block.id,
			vector: [...block.vector],
			metadata: {
				...(block.metadata ?? {}),
				path: normalizedPath,
				commitId,
				revision: input.revision,
				docId: block.id,
				documentId: block.id,
			},
		}));
		await validateBlockSet(augmentedBlocks, {
			expectedChunkCount: augmentedBlocks.length,
			...(this.expectedDimension === undefined ? {} : { expectedDimension: this.expectedDimension }),
		});
		const blockSetHash =
			input.operation === 'delete' ? EMPTY_BLOCK_SET_HASH : await computeBlockSetHash(augmentedBlocks);

		const base = {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId: this.generationId,
			path: normalizedPath,
			configFingerprint: this.configFingerprint,
			commitId,
			revision: input.revision,
			chunkCount: augmentedBlocks.length,
			blockSetHash,
		};
		const raw: unknown =
			input.operation === 'delete'
				? { ...base, state: 'deleted', inputHash: null, chunkCount: 0 }
				: { ...base, state: 'present', inputHash: input.inputHash };
		const next = await validateFileCommit(raw, this.validationOptions());
		return {
			prepared: {
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				operation: input.operation,
				next,
				previousCommitId: input.previousCommitId,
				previousRevision: input.previousRevision,
				parts: [],
			},
			augmentedBlocks,
		};
	}

	/** 分批把块写入分片,回读核对后才记录分片 hash。 */
	private async writeShards(
		transactionDir: string,
		blocks: readonly PreparedBlock[],
		partSize: number | undefined,
	): Promise<PreparedPart[]> {
		const size = partSize ?? DEFAULT_JOURNAL_PART_SIZE;
		if (!Number.isInteger(size) || size <= 0) {
			throw new IndexValidationError('part-name-invalid', `partSize 必须是正整数,实际 ${String(size)}`);
		}
		const parts: PreparedPart[] = [];
		if (blocks.length > 0) {
			// 关键路径:`mkdir(transactionDir)` 推迟到第一次实际写入之前,缩小空目录窗口。
			await this.ensureDir(transactionDir, 'create-transaction');
		}
		for (let offset = 0, index = 0; offset < blocks.length; offset += size, index += 1) {
			const chunk = blocks.slice(offset, offset + size);
			const name = `part-${String(index).padStart(4, '0')}.json`;
			const target = await assertPathWithinRoot(path.join(transactionDir, name), this.generationRoot);
			const text = JSON.stringify(chunk);
			await this.storage.upsertFile(target, text);
			await this.flushJournalPath(target, 'write-shard');
			// 关键路径:全部分片完整后才允许写 prepared.json,因此这里回读真实字节核对。
			const written = await this.readTextOrNull(target, 'verify-shard');
			if (written !== text) {
				throw new IndexValidationError('checksum-mismatch', `分片 ${name} 落盘字节与写入内容不一致`);
			}
			parts.push({ name, hash: digestSha256(text), count: chunk.length });
		}
		return parts;
	}

	// ==================== 内部:前驱结算 ====================

	/**
	 * 核验并结算同路径的上一个版本(prior version)未决事务。
	 *
	 * 关键路径:同路径至多一个未决 prepared。结算分四种结果:
	 * - 完成记录已领先 → 清理旧日志(旧事务绝不允许重放);
	 * - 磁盘仍是完成记录(前驱未提交) → 废止旧日志;
	 * - 前驱向量已在磁盘上 → 输入仍匹配时补写其完成记录(要求调用方重读),
	 *   输入已过期时先持久化不可用状态、把旧日志移入隔离区保留依据,再继续当前版本;
	 * - 磁盘提交已由同路径另一条未决事务或已持久化的路径状态解释 → 本条只是重复未决事务,清理即可,
	 *   避免同 revision 双未决把该路径永久卡死。
	 */
	private async settlePredecessor(prepared: PreparedFile): Promise<'none' | 'repaired-predecessor'> {
		const normalizedPath = prepared.next.path;
		const transactions = await this.findTransactionsOfPath(normalizedPath);
		if (transactions.length === 0) return 'none';
		let outcome: 'none' | 'repaired-predecessor' = 'none';
		const receipt = await this.readReceiptOrNull(normalizedPath);
		let inspectedBlocks: PreparedBlock[] | null = null;
		const inspect = async (): Promise<PreparedBlock[]> => {
			inspectedBlocks ??= await this.store.inspectFile(normalizedPath);
			return inspectedBlocks;
		};
		for (const transaction of transactions) {
			const read = await this.readPreparedTransaction(transaction);
			if (read.kind !== 'ok') {
				// 不可重放 → 清理后重算该文件(已有归属记录时保留路径状态)。
				await this.cleanupQuietly(transaction.transactionId);
				continue;
			}
			const predecessor = read.prepared;
			if (receipt !== null && receipt.revision >= predecessor.next.revision) {
				await this.cleanupQuietly(transaction.transactionId);
				continue;
			}
			const blocks = await inspect();
			if (await this.blockSetMatchesCommit(blocks, predecessor.next)) {
				if (predecessor.next.inputHash !== prepared.next.inputHash) {
					// 关键路径:过期输入且向量已替换 → 先持久化不可用状态,再把旧日志移入隔离区保留依据。
					await this.writePathState({
						path: normalizedPath,
						kind: 'unavailable',
						reason: 'expired-input-committed',
						transactionId: transaction.transactionId,
						diskCommitId: predecessor.next.commitId,
					});
					await this.quarantineTransaction(transaction.transactionId);
					continue;
				}
				await this.writeReceipt(predecessor.next);
				await this.tryClearPathState(normalizedPath);
				await this.cleanupQuietly(transaction.transactionId);
				outcome = 'repaired-predecessor';
				continue;
			}
			if (await this.diskIsAtCommit(blocks, receipt)) {
				await this.cleanupQuietly(transaction.transactionId);
				continue;
			}
			// 关键路径:磁盘既不是完成记录也不是本条事务的目标。先给可自愈出口 ——
			// 若磁盘提交已由「同路径另一条未决事务的目标」或「已持久化的路径状态(diskCommitId)」
			// 解释,说明本条只是同 revision 的重复未决事务,按该事务结算即可,不再抛错把路径卡死。
			if (await this.diskCommitExplainedElsewhere(normalizedPath, blocks, transaction.transactionId)) {
				await this.cleanupQuietly(transaction.transactionId);
				continue;
			}
			// 真正无法判定归属 → 保留依据并拒绝继续猜测。
			await this.writePathState({
				path: normalizedPath,
				kind: 'unavailable',
				reason: 'prior-version-unresolved',
				transactionId: transaction.transactionId,
				diskCommitId: firstCommitId(blocks),
			});
			throw new IndexFileJournalError(
				'prior-version-unresolved',
				`路径 ${normalizedPath} 的磁盘状态既不匹配完成记录也不匹配上一个版本事务,拒绝开始新事务`,
				{ path: normalizedPath, transactionId: transaction.transactionId },
			);
		}
		return outcome;
	}

	/**
	 * 磁盘提交是否已被「同路径其它未决事务的目标」或「已有路径状态记录的 diskCommitId」解释。
	 *
	 * 关键路径:同 revision 双未决(前驱清理失败即可产生)叠加「后继在 replaceFile 与写 receipt 之间中断」
	 * 时,磁盘提交只属于其中一条事务;另一条若被当成「无法归属」就会让该路径每次 prepare 都抛错、
	 * 恢复也收敛不了。这里只在有明确依据时判定为重复事务,不猜测未知磁盘状态。
	 */
	private async diskCommitExplainedElsewhere(
		relativePath: string,
		blocks: readonly PreparedBlock[],
		selfTransactionId: string,
	): Promise<boolean> {
		const commitId = firstCommitId(blocks);
		if (commitId === null) return false;
		const state = await this.readPathState(relativePath);
		if (state?.diskCommitId === commitId) return true;
		for (const other of await this.listPendingTransactions()) {
			if (other.transactionId === selfTransactionId) continue;
			const read = await this.readPreparedTransaction(other);
			if (read.kind !== 'ok' || read.prepared.next.path !== relativePath) continue;
			if (await this.blockSetMatchesCommit(blocks, read.prepared.next)) return true;
		}
		return false;
	}

	/** 声明的上一个版本必须与磁盘完成记录一致 — 旧日志只允许在实际前驱与预期相符时重放。 */
	private async assertPredecessorMatches(prepared: PreparedFile): Promise<void> {
		const receipt = await this.readReceiptOrNull(prepared.next.path);
		if (predecessorMatchesReceipt(prepared, receipt)) return;
		throw new IndexFileJournalError(
			'prior-version-mismatch',
			`声明的上一个版本与磁盘完成记录不一致:${prepared.next.path}`,
			{
				path: prepared.next.path,
				expectedRevision: prepared.previousRevision,
				expectedCommitId: prepared.previousCommitId,
				actualRevision: receipt?.revision ?? 0,
				actualCommitId: receipt?.commitId ?? null,
			},
		);
	}

	/**
	 * 找出某路径的全部未决事务。
	 *
	 * 关键路径:先用只读 `prepared.json` 的 `next.path` 预筛,只对候选做分片 checksum 校验 ——
	 * 否则每次 `prepare` 都要读全部无关事务的全部分片字节。
	 */
	private async findTransactionsOfPath(relativePath: string): Promise<PendingTransaction[]> {
		const found: PendingTransaction[] = [];
		for (const transaction of await this.listPendingTransactions()) {
			const hintedPath = await this.readPreparedPathHint(transaction);
			if (hintedPath !== null) {
				if (hintedPath === relativePath) found.push(transaction);
				continue;
			}
			// 无 `prepared.json` 或记录里读不出路径 → 无法预筛,退回按分片归属的完整读取。
			const read = await this.readPreparedTransaction(transaction);
			const path = read.kind === 'ok' ? read.prepared.next.path : read.attributedPath;
			if (path === relativePath) found.push(transaction);
		}
		return found;
	}

	/** 只读 `prepared.json` 宽松取出可归属路径;取不到时返回 null(交由调用方做完整读取)。 */
	private async readPreparedPathHint(transaction: PendingTransaction): Promise<string | null> {
		const preparedPath = await assertPathWithinRoot(
			path.join(transaction.dir, JOURNAL_PREPARED_FILENAME),
			this.generationRoot,
		);
		const raw = await this.readTextOrNull(preparedPath, 'read-prepared-hint');
		if (raw === null) return null;
		try {
			return attributePathFromRawPrepared(JSON.parse(raw));
		} catch {
			return null;
		}
	}

	// ==================== 内部:事务读取 ====================

	/** 列出全部未决事务目录。 */
	private async listPendingTransactions(): Promise<PendingTransaction[]> {
		const dir = await this.resolveInRoot(JOURNAL_PENDING_DIRNAME);
		const transactions: PendingTransaction[] = [];
		for (const entry of await this.readDirOrEmpty(dir, 'list-pending-transactions')) {
			if (!entry.isDirectory()) continue;
			let name: string;
			try {
				name = assertSafePartName(entry.name);
			} catch {
				// 无法安全处理的名字一律跳过,不做任何猜测性删除。
				continue;
			}
			transactions.push({ transactionId: name, dir: await this.transactionDir(name) });
		}
		return transactions.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
	}

	/** 读取并完整校验一个事务(要求存在且可重放)。 */
	private async readValidatedPrepared(transaction: PendingTransaction): Promise<PreparedFile> {
		const read = await this.readPreparedTransaction(transaction);
		if (read.kind === 'ok') return read.prepared;
		if (read.reason !== 'invalid-prepared') {
			throw new IndexFileJournalError(
				'prepared-not-found',
				`事务 ${transaction.transactionId} 没有 prepared.json,不具备重放资格`,
				{ transactionId: transaction.transactionId, reason: read.reason },
			);
		}
		throw new IndexValidationError(
			'checksum-mismatch',
			`事务 ${transaction.transactionId} 的记录或分片不可信,不能作为提交依据`,
		);
	}

	/**
	 * 读取事务:校验 schema、transactionId、分片声明与分片字节。
	 *
	 * 关键路径:没有 `prepared.json` 与记录/分片不可信都归入「不可重放」,
	 * 但保留可归属路径用于隔离与重算,以及可推导的事务 ID 用于幂等清理。
	 *
	 * 「空事务」判据:无 `prepared.json` **且零可解析分片** —— 无内容、无依据,按无内容清理;
	 * 一旦出现分片或记录,就属于「有依据但不可信/无法归属」,才由上层决定隔离。
	 */
	private async readPreparedTransaction(transaction: PendingTransaction): Promise<PreparedRead> {
		const shards = await this.readShardFiles(transaction.dir);
		const preparedPath = await assertPathWithinRoot(
			path.join(transaction.dir, JOURNAL_PREPARED_FILENAME),
			this.generationRoot,
		);
		const raw = await this.readTextOrNull(preparedPath, 'read-prepared');
		if (raw === null) {
			return {
				kind: 'not-replayable',
				reason: shards.size === 0 ? 'empty-transaction' : 'incomplete-prepared',
				attributedPath: attributePathFromShards(shards),
				derivedTransactionId: null,
			};
		}
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				kind: 'not-replayable',
				reason: 'invalid-prepared',
				attributedPath: attributePathFromShards(shards),
				derivedTransactionId: null,
			};
		}
		try {
			const prepared = await validatePreparedFile(parsed, {
				...this.validationOptions(),
				transactionRoot: transaction.dir,
			});
			if (transactionIdOf(prepared) !== transaction.transactionId) {
				throw new IndexValidationError('record-shape-invalid', '事务目录名与记录推导出的 transactionId 不一致');
			}
			await verifyPreparedChecksums(prepared, shards);
			return { kind: 'ok', prepared };
		} catch {
			return {
				kind: 'not-replayable',
				reason: 'invalid-prepared',
				attributedPath: attributePathFromRawPrepared(parsed) ?? attributePathFromShards(shards),
				derivedTransactionId: lenientTransactionId(parsed),
			};
		}
	}

	/** 读取事务目录内的全部分片文本(不含 prepared.json 与原子写残留临时文件)。 */
	private async readShardFiles(transactionDir: string): Promise<Map<string, string>> {
		const shards = new Map<string, string>();
		for (const entry of await this.readDirOrEmpty(transactionDir, 'list-shards')) {
			if (!entry.isFile()) continue;
			if (entry.name === JOURNAL_PREPARED_FILENAME) continue;
			if (isAtomicTempLeftoverName(entry.name)) continue;
			const raw = await this.readTextOrNull(path.join(transactionDir, entry.name), 'read-shard');
			if (raw !== null) shards.set(entry.name, raw);
		}
		return shards;
	}

	/** 读取分片声明的块并做完整校验(字节、块集合 hash、数量与维度)。 */
	private async loadValidatedBlocks(
		transaction: PendingTransaction,
		prepared: PreparedFile,
	): Promise<PreparedBlock[]> {
		const shards = await this.readShardFiles(transaction.dir);
		await verifyPreparedChecksums(prepared, shards);
		const blocks: PreparedBlock[] = [];
		for (const part of prepared.parts) {
			const raw = shards.get(part.name);
			if (raw === undefined) {
				throw new IndexValidationError('part-missing', `缺少 prepared 声明的分片:${part.name}`);
			}
			const parsed = JSON.parse(raw) as PreparedBlock[];
			if (parsed.length !== part.count) {
				throw new IndexValidationError('part-count-mismatch', `分片 ${part.name} 的块数与声明不符`);
			}
			blocks.push(...parsed);
		}
		// 关键路径:只查数量与维度不能证明同一提交,必须用块集合 hash 覆盖有序 ID、元数据与向量。
		await validateBlockSet(blocks, {
			expectedBlockSetHash: prepared.next.blockSetHash,
			expectedChunkCount: prepared.next.chunkCount,
			...(this.expectedDimension === undefined ? {} : { expectedDimension: this.expectedDimension }),
		});
		return blocks;
	}

	// ==================== 内部:恢复决策 ====================

	/** 单事务恢复 — 先校验事务与磁盘,再补写记录、重放或清理。 */
	private async recoverTransaction(
		transaction: PendingTransaction,
		options: JournalRecoverOptions,
	): Promise<TransactionRecovery> {
		const ticket = this.owner.beginCommit();
		try {
			const read = await this.readPreparedTransaction(transaction);
			// 关键路径:进入任何写操作前复查代际隔离 —— 隔离可能由本轮的更早事务写入,
			// 此时代际必须立刻停止恢复与写入(spec:无法确定归属时停止该代际)。
			if (await this.hasGenerationQuarantineRecord()) {
				return { decisions: [], keepTransaction: true };
			}
			if (read.kind !== 'ok') {
				return await this.recoverNotReplayable(transaction, read);
			}
			return await this.recoverReplayable(transaction, read.prepared, options);
		} finally {
			ticket.settle();
		}
	}

	/** 不可重放事务的决策与隔离。 */
	private async recoverNotReplayable(
		transaction: PendingTransaction,
		read: Extract<PreparedRead, { kind: 'not-replayable' }>,
	): Promise<TransactionRecovery> {
		const decision = (
			action: JournalRecoveryAction,
			reason: JournalRecoveryReason,
			requiresReindex: boolean,
			searchable: boolean,
			path: string | null = read.attributedPath,
		): JournalRecoveryDecision => ({
			action,
			reason,
			path,
			transactionId: transaction.transactionId,
			requiresReindex,
			searchable,
		});
		if (read.reason === 'empty-transaction') {
			// 关键路径:无 prepared.json 且零可解析分片 = 空事务 —— 无内容、无依据。
			// `prepare` 建目录与写 prepared.json 之间的崩溃窗口(或 cleanup 被 rm -rf 中断)会留下它;
			// 它不携带任何内容,按无内容直接清理,**不得**升级为代际隔离。
			return {
				decisions: [decision('cleanup-only', 'empty-transaction', false, true, null)],
				keepTransaction: false,
			};
		}
		if (read.attributedPath === null) {
			// 关键路径:有记录或有分片但无法确定关联文件 → 隔离代际并停止恢复,不猜测归属。
			await this.writeGenerationQuarantine('unattributable-prepared', transaction.transactionId);
			return {
				decisions: [decision('quarantined-generation', 'unattributable-prepared', false, false, null)],
				keepTransaction: true,
			};
		}
		const path = read.attributedPath;
		const receiptRead = await this.readReceiptDetailed(path);
		if (receiptRead.kind === 'invalid') {
			await this.writePathState({
				path,
				kind: 'quarantined',
				reason: 'invalid-receipt',
				transactionId: transaction.transactionId,
				diskCommitId: null,
			});
			return {
				decisions: [decision('quarantined-path', 'invalid-receipt', true, false)],
				keepTransaction: true,
			};
		}
		const receipt = receiptRead.value;
		const blocks = await this.store.inspectFile(path);
		const diskMatchesReceipt = await this.diskIsAtCommit(blocks, receipt);
		if (read.reason === 'invalid-prepared') {
			// 隔离该路径并重算 — 坏日志不能作为成功依据;磁盘提交状态不是隔离原因,故不记 diskCommitId。
			await this.writePathState({
				path,
				kind: 'quarantined',
				reason: 'invalid-prepared',
				transactionId: transaction.transactionId,
				diskCommitId: null,
			});
			return {
				decisions: [decision('quarantined-path', 'invalid-prepared', true, false)],
				keepTransaction: false,
			};
		}
		if (diskMatchesReceipt) {
			// 没有 prepared.json 的不完整数据不具备重放资格:清理后只重算该文件。
			return {
				decisions: [decision('requeue-current', 'incomplete-prepared', true, receipt !== null)],
				keepTransaction: false,
			};
		}
		// 磁盘存在未记账提交 → 持久过滤该路径并保留依据。
		await this.writePathState({
			path,
			kind: 'unavailable',
			reason: 'unreceipted-disk-state',
			transactionId: transaction.transactionId,
			diskCommitId: firstCommitId(blocks),
		});
		return {
			decisions: [decision('blocked-current', 'unreceipted-disk-state', true, false)],
			keepTransaction: true,
		};
	}

	/** 可重放事务的恢复决策表。 */
	private async recoverReplayable(
		transaction: PendingTransaction,
		prepared: PreparedFile,
		options: JournalRecoverOptions,
	): Promise<TransactionRecovery> {
		const path = prepared.next.path;
		const decision = (
			action: JournalRecoveryAction,
			reason: JournalRecoveryReason,
			requiresReindex: boolean,
			searchable: boolean,
		): JournalRecoveryDecision => ({
			action,
			reason,
			path,
			transactionId: transaction.transactionId,
			requiresReindex,
			searchable,
		});
		const receiptRead = await this.readReceiptDetailed(path);
		if (receiptRead.kind === 'invalid') {
			await this.writePathState({
				path,
				kind: 'quarantined',
				reason: 'invalid-receipt',
				transactionId: transaction.transactionId,
				diskCommitId: null,
			});
			return {
				decisions: [decision('quarantined-path', 'invalid-receipt', true, false)],
				keepTransaction: true,
			};
		}
		const receipt = receiptRead.value;
		const blocks = await this.store.inspectFile(path);
		const receiptMatchesDisk = await this.diskIsAtCommit(blocks, receipt);

		// 决策 2:完成记录 revision 更高 → 验证后清理旧日志,绝不覆盖后继版本。
		if (receipt !== null && receipt.revision > prepared.next.revision) {
			if (!receiptMatchesDisk) {
				// 关键路径:完成记录领先但磁盘块与之不匹配 → 与决策 5 同口径持久化不可用状态。
				// 否则事务清理后重启不再产生决策,该路径会重新进入可检索集。
				await this.writePathState({
					path,
					kind: 'unavailable',
					reason: 'unreceipted-disk-state',
					transactionId: transaction.transactionId,
					diskCommitId: firstCommitId(blocks),
				});
				return {
					decisions: [decision('cleanup-only', 'receipt-ahead', true, false)],
					keepTransaction: false,
				};
			}
			return {
				decisions: [decision('cleanup-only', 'receipt-ahead', false, true)],
				keepTransaction: false,
			};
		}
		// 决策 6:完成记录与实际块匹配且事务仅剩清理 → 只清理,不再嵌入。
		// 覆盖两种耗时窗口:本事务的完成记录已写但日志未清;或同 revision 的其它提交(后继)已生效。
		if (receipt !== null && receipt.revision === prepared.next.revision) {
			if (receiptMatchesDisk) {
				return {
					decisions: [decision('cleanup-only', 'receipt-matches-prepared', false, true)],
					keepTransaction: false,
				};
			}
			return await this.blockPath(transaction, decision, path, 'prior-version-mismatch', firstCommitId(blocks));
		}
		// 决策 3/4/5:完成记录落后于事务。
		if (!predecessorMatchesReceipt(prepared, receipt)) {
			return await this.blockPath(transaction, decision, path, 'prior-version-mismatch', firstCommitId(blocks));
		}
		// 关键路径:只有当前内容仍匹配时才允许补写记录或重放;过期事务绝不发布为当前版本。
		if (currentInputMatches(options.currentInputs, prepared.next)) {
			if (await this.blockSetMatchesCommit(blocks, prepared.next)) {
				await this.writeReceipt(prepared.next);
				await this.tryClearPathState(path);
				return {
					decisions: [decision('repaired-receipt', 'receipt-missing-vectors-present', false, true)],
					keepTransaction: false,
				};
			}
			const shardBlocks = await this.loadValidatedBlocks(transaction, prepared);
			await this.store.replaceFile({
				path,
				commitId: prepared.next.commitId,
				blocks: shardBlocks,
			});
			await this.writeReceipt(prepared.next);
			await this.tryClearPathState(path);
			return {
				decisions: [decision('replayed', 'input-matches-replay', false, true)],
				keepTransaction: false,
			};
		}
		if (receiptMatchesDisk) {
			// 决策 4:过期输入且磁盘仍是旧提交 → 保留旧完整结果,排队当前版本。
			return {
				decisions: [decision('requeue-current', 'expired-input-old-disk', true, receipt !== null)],
				keepTransaction: false,
			};
		}
		// 决策 5:过期输入且磁盘含过期新提交 → 持久过滤路径并保留恢复依据。
		await this.writePathState({
			path,
			kind: 'unavailable',
			reason: 'expired-input-committed',
			transactionId: transaction.transactionId,
			diskCommitId: firstCommitId(blocks) ?? prepared.next.commitId,
		});
		return {
			decisions: [decision('blocked-current', 'expired-input-committed', true, false)],
			keepTransaction: true,
		};
	}

	/** 持久化不可用状态并保留事务目录的统一分支。 */
	private async blockPath(
		transaction: PendingTransaction,
		decision: (
			action: JournalRecoveryAction,
			reason: JournalRecoveryReason,
			requiresReindex: boolean,
			searchable: boolean,
		) => JournalRecoveryDecision,
		path: string,
		reason: JournalRecoveryReason,
		diskCommitId: string | null,
	): Promise<TransactionRecovery> {
		await this.writePathState({
			path,
			kind: 'unavailable',
			reason: reason === 'prior-version-mismatch' ? 'prior-version-unresolved' : 'unreceipted-disk-state',
			transactionId: transaction.transactionId,
			diskCommitId,
		});
		return {
			decisions: [decision('blocked-current', reason, true, false)],
			keepTransaction: true,
		};
	}

	// ==================== 内部:记录读写 ====================

	/** 写入完成记录并强制落盘。 */
	private async writeReceipt(commit: FileCommit): Promise<void> {
		const target = await this.receiptPath(commit.path);
		await this.ensureDir(path.dirname(target), 'create-files-dir');
		await this.storage.upsertFile(target, JSON.stringify(commit, null, 2));
		// 关键路径:完成记录是可用性依据,必须显式 flush,不能依赖进程退出回写。
		await this.flushJournalPath(target, 'write-receipt');
		this.invalidateRecordCaches();
	}

	/** 读取完成记录,损坏时抛出而不是返回 null。 */
	private async readReceiptOrNull(relativePath: string): Promise<FileCommit | null> {
		const read = await this.readReceiptDetailed(relativePath);
		if (read.kind === 'invalid') {
			throw read.error;
		}
		return read.value;
	}

	/** 读取完成记录并区分「不存在」与「不可信」。 */
	private async readReceiptDetailed(
		relativePath: string,
	): Promise<{ kind: 'ok'; value: FileCommit | null } | { kind: 'invalid'; error: Error }> {
		try {
			return { kind: 'ok', value: await this.readReceipt(relativePath) };
		} catch (error) {
			return { kind: 'invalid', error: toError(error) };
		}
	}

	/**
	 * 读取 `files/` 下全部可信完成记录。
	 *
	 * 关键路径:本实例内缓存 —— `isIndexComplete()` 会在每处理一个文件后读取完成记录,
	 * 不缓存就会退化成一轮处理 O(N²) 次文件读。缓存只在本实例的写操作后失效,
	 * 调用方无需(也不应)手动失效;跨实例/跨进程的并发写仍要求调用方串行。
	 */
	private async readReceiptFiles(): Promise<FileCommit[]> {
		const cached = this.receiptFilesCache;
		if (cached !== null) return [...cached];
		const dir = await this.resolveInRoot(JOURNAL_FILES_DIRNAME);
		const records: FileCommit[] = [];
		for (const entry of await this.readDirOrEmpty(dir, 'list-receipts')) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
			const expected = entry.name.slice(0, -'.json'.length);
			const raw = await this.readTextOrNull(path.join(dir, entry.name), 'read-receipt');
			if (raw === null) continue;
			try {
				const record = await this.parseReceipt(raw, path.join(dir, entry.name));
				// 关键路径:记录内路径的 pathHash 必须与文件名一致;不一致的记录不作为依据。
				if (pathHash(record.path) !== expected) continue;
				records.push(record);
			} catch {
				// 损坏记录不能作为成功依据,直接跳过。
				continue;
			}
		}
		records.sort((left, right) => left.path.localeCompare(right.path));
		this.receiptFilesCache = records;
		return [...records];
	}

	/** 解析并校验完成记录内容。 */
	private async parseReceipt(raw: string, target: string): Promise<FileCommit> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new IndexValidationError('record-shape-invalid', `完成记录不是合法 JSON:${path.basename(target)}`, {
				detail: { fileName: path.basename(target) },
			});
		}
		return validateFileCommit(parsed, this.validationOptions());
	}

	/** 写入路径状态记录并强制落盘。 */
	private async writePathState(input: {
		path: string;
		kind: JournalPathStateKind;
		reason: JournalPathStateReason;
		transactionId: string | null;
		diskCommitId: string | null;
	}): Promise<JournalPathState> {
		const state: JournalPathState = {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId: this.generationId,
			path: assertSafeRecordPath(input.path),
			kind: input.kind,
			reason: input.reason,
			transactionId: input.transactionId,
			diskCommitId: input.diskCommitId,
			at: this.now(),
		};
		const target = await this.pathStatePath(state.path);
		await this.ensureDir(path.dirname(target), 'create-quarantine-dir');
		await this.storage.upsertFile(target, JSON.stringify(state, null, 2));
		await this.flushJournalPath(target, 'write-path-state');
		this.invalidateRecordCaches();
		return state;
	}

	/** 清除某路径的状态记录 — 成功提交新版本后该路径重新可检索。 */
	private async clearPathState(relativePath: string): Promise<void> {
		const target = await this.pathStatePath(relativePath);
		try {
			await fs.promises.rm(target, { force: true });
		} catch (error) {
			throw ioFailure('clear-path-state', error, { path: relativePath });
		}
		this.invalidateRecordCaches();
	}

	/**
	 * 清除路径状态但不抛出。
	 *
	 * 关键路径:状态记录残留只会让该路径暂时不可检索,不撤销已提交结果;
	 * 下一次成功提交同一路径时会再次尝试清除。
	 */
	private async tryClearPathState(relativePath: string): Promise<boolean> {
		try {
			await this.clearPathState(relativePath);
			return true;
		} catch {
			return false;
		}
	}

	/** 写入代际级隔离记录。 */
	private async writeGenerationQuarantine(
		reason: JournalGenerationQuarantine['reason'],
		transactionId: string | null,
	): Promise<JournalGenerationQuarantine> {
		const record: JournalGenerationQuarantine = {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId: this.generationId,
			reason,
			transactionId,
			at: this.now(),
		};
		const target = await this.resolveInRoot(
			JOURNAL_QUARANTINE_DIRNAME,
			JOURNAL_GENERATION_QUARANTINE_FILENAME,
		);
		await this.ensureDir(path.dirname(target), 'create-quarantine-dir');
		await this.storage.upsertFile(target, JSON.stringify(record, null, 2));
		await this.flushJournalPath(target, 'write-generation-quarantine');
		return record;
	}

	/** 隔离记录文件是否存在 — 判定代际隔离的事实源(不依赖记录能否解析)。 */
	private async hasGenerationQuarantineRecord(): Promise<boolean> {
		const target = await this.resolveInRoot(
			JOURNAL_QUARANTINE_DIRNAME,
			JOURNAL_GENERATION_QUARANTINE_FILENAME,
		);
		return (await this.readTextOrNull(target, 'read-generation-quarantine')) !== null;
	}

	/** 路径状态目录内已占位的 pathHash 集合 — 无法解析的记录同样按其文件名屏蔽该路径。 */
	private async blockedPathHashes(): Promise<Set<string>> {
		const cached = this.blockedPathHashesCache;
		if (cached !== null) return new Set(cached);
		const dir = await this.resolveInRoot(JOURNAL_QUARANTINE_DIRNAME);
		const blocked = new Set<string>();
		for (const entry of await this.readDirOrEmpty(dir, 'list-path-states')) {
			if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
			if (entry.name === JOURNAL_GENERATION_QUARANTINE_FILENAME) continue;
			blocked.add(entry.name.slice(0, -'.json'.length));
		}
		this.blockedPathHashesCache = blocked;
		return new Set(blocked);
	}

	/** 使完成记录与路径状态缓存失效 — 只在本实例自己的写操作后调用。 */
	private invalidateRecordCaches(): void {
		this.receiptFilesCache = null;
		this.blockedPathHashesCache = null;
	}

	// ==================== 内部:清理 ====================

	/** 把事务目录移入隔离区保留依据;失败时按稳定错误码报告。 */
	private async quarantineTransaction(transactionId: string): Promise<void> {
		const from = await this.transactionDir(transactionId);
		const to = await this.resolveInRoot(
			JOURNAL_QUARANTINE_DIRNAME,
			JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
			assertSafePartName(transactionId),
		);
		try {
			await fs.promises.mkdir(path.dirname(to), { recursive: true });
			await fs.promises.rename(from, to);
		} catch (error) {
			throw new IndexFileJournalError(
				'cleanup-failed',
				`保留上一个版本事务的依据失败:${transactionId}`,
				{ transactionId, errno: getErrorCode(error) },
			);
		}
	}

	/**
	 * 回收隔离区保留事务但不抛出。
	 *
	 * 关键路径:只在「当前版本已成功提交、路径状态已清除」后调用;找不到目录视为已回收。
	 */
	private async tryReclaimQuarantinedTransaction(transactionId: string | null): Promise<boolean> {
		if (transactionId === null) return false;
		try {
			return await this.reclaimQuarantinedTransaction(transactionId);
		} catch {
			// 回收失败不影响已提交结果;隔离区仍有枚举与显式回收入口。
			return false;
		}
	}

	/** 删除事务目录;失败抛出稳定错误码。 */
	private async removeTransaction(transactionId: string): Promise<void> {
		const dir = await this.transactionDir(transactionId);
		try {
			await fs.promises.rm(dir, { recursive: true, force: true });
		} catch (error) {
			throw new IndexFileJournalError('cleanup-failed', `清理待提交事务失败:${transactionId}`, {
				transactionId,
				errno: getErrorCode(error),
			});
		}
	}

	/** 清理失败不抛出的版本 — 已提交结果不受清理失败影响。 */
	private async tryCleanup(transactionId: string): Promise<boolean> {
		try {
			await this.removeTransaction(transactionId);
			return true;
		} catch {
			return false;
		}
	}

	/** 清理但不关心结果 — 前驱结算中的废止清理。 */
	private async cleanupQuietly(transactionId: string): Promise<void> {
		await this.tryCleanup(transactionId);
	}

	// ==================== 内部:磁盘核对 ====================

	/** 块集合是否逐项匹配某提交记录(数量、commitId、块集合 hash 与维度)。 */
	private async blockSetMatchesCommit(
		blocks: readonly PreparedBlock[],
		commit: FileCommit,
	): Promise<boolean> {
		const inputs: readonly IndexBlockInput[] = blocks;
		try {
			await validateBlockSet(inputs, {
				expectedBlockSetHash: commit.blockSetHash,
				expectedChunkCount: commit.chunkCount,
				...(this.expectedDimension === undefined ? {} : { expectedDimension: this.expectedDimension }),
			});
		} catch {
			// 数量、维度或块集合 hash 不符都不能证明同一提交。
			return false;
		}
		if (commit.chunkCount === 0) {
			// 零块版本(删除或空文件)的目标状态就是「该路径没有块」;删除与空文件的判据相同,
			// 且已经过「prepared + 完成记录 + 块集合 hash」共同证明。
			return blocks.length === 0;
		}
		if (blocks.length === 0) return false;
		return blocks.every((block) => block.metadata['commitId'] === commit.commitId);
	}

	/** 磁盘是否仍处于给定完成记录(或首次提交前的空状态)。 */
	private async diskIsAtCommit(
		blocks: readonly PreparedBlock[],
		commit: FileCommit | null,
	): Promise<boolean> {
		if (commit === null) return blocks.length === 0;
		return this.blockSetMatchesCommit(blocks, commit);
	}
}

// ==================== 通用工具 ====================

/** 计算规范化相对路径的 pathHash。 */
function pathHash(relativePath: string): string {
	const normalized = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0).join('/');
	return digestSha256(normalized);
}

/** 由事务记录推导目录名 — 同一 (path, revision, commitId) 永远得到同一 ID,便于幂等校验。 */
function transactionIdOf(prepared: PreparedFile): string {
	return digestSha256(
		JSON.stringify([prepared.next.path, prepared.next.revision, prepared.next.commitId]),
	).slice(0, 32);
}

/** 宽松推导(不校验 schema) — 仅用于清理时的归属核对。 */
function lenientTransactionId(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const next = value['next'];
	if (!isRecord(next)) return null;
	const relativePath = next['path'];
	const revision = next['revision'];
	const commitId = next['commitId'];
	if (typeof relativePath !== 'string' || typeof revision !== 'number' || typeof commitId !== 'string') {
		return null;
	}
	return digestSha256(JSON.stringify([relativePath, revision, commitId])).slice(0, 32);
}

/** 从原始 prepared 记录中宽松读取可归属路径。 */
function attributePathFromRawPrepared(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const next = value['next'];
	if (!isRecord(next)) return null;
	const relativePath = next['path'];
	if (typeof relativePath !== 'string') return null;
	try {
		return assertSafeRecordPath(relativePath);
	} catch {
		return null;
	}
}

/** 从分片块元数据中读取可归属路径 — 只接受全部分片一致且通过路径校验的路径。 */
function attributePathFromShards(shards: ReadonlyMap<string, string>): string | null {
	const found = new Set<string>();
	for (const raw of shards.values()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// 分片本身损坏 → 无法可靠归属。
			return null;
		}
		if (!Array.isArray(parsed)) return null;
		for (const block of parsed) {
			if (!isRecord(block)) return null;
			const metadata = block['metadata'];
			if (!isRecord(metadata)) return null;
			const relativePath = metadata['path'];
			if (typeof relativePath !== 'string') return null;
			try {
				found.add(assertSafeRecordPath(relativePath));
			} catch {
				return null;
			}
		}
	}
	return found.size === 1 ? [...found][0] ?? null : null;
}

/** 块集合中唯一的 commitId;为空或混杂时为 null。 */
function firstCommitId(blocks: readonly PreparedBlock[]): string | null {
	const ids = new Set<string>();
	for (const block of blocks) {
		const commitId = block.metadata['commitId'];
		if (typeof commitId !== 'string' || commitId.length === 0) return null;
		ids.add(commitId);
	}
	return ids.size === 1 ? [...ids][0] ?? null : null;
}

/** 声明的前驱是否与磁盘完成记录一致。 */
function predecessorMatchesReceipt(prepared: PreparedFile, receipt: FileCommit | null): boolean {
	if (receipt === null) return prepared.previousCommitId === null && prepared.previousRevision === 0;
	return prepared.previousCommitId === receipt.commitId && prepared.previousRevision === receipt.revision;
}

/** 当前内容是否就是事务的目标版本。 */
function currentInputMatches(
	currents: ReadonlyMap<string, string | null> | undefined,
	commit: FileCommit,
): boolean {
	if (currents === undefined) return false;
	if (!currents.has(commit.path)) return false;
	const current = currents.get(commit.path) ?? null;
	if (commit.state === 'deleted') return current === null;
	return current === commit.inputHash;
}

/** 解析路径状态记录;schema、代际、路径或取值不合法时返回 null。 */
function parsePathState(raw: string, generationId: string): JournalPathState | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed['schemaVersion'] !== INDEX_RECORD_SCHEMA_VERSION) return null;
	if (parsed['generationId'] !== generationId) return null;
	const kind = parsed['kind'];
	const reason = parsed['reason'];
	if (typeof kind !== 'string' || !isJournalPathStateKind(kind)) return null;
	if (typeof reason !== 'string' || !isJournalPathStateReason(reason)) return null;
	const relativePath = parsed['path'];
	if (typeof relativePath !== 'string') return null;
	let normalized: string;
	try {
		normalized = assertSafeRecordPath(relativePath);
	} catch {
		return null;
	}
	const transactionId = parsed['transactionId'];
	const diskCommitId = parsed['diskCommitId'];
	const at = parsed['at'];
	if (transactionId !== null && typeof transactionId !== 'string') return null;
	if (diskCommitId !== null && typeof diskCommitId !== 'string') return null;
	if (typeof at !== 'number' || !Number.isFinite(at)) return null;
	return {
		schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
		generationId,
		path: normalized,
		kind,
		reason,
		transactionId,
		diskCommitId,
		at,
	};
}

/** 解析代际级隔离记录;不合法时返回 null。 */
function parseGenerationQuarantine(raw: string, generationId: string): JournalGenerationQuarantine | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed['schemaVersion'] !== INDEX_RECORD_SCHEMA_VERSION) return null;
	if (parsed['generationId'] !== generationId) return null;
	if (parsed['reason'] !== 'unattributable-prepared') return null;
	const transactionId = parsed['transactionId'];
	const at = parsed['at'];
	if (transactionId !== null && typeof transactionId !== 'string') return null;
	if (typeof at !== 'number' || !Number.isFinite(at)) return null;
	return {
		schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
		generationId,
		reason: 'unattributable-prepared',
		transactionId,
		at,
	};
}

/** 判断路径状态种类。 */
function isJournalPathStateKind(value: string): value is JournalPathStateKind {
	return (JOURNAL_PATH_STATE_KINDS as readonly string[]).includes(value);
}

/** 判断路径状态原因。 */
function isJournalPathStateReason(value: string): value is JournalPathStateReason {
	return (JOURNAL_PATH_STATE_REASONS as readonly string[]).includes(value);
}

/**
 * 把裸 IO 错误收敛为日志层稳定错误码。
 *
 * 关键路径:`mkdir`/`flushPath`/`readdir`/`readFile` 会抛出带英文 errno 与绝对路径的 Node 原生错误,
 * 若被 T4/T7 用 `String(err)` 送进 UI,既不稳定也可能泄漏本机路径。这里统一收敛为 `io-failure`,
 * 只保留操作名与 `errno` 诊断,原始错误挂在 `cause` 上。
 */
function ioFailure(operation: string, error: unknown, detail: Record<string, unknown> = {}): IndexFileJournalError {
	return new IndexFileJournalError('io-failure', `日志文件操作失败:${operation}`, {
		operation,
		errno: getErrorCode(error),
		cause: toError(error),
		...detail,
	});
}

/** 把恢复过程中的任意抛出值收敛为可定位的失败记录。 */
function failureOf(transactionId: string, error: unknown): JournalRecoveryFailure {
	const code = getErrorCode(error);
	return {
		transactionId,
		code: code ?? 'unknown',
		message: error instanceof Error ? error.message : String(error),
	};
}

/** 计算 SHA-256(hex)。 */
function digestSha256(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

/** 读取错误对象上的 `code` 字段。 */
function getErrorCode(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : null;
}

/** 判断是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把任意抛出值收敛为 Error。 */
function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}