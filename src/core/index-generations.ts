/**
 * @file src/core/index-generations.ts
 * @description 配置代际、控制指针、旧索引迁移与代际回收 — T6 的目录与代际管理唯一入口
 * @module core/index-generations
 * @depends node:fs, node:path, index-persistence-types, index-file-journal, index-manifest,
 *   index-build-stamp, adapters/atomic-index-storage, utils/hash
 *
 * 设计要点:
 * - **目录布局(硬约束)**:`.index/control.json` 是控制指针,`.index/owner.lock` 与
 *   `.index/owner.recovery.lock` 由 T2 写在 `.index/` 根,**每个代际的全部数据**落在
 *   `.index/generations/<generationId>/`(config.json、Vectra 的 index.json/catalog.json、
 *   `files/<pathHash>.json`、`pending/`、`quarantine/`)。
 *   因此 `VectraStore` 的索引目录**永远是代际目录**,`.index/` 根绝不能被递归删除:
 *   `VectraStore.dropIndex()` 是 `fs.rmSync(indexDir, { recursive: true })`,把根传进去会
 *   连带删掉日志、控制指针与删除凭据(T1/T2 证据 §5.2、T3 证据 §7 实测)。
 * - 所有清理都经过 {@link IndexGenerations.dropSafeGeneration},它在删除前核对目录归属
 *   与 `generations/` 前缀;legacy 清理只删「迁移时逐个核验过的旧 Vectra 文件白名单」。
 * - 代际身份与配置身份分离:`generationId` 是目录身份(由指纹派生,稳定不随时间漂移),
 *   `fingerprint` 是配置身份;两者都在代际记录里,不互相顶替。
 * - 迁移在 owner 锁内做**只读复制**:旧数据原地保留,复制到独立代际目录并逐文件核对摘要,
 *   最后原子发布控制指针;中断可重入、不重复嵌入;空间不足只报告失败,绝不先删旧数据。
 * - 写所有权是构造前提:{@link IndexGenerations} 必须拿到 owner 门面,任何控制指针变更、
 *   代际删除与 legacy 清理都在写盘前重新断言可写;迁移在发布 control 前再断言一次。
 * - 关键写入(`control.json`、`generation.json`、`config.json`、完成记录)一律用**唯一临时名 +
 *   rename + 文件/目录 flush**,不依赖进程退出回写。
 * - 身份不可证明即不复用:旧清单缺 `chunkerVersion` 等分块代数、块缺少边界/结构元数据时,
 *   一律按不可复用处理,**绝不用当前设置补造旧索引的身份**。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
	INDEX_RECORD_SCHEMA_VERSION,
	computeBlockSetHash,
	computeConfigFingerprint,
	type FileCommit,
	type IndexConfigDescriptor,
} from './index-persistence-types';
import {
	JOURNAL_FILES_DIRNAME,
	JOURNAL_GENERATION_QUARANTINE_FILENAME,
	JOURNAL_PENDING_DIRNAME,
	JOURNAL_PREPARED_FILENAME,
	JOURNAL_QUARANTINE_DIRNAME,
	JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME,
	IndexFileJournalError,
	type JournalWriteOwner,
} from './index-file-journal';
import { parseLegacyManifestEntry, type IndexManifestData } from './index-manifest';
import { readBuildStampOutcome } from './index-build-stamp';
import type { PreparedBlock } from '../adapters/vector-vectra';

// ==================== 常量与错误码 ====================

/** 代际目录集合名(位于 `.index/` 根)。 */
export const INDEX_GENERATIONS_DIRNAME = 'generations';

/** 控制指针文件名(位于 `.index/` 根)。 */
export const INDEX_GENERATION_CONTROL_FILENAME = 'control.json';

/** 代际入口文件名(位于代际目录内)。 */
export const INDEX_GENERATION_ENTRY_FILENAME = 'generation.json';

/** 代际配置文件名(位于代际目录内)。 */
export const INDEX_GENERATION_CONFIG_FILENAME = 'config.json';

/** 迁移复制进度文件名(位于代际目录内,保证中断可重入)。 */
export const INDEX_GENERATION_MIGRATION_STATE_FILENAME = 'migration.json';

/** 代际 ID 前缀 — 由配置指纹派生,长度 16 位十六进制。 */
export const INDEX_GENERATION_ID_PREFIX = 'gen-';

/** 受保护的根目录文件名 — 任何代际清理都不得触碰。 */
export const INDEX_GENERATION_PROTECTED_ROOT_FILES = [
	INDEX_GENERATION_CONTROL_FILENAME,
	'owner.lock',
	'owner.recovery.lock',
] as const;

/** 代际稳定错误码。 */
export const INDEX_GENERATION_ERROR_CODES = [
	'control-invalid',
	'generation-id-invalid',
	'generation-not-droppable',
	'generation-unknown',
	'generation-directory-foreign',
	'generation-cleanup-path-invalid',
	'config-invalid',
	'config-identity-unconfirmed',
	'legacy-manifest-invalid',
	'legacy-index-missing',
	'migration-io-failed',
	'migration-space-insufficient',
	'migration-copy-digest-mismatch',
	'migration-interrupted',
	'owner-not-writable',
	'switch-not-verified',
	'space-budget-exceeded',
] as const;

/** 代际稳定错误码。 */
export type IndexGenerationErrorCode = (typeof INDEX_GENERATION_ERROR_CODES)[number];

/** 代际操作错误。 */
export class IndexGenerationError extends Error {
	/** 稳定错误码。 */
	readonly code: IndexGenerationErrorCode;
	/** 诊断字段;不含笔记正文。 */
	readonly detail: Record<string, unknown>;
	/** 底层原始错误。 */
	readonly cause: unknown;

	constructor(code: IndexGenerationErrorCode, message: string, options: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
		super(message);
		this.name = 'IndexGenerationError';
		this.code = code;
		this.detail = options.detail ?? {};
		this.cause = options.cause ?? null;
	}
}

/** 代际生命周期状态。 */
export const GENERATION_STATUSES = [
	'building',
	'verifying',
	'active',
	'migrated',
	'quarantined',
	'failed',
] as const;

/** 代际生命周期状态。 */
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/** 代际来源。 */
export const GENERATION_KINDS = ['fresh', 'legacy-migration'] as const;

/** 代际来源。 */
export type GenerationKind = (typeof GENERATION_KINDS)[number];

/** 迁移阶段 — 中断后据此决定从哪一步继续。 */
export const GENERATION_MIGRATION_PHASES = ['inspect', 'copy', 'receipts', 'publish', 'done'] as const;

/** 迁移阶段。 */
export type GenerationMigrationPhase = (typeof GENERATION_MIGRATION_PHASES)[number];

/** 单个文件在迁移中的结论状态。 */
export const GENERATION_FILE_STATUSES = ['reusable', 'reindex'] as const;

/** 单个文件在迁移中的结论状态。 */
export type GenerationFileStatus = (typeof GENERATION_FILE_STATUSES)[number];

/**
 * 单个旧文件不能复用的原因。
 *
 * 关键路径:原因必须可定位到具体文件,不能因为个别文件不兼容就把其他已验证文件一并重算。
 *
 * 说明(spec §5「完整检查块 ID/序号、边界与结构元数据、维度、有限值和多余块」的落点):
 * - 「多余块」由 `chunk-count-mismatch` 覆盖 —— 清单声明块数与实际枚举块数不一致即不可复用;
 *   清单之外路径上的「孤儿块」在本层不可枚举(迁移只遍历清单条目,存储没有全量列路径的接缝),
 *   因此不保留一条永远不可达的原因名。
 * - 「边界与结构元数据」由 `structural-metadata-missing`(缺 `startOffset`、`headingPath`
 *   形状非法)与 `boundary-overlap`(起点随分块序号倒退)覆盖。
 */
export const GENERATION_FILE_REASONS = [
	'config-identity-unconfirmed',
	'chunk-count-mismatch',
	'chunk-contiguity-broken',
	'dimension-mismatch',
	'vector-not-finite',
	'block-id-foreign',
	'input-hash-mismatch',
	'zero-chunk-without-blocks',
	'manifest-entry-missing',
	'legacy-block-missing',
	'structural-metadata-missing',
	'boundary-overlap',
	'block-set-hash-mismatch',
] as const;

/** 单个旧文件不能复用的原因。 */
export type GenerationFileReason = (typeof GENERATION_FILE_REASONS)[number];

/** 迁移失败原因(对外可判定;文案留给 T7)。 */
export const MIGRATION_FAILURE_REASONS = [
	'config-identity-unconfirmed',
	'legacy-manifest-invalid',
	'legacy-index-missing',
	'space-insufficient',
	'io-failed',
	'digest-mismatch',
	'interrupted',
	'owner-not-writable',
] as const;

/** 迁移失败原因。 */
export type MigrationFailureReason = (typeof MIGRATION_FAILURE_REASONS)[number];

// ==================== 记录 schema ====================

/** 代际记录 — 活动指针之外的全部代际身份与状态。 */
export interface GenerationRecord {
	/** 记录 schema 版本(与 T1 记录同版本)。 */
	schemaVersion: typeof INDEX_RECORD_SCHEMA_VERSION;
	/** 代际 ID(目录身份)。 */
	generationId: string;
	/** 配置指纹(配置身份)。 */
	fingerprint: string;
	/** 代际来源。 */
	kind: GenerationKind;
	/** 生命周期状态。 */
	status: GenerationStatus;
	/** 代际数据目录绝对路径。 */
	root: string;
	/**
	 * 最近一次「本轮核对完成」的时间戳(毫秒);未完成核对时为 `null`。
	 *
	 * 关键路径:`configured-switch` 只接受 `verifiedAt !== null` 的 `migrated` 代际。
	 * 曾经活动的代际被降级时 `verifiedAt` 被清空 —— 「曾活动」不等于「本轮已核对」,
	 * 切回相同配置必须真的重新核对,不能凭旧状态跳过。
	 */
	verifiedAt: number | null;
	/** 代际级隔离原因;未隔离时为 `null`(对 T7 展示用,不含笔记正文)。 */
	quarantineReason: string | null;
	/** 创建时间戳(毫秒)。 */
	createdAt: number;
	/** 最近一次状态变更时间戳(毫秒)。 */
	updatedAt: number;
}

/** 控制指针 — `.index/control.json` 的全部内容。 */
export interface GenerationControlRecord {
	/** 记录 schema 版本。 */
	schemaVersion: typeof INDEX_RECORD_SCHEMA_VERSION;
	/** 活动代际 ID;未登记活动代际时为 null。 */
	activeGenerationId: string | null;
	/** 代际 ID → 代际记录。 */
	generations: Record<string, GenerationRecord>;
}

/** 代际手工入口记录(`generation.json`)。 */
export interface GenerationEntryRecord {
	/** 记录 schema 版本。 */
	schemaVersion: typeof INDEX_RECORD_SCHEMA_VERSION;
	/** 代际 ID — 必须与所在目录名逐字一致,否则该目录不被承认归属。 */
	generationId: string;
	/** 配置指纹 — 必须可由 {@link deriveGenerationId} 派生出同一代际 ID。 */
	fingerprint: string;
	/** 代际来源。 */
	kind: GenerationKind;
	/** 生命周期状态。 */
	status: GenerationStatus;
	/** 创建时间戳(毫秒)。 */
	createdAt: number;
}

/** 代际配置快照 — 写在代际目录内的 `config.json`,只描述该代际的向量空间身份。 */
export interface GenerationConfigRecord {
	/** 记录 schema 版本。 */
	schemaVersion: typeof INDEX_RECORD_SCHEMA_VERSION;
	/** 代际 ID(目录身份)。 */
	generationId: string;
	/** 配置指纹(配置身份)。 */
	fingerprint: string;
	/** 参与指纹计算的配置 — 不含凭证与运行期状态。 */
	config: IndexConfigDescriptor;
	/** 快照写入时间戳(毫秒)。 */
	writtenAt: number;
}

/** 代际句柄 — 调用方据此拿到目录与身份。 */
export interface GenerationHandle {
	/** 代际 ID(目录身份)。 */
	generationId: string;
	/** 配置指纹(配置身份)。 */
	fingerprint: string;
	/** 代际数据目录绝对路径 — `VectraStore` / `AtomicIndexStorage` / `IndexFileJournal` 只接受它。 */
	generationRoot: string;
	/** 当前状态。 */
	status: GenerationStatus;
}

// ==================== 迁移接口 ====================

/**
 * 旧索引的只读枚举面 — T2 `FileReplaceStore` 的只读子集。
 *
 * 关键路径:`inspectFile` 在 `VectraStore` 上是「全量 `listItems()` 后过滤」,逐条调用是 O(N²)
 * 接缝;`inspectFiles` 是**可选**批量枚举(T2 在 `VectraStore` 上新增),迁移优先使用它,
 * 方法缺失时逐条回退。两条路径必须给出完全一致的分组结果。
 */
export interface GenerationLegacyBlockStore {
	/** 完整枚举某个路径的当前块集合(不经过相似度查询)。 */
	inspectFile(path: string): Promise<PreparedBlock[]>;
	/** 一次枚举多个路径的块集合 — 可选批量接缝;缺失时调用方逐条回退。 */
	inspectFiles?(paths: string[]): Promise<Map<string, PreparedBlock[]>>;
}

/** 旧索引来源 — 只读。 */
export interface GenerationLegacySource {
	/** 旧 Vectra 数据目录(旧版 `.index/` 根)。 */
	legacyIndexDir: string;
	/** 旧版清单文件路径(`ratel-manifest.json` 或插件根的 `index-manifest.json`)。 */
	manifestPath: string;
	/** 旧索引的只读枚举入口。 */
	store: GenerationLegacyBlockStore;
}

/** 单文件兼容校验结论。 */
export interface GenerationFileValidation {
	/** 相对路径。 */
	path: string;
	/** 是否可复用。 */
	status: GenerationFileStatus;
	/** 不可复用原因;可复用时为 null。 */
	reason: GenerationFileReason | null;
	/** 清单声明输入内容 hash。 */
	inputHash: string;
	/** 实际枚举到的块数。 */
	actualChunkCount: number;
	/** 清单声明的块数。 */
	declaredChunkCount: number;
	/** 复用时的块集合校验和。 */
	blockSetHash: string | null;
	/** 复用时的提交标识。 */
	commitId: string | null;
}

/** 迁移动作的最终结论。 */
export interface GenerationMigrationResult {
	/** 是否已原子发布控制指针 — 以磁盘真实状态为准(写失败后回读控制指针复核)。 */
	published: boolean;
	/** 成功时为 true;失败时为 false(此时 `reason` 有值)。 */
	committed: boolean;
	/** 新建/复用的代际 ID;未创建代际时为 null。 */
	generationId: string | null;
	/** 发布后的活动代际 ID。 */
	activeGenerationId: string | null;
	/** 代际配置指纹;未创建代际时为 null。 */
	configFingerprint: string | null;
	/** 逐文件结论(全部文件,含需重算的)。 */
	files: GenerationFileValidation[];
	/** 迁移阶段。 */
	phase: GenerationMigrationPhase;
	/** 迁移失败原因。 */
	reason: MigrationFailureReason | null;
	/** 迁移失败时的稳定错误码。 */
	errorCode: IndexGenerationErrorCode | null;
	/** 复制阶段实际复制的文件名(可重入时少于全部)。 */
	copiedFileNames: string[];
	/** 复制总字节数。 */
	copiedBytes: number;
	/**
	 * 最终迁移状态文件是否已落盘。
	 *
	 * 关键路径:`published === true && statePersisted === false` 表示「控制指针已切换,但
	 * 迁移进度状态没写成」这一独立结论 —— 发布结果与磁盘一致,不会被状态写失败改写成未发布。
	 */
	statePersisted: boolean;
}

/** 迁移的 IO 接缝 — 只用于故障注入与观测测试,生产不传。 */
export interface GenerationMigrationIo {
	/** 复制字节数达到该值后按 `failErrno` 抛错;0 表示第一个文件就失败。 */
	failAfterBytes?: number;
	/** 注入的错误码。 */
	failErrno?: string;
	/** 写完成记录(receipt)时注入的错误码;覆盖 receipts 阶段故障。 */
	failReceiptWrite?: string;
	/** 写迁移进度状态文件时注入的错误码;覆盖 publish 之后的窗口。 */
	failMigrationStateWrite?: string;
	/** 每次迁移进度状态刷新后的观测回调(测试用)。 */
	onStateFlush?: (info: { copied: number; payloadBytes: number }) => void;
}

/** 迁移输入。 */
export interface GenerationMigrationInput {
	/** `.index/` 根绝对路径。 */
	indexRoot: string;
	/** 代际存储实例。 */
	generations: IndexGenerations;
	/** 当前生效配置。 */
	config: IndexConfigDescriptor;
	/** 旧索引来源。 */
	legacy: GenerationLegacySource;
	/** 写所有权门面 — 迁移必须在 owner 锁内进行。 */
	owner: JournalWriteOwner;
	/** 当前内容 hash 视图;缺失的路径视为不匹配,不复用。 */
	currentInputs: ReadonlyMap<string, string | null>;
	/** 分块参数 — 交叉核对清单声明(不调用分块器,不调用模型)。 */
	chunkLimits: { chunkSize: number; chunkOverlap: number };
	/** 期望向量维度;缺省用当前配置的维度。 */
	expectedDimension?: number;
	/** 复制字节预算;缺省不限制。 */
	spaceBudgetBytes?: number;
	/** IO 故障注入接缝。 */
	io?: GenerationMigrationIo;
	/** 时间来源(测试用);默认 `Date.now`。 */
	now?: () => number;
}

/** 单一代际的回收探测结论 — 由调用方在 owner 锁内读日志后提供。 */
export interface GenerationReconcileProbeResult {
	/** 未决事务数。 */
	pendingPaths: number;
	/** 代际级隔离记录是否存在。 */
	generationQuarantined: boolean;
	/** 该代际内被隔离的路径数。 */
	pathQuarantined: number;
	/** 该代际内保留的取证事务目录数(`quarantine/transactions/<id>/`)。 */
	quarantinedTransactions: number;
}

/** 新建代际前的回收决策。 */
export interface GenerationReconcileDecision {
	/** 本次实际回收(已删除目录)的代际 ID。 */
	reclaimed: string[];
	/**
	 * 未登记在 `control` 但目录形态自洽的孤儿代际目录 ID — 本次已回收。
	 *
	 * 关键路径:`ensureGeneration` 先建目录与入口、再写 `control`,中断会留下「不在代际表」的
	 * 目录;这类目录只能靠扫描 `generations/` 发现,不纳入回收就永不消失。
	 */
	orphanDirectories: string[];
	/** 因不活动但仍有未解决事务/隔离而保留的代际 ID。 */
	retained: string[];
	/** 是否允许新建代际。 */
	canCreate: boolean;
	/** 不允许新建时的原因;允许时为 null。 */
	blockedReason: 'all-generations-retained' | null;
}

// ==================== 目录与归属 ====================

/** 旧 Vectra 文件的分类。 */
export type LegacyIndexFileKind = 'index' | 'catalog' | 'metadata';

/**
 * 判断一个文件名是否属于「迁移时验证过的旧 Vectra 文件白名单」。
 *
 * 关键路径:白名单**只**包含 vectra 自己写的三类文件;`control.json`、`owner.lock`、
 * `generations/` 以及任何未知文件都不在其中,因此 legacy 清理永远不会删到它们。
 *
 * @param name - 目录内的文件名(不是路径)。
 * @returns 分类;不属于白名单时为 null。
 */
export function legacyIndexFileKind(name: string): LegacyIndexFileKind | null {
	if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return null;
	if (name === 'index.json') return 'index';
	if (name === 'catalog.json') return 'catalog';
	// 关键路径:vectra 的外置 metadata 文件是 `<uuid>.json`,与索引同目录。
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(name)) return 'metadata';
	return null;
}

/** 判断字符串是否为合法的代际 ID。 */
export function isGenerationId(value: unknown): value is string {
	return typeof value === 'string' && /^gen-[0-9a-f]{16}$/.test(value);
}

/**
 * 由配置指纹派生稳定的代际 ID — 同一配置永远得到同一 ID,不以启动时间创建新代际。
 *
 * @param fingerprint - 配置指纹(64 位十六进制)。
 * @returns 代际 ID。
 * @throws {IndexGenerationError} 指纹不是合法摘要时(`config-invalid`)。
 */
export function deriveGenerationId(fingerprint: string): string {
	if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
		throw new IndexGenerationError('config-invalid', '配置指纹必须是 64 位小写十六进制摘要');
	}
	return `${INDEX_GENERATION_ID_PREFIX}${fingerprint.slice(0, 16)}`;
}

// ==================== 配置身份 ====================

/**
 * 把旧清单里的全局字段映射为可判定的配置描述。
 *
 * 关键路径(B1,spec §5):
 * - 旧清单没有模型修订信息,因此 `embeddingModelRevision` 一律为 `null`,**不根据当前设置补造**;
 * - 旧清单缺 `chunkSize` / `chunkOverlap` / `chunkerVersion` 时无法证明分块身份,返回 null
 *   (调用方按不兼容处理),**绝不用当前配置的 `chunkerVersion` 回退冒名顶替**。
 *   `chunkerVersion` 在 `IndexManifestData` 上是可选字段:旧清单没有它时读出 `undefined`,
 *   与仓库既有语义一致(`shouldFullRebuild` 认为 `undefined !== CURRENT` → 升级后自动重建一次),
 *   所以这里也必须按「不可确认」处理,否则「旧身份 === 当前配置」的比较会恒真。
 *
 * @param manifest - 旧清单数据。
 * @param fallbacks - 旧清单确实缺失、但可由当前运行时确认的字段(仅向量维度)。
 * @returns 配置描述;无法构成完整身份时为 null。
 */
export function mapLegacyConfigIdentity(
	manifest: IndexManifestData,
	fallbacks: { embeddingDimension: number },
): IndexConfigDescriptor | null {
	if (!isRecord(manifest)) return null;
	const modelId = manifest.embedModelId;
	const chunkSize = manifest.chunkSize;
	const chunkOverlap = manifest.chunkOverlap;
	if (typeof modelId !== 'string' || modelId.length === 0) return null;
	if (typeof chunkSize !== 'number' || !Number.isInteger(chunkSize) || chunkSize <= 0) return null;
	if (typeof chunkOverlap !== 'number' || !Number.isInteger(chunkOverlap) || chunkOverlap < 0) return null;
	// 关键路径:分块器代数只能来自旧清单自身;缺失即身份不可确认(返回 null),不做当前值回退。
	const chunkerVersion = manifest.chunkerVersion;
	if (typeof chunkerVersion !== 'number' || !Number.isInteger(chunkerVersion) || chunkerVersion <= 0) return null;
	if (!Number.isInteger(fallbacks.embeddingDimension) || fallbacks.embeddingDimension <= 0) return null;
	return {
		embeddingModelId: modelId,
		embeddingModelRevision: null,
		embeddingDimension: fallbacks.embeddingDimension,
		chunkerVersion,
		chunkSize,
		chunkOverlap,
		embeddingTextVersion: null,
	};
}

/**
 * 判断旧清单是否缺少「分块器代数」这一唯一不可确认的分块输入。
 *
 * 关键路径(B1):`modelId` / `chunkSize` / `chunkOverlap` 齐全、仅 `chunkerVersion` 缺失时,
 * 清单本身是**合法**的(该字段在 `IndexManifestData` 上可选),缺失的只是分块身份 ——
 * 迁移必须报告 `config-identity-unconfirmed` 而不是「清单非法」,让上层走显式重建入口。
 *
 * @param manifest - 旧清单数据。
 * @returns 其余分块输入齐全但分块器代数不可确认时为 true。
 */
export function isChunkerGenerationUnconfirmable(manifest: IndexManifestData): boolean {
	if (!isRecord(manifest)) return false;
	const modelId = manifest.embedModelId;
	if (typeof modelId !== 'string' || modelId.length === 0) return false;
	const chunkSize = manifest.chunkSize;
	if (typeof chunkSize !== 'number' || !Number.isInteger(chunkSize) || chunkSize <= 0) return false;
	const chunkOverlap = manifest.chunkOverlap;
	if (typeof chunkOverlap !== 'number' || !Number.isInteger(chunkOverlap) || chunkOverlap < 0) return false;
	const chunkerVersion = manifest.chunkerVersion;
	return typeof chunkerVersion !== 'number' || !Number.isInteger(chunkerVersion) || chunkerVersion <= 0;
}

/**
 * 判断一份配置身份能否被「重建」到可与当前配置比较的程度。
 *
 * 关键路径(spec §5):API 同名异端点、没有可确认修订时**不假设兼容**,也绝不根据当前设置
 * 补造旧配置的端点指纹;只有身份可重建的**本地已知模型**(`local:` 前缀)才允许在缺少修订
 * 信息时按兼容处理。
 *
 * @param config - 配置描述。
 * @returns 是否可确认身份,以及不可确认时的稳定原因。
 */
export function confirmsLegacyConfigIdentity(
	config: IndexConfigDescriptor,
): { confirmed: true } | { confirmed: false; reason: 'api-identity-unrevisioned' | 'model-id-unrecognized' } {
	const modelId = config.embeddingModelId;
	if (modelId.startsWith('local:')) {
		// 本地模型身份由模型文件自身确定,修订不可追溯时不额外假设端点漂移。
		return modelId.length > 'local:'.length ? { confirmed: true } : { confirmed: false, reason: 'model-id-unrecognized' };
	}
	if (modelId.startsWith('api:')) {
		if (config.embeddingModelRevision !== null && config.embeddingModelRevision.length > 0) return { confirmed: true };
		return { confirmed: false, reason: 'api-identity-unrevisioned' };
	}
	return { confirmed: false, reason: 'model-id-unrecognized' };
}

// ==================== 代际存储 ====================

/** `IndexGenerations` 的构造选项。 */
export interface IndexGenerationsOptions {
	/** `.index/` 根绝对路径。 */
	indexRoot: string;
	/**
	 * 写所有权门面 — **必填**。
	 *
	 * 关键路径:所有控制指针变更、代际删除与 legacy 清理都必须在 owner 锁内进行;把门面做成
	 * 构造前提后,任何入口(包括 T7 的装配)都无法绕过「持锁才写盘」这一约束。
	 */
	owner: JournalWriteOwner;
	/** 时间来源(测试用);默认 `Date.now`。 */
	now?: () => number;
}

/**
 * 代际与控制指针的唯一管理者。
 *
 * 关键路径:`indexRoot`(`.index/`)保留日志、`control` 与 owner 锁文件,**代际数据只落在
 * `generations/<generationId>/`**。本类不提供任何「删除索引根」的方法;所有删除都经过
 * {@link dropSafeGeneration} 的归属校验。
 *
 * @example
 *   const generations = new IndexGenerations({ indexRoot: path.join(pluginDir, '.index'), owner });
 *   const handle = await generations.ensureGeneration({ config });
 *   // 此后 VectraStore / AtomicIndexStorage / IndexFileJournal 一律使用 handle.generationRoot。
 */
export class IndexGenerations {
	private readonly indexRoot: string;
	private readonly owner: JournalWriteOwner;
	private readonly now: () => number;

	constructor(options: IndexGenerationsOptions) {
		if (!isRecord(options) || typeof options.indexRoot !== 'string' || options.indexRoot.length === 0) {
			throw new IndexGenerationError('config-invalid', 'IndexGenerations 需要 .index 根目录绝对路径');
		}
		if (!path.isAbsolute(options.indexRoot)) {
			throw new IndexGenerationError('config-invalid', 'IndexGenerations 的索引根必须是绝对路径');
		}
		if (!isRecord(options.owner) || typeof options.owner.assertWritable !== 'function') {
			throw new IndexGenerationError('config-invalid', 'IndexGenerations 需要写所有权门面(owner)');
		}
		this.indexRoot = path.resolve(options.indexRoot);
		this.owner = options.owner;
		this.now = options.now ?? Date.now;
	}

	/** `.index/` 根绝对路径。 */
	get root(): string {
		return this.indexRoot;
	}

	/** `generations/` 目录绝对路径。 */
	get generationsRoot(): string {
		return path.join(this.indexRoot, INDEX_GENERATIONS_DIRNAME);
	}

	/** 控制指针文件绝对路径。 */
	get controlPath(): string {
		return path.join(this.indexRoot, INDEX_GENERATION_CONTROL_FILENAME);
	}

	// --- 写所有权 ---

	/**
	 * 断言仍持有写所有权 — 写盘前的统一门禁。
	 *
	 * 关键路径:「所有清理与代际变更都持 owner 锁」不能只靠调用方口头保证;这里是 API 层的
	 * 强制点,任何写控制指针、删除代际或清理 legacy 文件的路径都要先过它。
	 *
	 * @param operation - 操作名(诊断用,不含用户数据)。
	 * @throws {IndexGenerationError} 写所有权已失效(`owner-not-writable`)。
	 */
	private assertWritable(operation: string): void {
		try {
			this.owner.assertWritable();
		} catch (error) {
			throw new IndexGenerationError('owner-not-writable', `写所有权已失效,拒绝 ${operation}`, {
				detail: { operation },
				cause: error,
			});
		}
	}

	// --- 归属校验 ---

	/**
	 * 判断目标是否落在「可递归删除的代际目录」这一层。
	 *
	 * 关键路径(T1/T2 证据 §5.2):`.index/` 根与 `generations/` 聚合目录**永远**不可作为递归
	 * 删除目标;只有根下的 `generations/<generationId>` 这一层才可能被清理,且清理仍要经过
	 * {@link dropSafeGeneration} 的入口文件归属校验。
	 *
	 * @param target - 候选目录。
	 * @returns 名称层合法时为 true(不代表已通过归属校验)。
	 */
	isIndexRootDroppable(target: string): boolean {
		const resolved = path.resolve(target);
		if (resolved === this.indexRoot || resolved === this.generationsRoot) return false;
		if (path.dirname(resolved) !== this.generationsRoot) return false;
		return isGenerationId(path.basename(resolved));
	}

	/**
	 * 目标是否为「本索引根下、带自洽代际入口、非 generations 聚合目录」的代际目录。
	 *
	 * 关键路径(归属校验的入口守卫):
	 * - 目录名必须是合法代际 ID,父目录必须是本索引根的 `generations/`;
	 * - **符号链接必须解析后仍落在 `generations/<id>`** —— 解析后逃出该目录的一律不承认归属;
	 * - 入口记录必须形状自洽:schema 版本、`generationId` 与目录名逐字一致、指纹可由
	 *   {@link deriveGenerationId} 派生出同一 ID、`kind` / `status` 取值合法、`createdAt` 是数字。
	 *   伪造或缺字段的入口记录不构成归属证据。
	 * - 是否「已登记在 `control` 且非活动代际」由 {@link dropSafeGeneration} 追加校验 —
	 *   本方法只回答「这个目录是不是本框架的代际目录」。
	 *
	 * @param target - 候选目录。
	 * @returns 归属与入口记录都合法时为 true。
	 */
	async isGenerationDirectory(target: string): Promise<boolean> {
		const resolved = path.resolve(target);
		const parent = path.dirname(resolved);
		if (parent !== this.generationsRoot) return false;
		if (resolved === this.generationsRoot || resolved === this.indexRoot) return false;
		const id = path.basename(resolved);
		if (!isGenerationId(id)) return false;
		// 关键路径:符号链接必须在解析后仍指向 generations/<id>,否则递归删除会打到根外。
		const realParent = await realpathOrNull(this.generationsRoot);
		const realResolved = await realpathOrNull(resolved);
		if (realParent === null || realResolved === null) return false;
		if (realResolved !== path.join(realParent, id)) return false;
		const entry = await readGenerationEntry(path.join(realResolved, INDEX_GENERATION_ENTRY_FILENAME));
		return entry !== null && entry.generationId === id;
	}

	// --- 控制指针 ---

	/**
	 * 读取控制指针。
	 *
	 * 关键路径:文件缺失是合法的「空状态」;存在但损坏、schema 不符、活动指针指向未知代际,
	 * 或**同时存在多条 `active` 记录**(指针切换必须降级旧 active)一律以 `control-invalid` 拒绝,
	 * 不猜归属、不静默降级。
	 *
	 * @returns 控制记录;文件缺失时为空状态。
	 * @throws {IndexGenerationError} 记录损坏或不自洽(`control-invalid`)。
	 */
	async readControl(): Promise<GenerationControlRecord> {
		let raw: string;
		try {
			raw = await fs.promises.readFile(this.controlPath, 'utf8');
		} catch (error) {
			if (readErrno(error) === 'ENOENT') return { schemaVersion: INDEX_RECORD_SCHEMA_VERSION, activeGenerationId: null, generations: {} };
			throw new IndexGenerationError('control-invalid', '控制指针无法读取', { cause: error });
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new IndexGenerationError('control-invalid', '控制指针 JSON 损坏', { cause: error });
		}
		if (!isRecord(parsed)) throw new IndexGenerationError('control-invalid', '控制指针必须是对象');
		if (parsed['schemaVersion'] !== INDEX_RECORD_SCHEMA_VERSION) {
			throw new IndexGenerationError('control-invalid', '控制指针 schema 版本不符');
		}
		const active = parsed['activeGenerationId'];
		if (active !== null && !isGenerationId(active)) {
			throw new IndexGenerationError('control-invalid', '控制指针的活动代际 ID 非法');
		}
		const rawGenerations = parsed['generations'];
		if (!isRecord(rawGenerations)) throw new IndexGenerationError('control-invalid', '控制指针缺少 generations 表');
		const generations: Record<string, GenerationRecord> = {};
		for (const [id, value] of Object.entries(rawGenerations)) {
			const record = parseGenerationRecord(id, value, this.indexRoot);
			generations[id] = record;
		}
		if (active !== null && generations[active] === undefined) {
			throw new IndexGenerationError('control-invalid', `活动代际 ${active} 不在代际表中`);
		}
		// 关键路径:代际表里最多只能有一条 `active`;并存多条说明上一次切换没有降级旧 active,
		// 会让「谁是活动代际」出现两个答案,必须按损坏拒绝。
		let activeStatusCount = 0;
		for (const record of Object.values(generations)) {
			if (record.status === 'active') activeStatusCount += 1;
		}
		if (activeStatusCount > 1) {
			throw new IndexGenerationError('control-invalid', '控制指针中存在多条活动状态记录');
		}
		return { schemaVersion: INDEX_RECORD_SCHEMA_VERSION, activeGenerationId: active, generations };
	}

	/**
	 * 原子发布控制指针 — 先写同目录唯一临时文件并 flush,再 rename 覆盖,最后 flush 目标与目录。
	 *
	 * 关键路径:写盘前重新断言写所有权(`owner-not-writable`),这是「发布控制前再核对一次
	 * 可写」的统一落点。
	 *
	 * @param record - 完整控制记录。
	 * @throws {IndexGenerationError} 写所有权失效(`owner-not-writable`)或写入失败(`migration-io-failed`)。
	 */
	async writeControl(record: GenerationControlRecord): Promise<void> {
		this.assertWritable('writeControl');
		await fs.promises.mkdir(this.indexRoot, { recursive: true });
		await writeJsonAtomically(this.controlPath, record);
	}

	// --- 代际身份 ---

	/**
	 * 迁移旧索引到独立代际 — 入口转发到 {@link GenerationMigrationEngine}。
	 *
	 * 关键路径:迁移必须在 owner 锁内调用;本入口不自行取锁,也不做任何破坏性清理。
	 *
	 * @param input - 迁移输入。
	 * @returns 迁移结论。
	 */
	static async migrateLegacyIndex(input: GenerationMigrationInput): Promise<GenerationMigrationResult> {
		return GenerationMigrationEngine.migrateLegacyIndex(input);
	}

	/**
	 * 按配置取得(必要时创建)代际。
	 *
	 * 关键路径:
	 * - 代际 ID 由指纹派生:同一配置重复调用返回同一代际,**不反复创建空目录**;
	 * - 已存在的代际沿用其状态,不因为重新进入而重置为 `building`;
	 * - 目录与入口文件先建、`control` 后写:中断可能留下「不在代际表」的孤儿目录,
	 *   这类目录由 {@link reconcileForNewGeneration} 按入口记录自洽性回收。
	 *
	 * @param input - 配置描述。
	 * @returns 代际句柄。
	 * @throws {IndexGenerationError} 配置非法(`config-invalid`)或写所有权失效(`owner-not-writable`)。
	 */
	async ensureGeneration(input: { config: IndexConfigDescriptor }): Promise<GenerationHandle & { fingerprint: string; root: string }> {
		this.assertWritable('ensureGeneration');
		const fingerprint = await computeConfigFingerprint(input.config);
		const generationId = deriveGenerationId(fingerprint);
		const control = await this.readControl();
		const existing = control.generations[generationId];
		const generationRoot = this.generationRootOf(generationId);
		if (existing !== undefined) {
			// 关键路径:入口文件缺失时补齐,但不改变既有状态。
			await this.ensureEntryFile(generationRoot, existing);
			return { generationId, fingerprint, generationRoot, root: generationRoot, status: existing.status };
		}
		const record: GenerationRecord = {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId,
			fingerprint,
			kind: 'fresh',
			status: 'building',
			root: generationRoot,
			verifiedAt: null,
			quarantineReason: null,
			createdAt: this.now(),
			updatedAt: this.now(),
		};
		await fs.promises.mkdir(generationRoot, { recursive: true });
		await this.ensureEntryFile(generationRoot, record);
		await this.writeGenerationConfig(generationRoot, generationId, fingerprint, input.config);
		await this.writeControl({ ...control, generations: { ...control.generations, [generationId]: record } });
		return { generationId, fingerprint, generationRoot, root: generationRoot, status: record.status };
	}

	/** 按代际 ID 读取句柄。 */
	async getGenerationById(generationId: string): Promise<(GenerationRecord & { generationRoot: string }) | null> {
		const control = await this.readControl();
		const record = control.generations[generationId];
		if (record === undefined) return null;
		return { ...record, generationRoot: this.generationRootOf(generationId) };
	}

	/** 按配置指纹读取句柄 — 切回相同配置时先查这里,不新建空目录。 */
	async getGenerationByFingerprint(fingerprint: string): Promise<(GenerationRecord & { generationRoot: string }) | null> {
		const control = await this.readControl();
		for (const record of Object.values(control.generations)) {
			if (record.fingerprint !== fingerprint) continue;
			return { ...record, generationRoot: this.generationRootOf(record.generationId) };
		}
		return null;
	}

	/** 按配置读取句柄(不创建)。 */
	async getGeneration(input: { config: IndexConfigDescriptor }): Promise<(GenerationRecord & { generationRoot: string }) | null> {
		const fingerprint = await computeConfigFingerprint(input.config);
		return this.getGenerationByFingerprint(fingerprint);
	}

	/** 代际数据目录绝对路径。 */
	generationRootOf(generationId: string): string {
		if (!isGenerationId(generationId)) {
			throw new IndexGenerationError('generation-id-invalid', '代际 ID 非法');
		}
		return path.join(this.generationsRoot, generationId);
	}

	// --- 状态迁移 ---

	/**
	 * 原子登记活动代际。
	 *
	 * 关键路径(spec §5):
	 * - `upgrade`:首次建库专用 — 没有活动代际时,首个文件持久提交后即可登记为活动代际并允许
	 *   部分检索,不等待全库完成;**已有活动代际时必须改走 `configured-switch`**(那意味着
	 *   配置切换,要完成扫描、队列收敛与全部文件提交);
	 * - `configured-switch`:只接受 `migrated` **且** `verifiedAt !== null` 的目标代际 ——
	 *   `verifiedAt` 表达「本轮已完成核对」,曾被降级的活动代际在降级时被清空该标记,
	 *   因此「曾活动」不能用来跳过本轮复核;
	 * - 两种模式都拒绝已隔离(`quarantined`)或已失败(`failed`)的代际;
	 * - 切换时**必须降级旧 active**(status → `migrated`、`verifiedAt` → null),使 `control`
	 *   里任何时候最多只有一条 `active`。
	 *
	 * @param input - 目标代际与切换模式。
	 * @throws {IndexGenerationError} 目标代际未知或未被核对(`switch-not-verified` / `generation-unknown`)、
	 *   写所有权失效(`owner-not-writable`)。
	 */
	async publishActiveGeneration(input: { generationId: string; mode: 'upgrade' | 'configured-switch' }): Promise<GenerationControlRecord> {
		if (!isGenerationId(input.generationId)) {
			throw new IndexGenerationError('generation-id-invalid', '代际 ID 非法');
		}
		const control = await this.readControl();
		const record = control.generations[input.generationId];
		if (record === undefined) {
			throw new IndexGenerationError('generation-unknown', `代际 ${input.generationId} 不在代际表中`);
		}
		// 幂等:目标已经是活动代际时指针不动,也不降级任何人。
		if (control.activeGenerationId === input.generationId && record.status === 'active') return control;
		if (record.status === 'quarantined' || record.status === 'failed') {
			// 关键路径:被隔离或已失败的代际绝不允许成为活动代际 —— 它的数据不可信。
			throw new IndexGenerationError('switch-not-verified', `代际 ${input.generationId} 处于 ${record.status},不能登记为活动代际`, {
				detail: { generationId: input.generationId, status: record.status, mode: input.mode },
			});
		}
		if (input.mode === 'upgrade') {
			if (control.activeGenerationId !== null) {
				// 关键路径:升级登记只在「首次建库、没有活动代际」时成立;已有活动代际还走 upgrade
				// 等于用部分提交冒充切换依据,必须拒绝并让调用方走 configured-switch 完整核对。
				throw new IndexGenerationError('switch-not-verified', `已有活动代际 ${control.activeGenerationId},不能在 upgrade 模式下切换`, {
					detail: { generationId: input.generationId, status: record.status, mode: input.mode },
				});
			}
		} else if (record.status !== 'migrated' || record.verifiedAt === null) {
			// 关键路径:配置切换必须有「本轮已在当前文件上核对完成」的显式依据,不能凭调用方口头声明。
			throw new IndexGenerationError('switch-not-verified', `代际 ${input.generationId} 尚未完成本轮核对,不能切换活动指针`, {
				detail: { generationId: input.generationId, status: record.status, mode: input.mode },
			});
		}
		const next: Record<string, GenerationRecord> = { ...control.generations };
		for (const [id, value] of Object.entries(next)) {
			if (id === input.generationId) continue;
			if (value.status === 'active') {
				// 关键路径:降级旧 active 的同时清空 verifiedAt —— 「曾活动」不等于「本轮已核对」。
				next[id] = { ...value, status: 'migrated', verifiedAt: null, updatedAt: this.now() };
			}
		}
		next[input.generationId] = { ...record, status: 'active', updatedAt: this.now() };
		const updated: GenerationControlRecord = { ...control, activeGenerationId: input.generationId, generations: next };
		await this.writeControl(updated);
		return updated;
	}

	/**
	 * 把代际降级为「核对中」 — 切回相同配置时的第一步。
	 *
	 * 关键路径(spec §5):切回相同配置**先恢复/核对当前文件,不直接恢复旧 `ready`**;
	 * 本方法只表达「必须重新核对」(同时清空 `verifiedAt`),核对完成后再调用
	 * {@link markGenerationMigrated} 写回 `verifiedAt`,最后才允许
	 * {@link publishActiveGeneration}。
	 */
	async beginVerification(input: { generationId: string }): Promise<GenerationControlRecord> {
		const control = await this.readControl();
		const record = control.generations[input.generationId];
		if (record === undefined) throw new IndexGenerationError('generation-unknown', `代际 ${input.generationId} 不在代际表中`);
		const updated: GenerationControlRecord = {
			...control,
			generations: {
				...control.generations,
				[input.generationId]: { ...record, status: 'verifying', verifiedAt: null, updatedAt: this.now() },
			},
		};
		await this.writeControl(updated);
		return updated;
	}

	/**
	 * 代际转入 `migrated`(本轮核对完成、等待切换)。
	 *
	 * 关键路径:`verifiedAt` 由本方法写入 —— 迁移逐文件核对完成、或切回配置后的重新核对完成
	 * 都必须经过这里,`configured-switch` 只认这个标记。
	 */
	async markGenerationMigrated(input: { generationId: string }): Promise<void> {
		await this.updateGenerationStatus(input.generationId, 'migrated', { verifiedAt: this.now() });
	}

	/** 标记代际级隔离 — 存在无法归属的坏日志时停止该代际的恢复与检索。 */
	async markGenerationQuarantined(input: { generationId: string; reason: string }): Promise<GenerationControlRecord> {
		// 关键路径:原因必须随状态一起落盘,不能被丢弃 —— T7 要据此向用户说明为什么不可检索。
		return this.updateGenerationStatus(input.generationId, 'quarantined', { quarantineReason: input.reason });
	}

	/**
	 * 解除代际级隔离 — 与 T3 日志侧同一契约:必须显式确认,默认拒绝。
	 *
	 * @param input - 代际 ID 与确认位。
	 * @returns 是否执行了解除。
	 * @throws {IndexFileJournalError} 缺少显式确认(`confirmation-required`)。
	 */
	async clearGenerationQuarantine(input: { generationId: string; confirm: boolean }): Promise<boolean> {
		if (input.confirm !== true) {
			throw new IndexFileJournalError('confirmation-required', '解除代际隔离必须显式确认', { detail: { generationId: input.generationId } });
		}
		const control = await this.readControl();
		const record = control.generations[input.generationId];
		if (record === undefined) throw new IndexGenerationError('generation-unknown', `代际 ${input.generationId} 不在代际表中`);
		if (record.status !== 'quarantined') return false;
		await this.updateGenerationStatus(input.generationId, 'building', { quarantineReason: null, verifiedAt: null });
		// 关键路径:同时清掉代际内的隔离记录文件,使日志侧的门禁真正解除(记录存在即隔离、失败关闭)。
		const quarantined = path.join(this.generationRootOf(input.generationId), JOURNAL_QUARANTINE_DIRNAME, JOURNAL_GENERATION_QUARANTINE_FILENAME);
		const resolved = path.resolve(quarantined);
		if (!resolved.startsWith(`${path.resolve(this.generationRootOf(input.generationId))}${path.sep}`)) {
			throw new IndexGenerationError('generation-cleanup-path-invalid', '隔离记录路径逃出代际目录');
		}
		this.assertWritable('clearGenerationQuarantine');
		await fs.promises.rm(resolved, { force: true });
		return true;
	}

	private async updateGenerationStatus(
		generationId: string,
		status: GenerationStatus,
		patch: Partial<Pick<GenerationRecord, 'verifiedAt' | 'quarantineReason'>> = {},
	): Promise<GenerationControlRecord> {
		if (!isGenerationId(generationId)) throw new IndexGenerationError('generation-id-invalid', '代际 ID 非法');
		const control = await this.readControl();
		const record = control.generations[generationId];
		if (record === undefined) throw new IndexGenerationError('generation-unknown', `代际 ${generationId} 不在代际表中`);
		const updated: GenerationControlRecord = {
			...control,
			generations: { ...control.generations, [generationId]: { ...record, ...patch, status, updatedAt: this.now() } },
		};
		await this.writeControl(updated);
		return updated;
	}

	// --- 回收 ---

	/**
	 * 单一代际的回收探测 — 只读磁盘,不做任何删除。
	 *
	 * 关键路径:所有清理必须持有 owner 锁并校验目录归属;本方法只读,因此不要求写门面。
	 *
	 * @param generationId - 候选代际 ID。
	 * @returns 探测结论(未决事务、代际级隔离、路径隔离、取证事务目录)。
	 */
	async probeGeneration(generationId: string): Promise<GenerationReconcileProbeResult> {
		const generationRoot = this.generationRootOf(generationId);
		const journalProbe = new GenerationJournalProbe(generationRoot);
		return {
			pendingPaths: (await journalProbe.listPendingPaths()).length,
			generationQuarantined: await journalProbe.isGenerationQuarantined(),
			pathQuarantined: (await journalProbe.listPathStateFiles()).length,
			// 关键路径:`quarantine/transactions/<id>/` 是取证依据;只持这种内容的代际不活动时
			// 也必须保留,否则整代际被回收会连同唯一取证一起丢掉。
			quarantinedTransactions: (await journalProbe.listQuarantinedTransactionDirs()).length,
		};
	}

	/**
	 * 新建第三个代际前的回收决策。
	 *
	 * 关键路径(spec §5 + plan T6 checkbox 6):默认最多「活动 + 一个待建/回退」;需要第三个时,
	 * 只回收**不活动、不在提交、无未解决事务**的代际;不能回收时暂停新建并报告占用,
	 * **保留可用活动索引**(活动代际永不回收)。
	 *
	 * @param input - 探测结论表与请求新建的指纹。
	 * @returns 回收决策。
	 */
	async reconcileForNewGeneration(input: {
		probes: ReadonlyMap<string, GenerationReconcileProbeResult>;
		requestedFingerprint: string;
	}): Promise<GenerationReconcileDecision> {
		this.assertWritable('reconcileForNewGeneration');
		const control = await this.readControl();
		const reclaimed: string[] = [];
		const retained: string[] = [];
		const active = control.activeGenerationId;
		for (const [generationId, record] of Object.entries(control.generations)) {
			// 关键路径:活动代际由规则保留,不属于「未能回收」;它永不进入回收候选。
			if (generationId === active) continue;
			const probe = input.probes.get(generationId) ?? emptyReconcileProbe();
			const inFlight = record.status === 'building' || record.status === 'verifying';
			const unresolved = probe.pendingPaths > 0
				|| probe.generationQuarantined
				|| probe.pathQuarantined > 0
				|| probe.quarantinedTransactions > 0;
			if (inFlight) {
				// 关键路径:正在构建/核对的代际属于「待建的那一个」,不能因为要腾位就被回收。
				retained.push(generationId);
				continue;
			}
			if (unresolved) {
				retained.push(generationId);
				continue;
			}
			if (record.fingerprint === input.requestedFingerprint) {
				// 同配置已存在,由 `ensureGeneration` 复用,不涉及新建。
				retained.push(generationId);
				continue;
			}
			await this.dropSafeGeneration(this.generationRootOf(generationId));
			const next = await this.readControl();
			const rest = { ...next.generations };
			delete rest[generationId];
			await this.writeControl({ ...next, generations: rest });
			reclaimed.push(generationId);
		}
		// 关键路径:回收未登记的孤儿目录 —— `ensureGeneration` 先建目录/入口、后写 control,
		// 中断留下的目录永远不在 `control.generations` 里,只扫代际表是发现不了它们的。
		const orphanDirectories = await this.reclaimOrphanGenerationDirectories(control.generations);
		if (reclaimed.length === 0 && retained.length > 0) {
			// 关键路径:候选里有需要保留的代际且本次一个都没回收到 → 暂停新建并报告占用。
			// 说明:回收循环会清掉所有「可回收的非活动代际」,因此「达到默认上限」与
			// 「一个都回收不了」在本实现里是同一条件,不拆成两个原因名冒充独立语义。
			return { reclaimed, orphanDirectories, retained, canCreate: false, blockedReason: 'all-generations-retained' };
		}
		return { reclaimed, orphanDirectories, retained, canCreate: true, blockedReason: null };
	}

	/**
	 * 回收未登记在 `control` 的孤儿代际目录。
	 *
	 * 关键路径:孤儿目录没有 `control` 记录可核对,因此这里用**更严的条件**代替登记校验:
	 * 目录名合法、父目录正确、符号链接解析后不逃出 `generations/`、入口记录形状自洽,
	 * 且 `deriveGenerationId(entry.fingerprint) === 目录名`(证明它与代际 ID 派生规则一致)。
	 * 任何一条不满足一律不动它 —— 宁可留下待报告,也不误删来历不明的目录。
	 *
	 * @param registered - `control` 里的代际表。
	 * @returns 实际删除的孤儿目录 ID。
	 */
	private async reclaimOrphanGenerationDirectories(registered: Record<string, GenerationRecord>): Promise<string[]> {
		const reclaimed: string[] = [];
		for (const entry of await readDirOrEmpty(this.generationsRoot)) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const generationId = entry.name;
			if (!isGenerationId(generationId)) continue;
			if (registered[generationId] !== undefined) continue;
			const target = path.join(this.generationsRoot, generationId);
			if (path.dirname(path.resolve(target)) !== this.generationsRoot) continue;
			const realParent = await realpathOrNull(this.generationsRoot);
			const realTarget = await realpathOrNull(target);
			if (realParent === null || realTarget === null) continue;
			if (realTarget !== path.join(realParent, generationId)) continue;
			const record = await readGenerationEntry(path.join(realTarget, INDEX_GENERATION_ENTRY_FILENAME));
			if (record === null || record.generationId !== generationId) continue;
			if (deriveGenerationId(record.fingerprint) !== generationId) continue;
			// 关键路径(TOCTOU):入口断言与这里之间隔了多次 await(realpath + 读入口文件),
			// 期间 owner 可能已被接管。递归删除是不可逆动作,必须在**紧邻删除处**再断言一次,
			// 不能只依赖 `reconcileForNewGeneration` 入口的那次断言。
			this.assertWritable('reclaimOrphanGenerationDirectories');
			await fs.promises.rm(realTarget, { recursive: true, force: true });
			reclaimed.push(generationId);
		}
		return reclaimed.sort((left, right) => left.localeCompare(right));
	}

	/**
	 * 安全删除一个代际目录 — 唯一允许的递归删除入口。
	 *
	 * 关键路径:删除前必须同时满足
	 * 1. 在 `generations/` 下、目录名是合法代际 ID(解析符号链接后仍在 `generations/<id>`);
	 * 2. 带形状自洽的代际入口文件({@link isGenerationDirectory});
	 * 3. **已登记在 `control` 且不是当前活动代际** —— 伪造入口、未登记目录、活动代际都不允许清理;
	 * 4. 当前仍持有写所有权(`owner-not-writable`)。
	 *
	 * `.index/` 根与 `generations/` 聚合目录一律拒绝;未登记的孤儿目录不走本入口
	 * (由 {@link reconcileForNewGeneration} 用更严的自洽性条件回收)。
	 *
	 * @param target - 代际目录绝对路径。
	 * @throws {IndexGenerationError} 目标不属于本索引根下已登记的非活动代际目录
	 *   (`generation-not-droppable` / `generation-directory-foreign` / `generation-unknown`)。
	 */
	async dropSafeGeneration(target: string): Promise<void> {
		const resolved = path.resolve(target);
		if (resolved === this.indexRoot || resolved === this.generationsRoot) {
			throw new IndexGenerationError('generation-not-droppable', '禁止递归删除 .index 根或 generations 聚合目录', { detail: { target: resolved } });
		}
		if (path.dirname(resolved) !== this.generationsRoot) {
			throw new IndexGenerationError('generation-not-droppable', '目标不在索引根的 generations 目录下', { detail: { target: resolved } });
		}
		const generationId = path.basename(resolved);
		if (!isGenerationId(generationId)) {
			throw new IndexGenerationError('generation-not-droppable', '目标目录名不是合法代际 ID', { detail: { target: resolved } });
		}
		if (!(await this.isGenerationDirectory(resolved))) {
			throw new IndexGenerationError('generation-directory-foreign', '目标目录缺少形状自洽的代际入口,拒绝清理', { detail: { target: resolved } });
		}
		const control = await this.readControl();
		if (control.generations[generationId] === undefined) {
			throw new IndexGenerationError('generation-unknown', `代际 ${generationId} 未登记在控制指针中,拒绝清理`, { detail: { target: resolved } });
		}
		if (control.activeGenerationId === generationId || control.generations[generationId]?.status === 'active') {
			throw new IndexGenerationError('generation-not-droppable', `代际 ${generationId} 仍是活动代际,拒绝清理`, { detail: { target: resolved } });
		}
		this.assertWritable('dropSafeGeneration');
		await fs.promises.rm(resolved, { recursive: true, force: true });
	}

	/**
	 * 清理旧 Vectra 文件白名单。
	 *
	 * 关键路径(T1/T2 证据 §5.2、spec §5):
	 * - 只删 `verifiedFiles` 里**逐个核验过**的文件名,且文件名必须在旧 Vectra 白名单内;
	 * - `control.json`、`owner.lock`、`owner.recovery.lock`、`generations/` 与未知文件一律保留;
	 * - 目录(含 `generations/`)、符号链接与其它非普通文件一律只报告、绝不删除;
	 * - 绝不把目录本身传给递归删除;清理前断言写所有权。
	 *
	 * @param input - 目标目录与已验证文件名。
	 * @returns 已删除与保留的文件名(保留项包含目录与符号链接)。
	 */
	async cleanupLegacyIndexFiles(input: { targetDir: string; verifiedFiles: readonly string[] }): Promise<{ removed: string[]; retained: string[] }> {
		this.assertWritable('cleanupLegacyIndexFiles');
		const targetDir = path.resolve(input.targetDir);
		const verified = new Set(input.verifiedFiles);
		const removed: string[] = [];
		const retained: string[] = [];
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
		} catch (error) {
			if (readErrno(error) === 'ENOENT') return { removed, retained };
			throw new IndexGenerationError('migration-io-failed', '读取旧索引目录失败', { cause: error });
		}
		for (const entry of entries) {
			// 关键路径:目录(例如 `generations/`)与符号链接必须出现在 `retained` 报告里 ——
			// 它们不会被删除,但「没被报告」会让调用方以为它们不存在。
			if (!entry.isFile()) {
				retained.push(entry.name);
				continue;
			}
			// 关键路径:受保护的根文件即使被列进白名单也绝不删除 —— 这是最后一道守卫。
			if ((INDEX_GENERATION_PROTECTED_ROOT_FILES as readonly string[]).includes(entry.name) || entry.name === INDEX_GENERATIONS_DIRNAME) {
				retained.push(entry.name);
				continue;
			}
			if (!verified.has(entry.name) || legacyIndexFileKind(entry.name) === null) {
				retained.push(entry.name);
				continue;
			}
			const filePath = path.join(targetDir, entry.name);
			if (path.dirname(path.resolve(filePath)) !== targetDir) {
				throw new IndexGenerationError('generation-cleanup-path-invalid', '清理目标逃出旧索引目录', { detail: { file: filePath } });
			}
			await fs.promises.rm(filePath, { force: true });
			removed.push(entry.name);
		}
		return { removed, retained };
	}

	// --- 内部 ---

	/**
	 * 写代际目录内的 `config.json` 快照 — 代际身份与配置身份都在此可读。
	 *
	 * 关键路径:这是**公开写入口**(装配层与迁移引擎都会直接调用),因此写盘前必须自己断言
	 * 写所有权 —— 不能依赖调用方在其入口处断言过:迁移从入口断言到这里的同步复制之间隔着
	 * 大量 await,owner 有足够窗口被接管。
	 *
	 * @param generationRoot - 代际目录。
	 * @param generationId - 代际 ID。
	 * @param fingerprint - 配置指纹。
	 * @param config - 生效配置描述。
	 * @throws {IndexGenerationError} 写所有权已失效(`owner-not-writable`);抛出前不写任何文件。
	 */
	async writeGenerationConfig(
		generationRoot: string,
		generationId: string,
		fingerprint: string,
		config: IndexConfigDescriptor,
	): Promise<void> {
		this.assertWritable('writeGenerationConfig');
		const snapshot: GenerationConfigRecord = {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId,
			fingerprint,
			config,
			writtenAt: this.now(),
		};
		await fs.promises.mkdir(generationRoot, { recursive: true });
		await writeJsonAtomically(path.join(generationRoot, INDEX_GENERATION_CONFIG_FILENAME), snapshot);
	}

	/**
	 * 写(或刷新)代际目录内的手工入口文件。
	 *
	 * 关键路径:与 {@link writeGenerationConfig} 同为**公开写入口**,写盘前必须自己断言写
	 * 所有权;入口文件是「目录是不是本框架代际目录」的归属证据,不能让失效 owner 补写它。
	 *
	 * @param generationRoot - 代际目录。
	 * @param record - 代际记录。
	 * @throws {IndexGenerationError} 写所有权已失效(`owner-not-writable`);抛出前不写任何文件。
	 */
	async writeGenerationEntry(generationRoot: string, record: GenerationRecord): Promise<void> {
		this.assertWritable('writeGenerationEntry');
		await this.ensureEntryFile(generationRoot, record);
	}

	/** 补齐(或刷新)代际入口文件。 */
	private async ensureEntryFile(generationRoot: string, record: GenerationRecord): Promise<void> {
		const entry: GenerationEntryRecord = {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId: record.generationId,
			fingerprint: record.fingerprint,
			kind: record.kind,
			status: record.status,
			createdAt: record.createdAt,
		};
		await fs.promises.mkdir(generationRoot, { recursive: true });
		await writeJsonAtomically(path.join(generationRoot, INDEX_GENERATION_ENTRY_FILENAME), entry);
	}
}

// ==================== 迁移 ====================

/**
 * 代际迁移引擎 — 在 owner 锁内把有效旧索引只读复制到独立代际目录并发布控制指针。
 *
 * 关键路径:
 * - 复制只作用于**旧 Vectra 文件白名单**,逐个核对 sha256 后写入复制摘要;
 * - 复制中断可重入:已复制且摘要一致的文件直接复用,不重复嵌入;
 * - 空间不足只报告失败,不先删旧数据腾空间;
 * - 全部文件核对完成后才原子发布控制指针;失败不留下「活动代际已切换」的半成品。
 *
 * @example
 *   const result = await IndexGenerations.migrateLegacyIndex({ indexRoot, generations, config, legacy, owner, currentInputs, chunkLimits });
 */
export class GenerationMigrationEngine {
	private readonly input: GenerationMigrationInput;
	private readonly now: () => number;

	private constructor(input: GenerationMigrationInput) {
		this.input = input;
		this.now = input.now ?? Date.now;
	}

	/**
	 * 执行(或续做)一次旧索引迁移。
	 *
	 * @param input - 迁移输入。
	 * @returns 迁移结论;失败时 `published === false` 且 `reason` 有值,不抛出可预期的失败。
	 */
	static async migrateLegacyIndex(input: GenerationMigrationInput): Promise<GenerationMigrationResult> {
		const engine = new GenerationMigrationEngine(input);
		return engine.run();
	}

	private fail(
		phase: GenerationMigrationPhase,
		reason: MigrationFailureReason,
		errorCode: IndexGenerationErrorCode,
		generationId: string | null,
		fingerprint: string | null,
		files: GenerationFileValidation[] = [],
	): GenerationMigrationResult {
		return {
			published: false,
			committed: false,
			generationId,
			activeGenerationId: null,
			configFingerprint: fingerprint,
			files,
			phase,
			reason,
			errorCode,
			copiedFileNames: [],
			copiedBytes: 0,
			statePersisted: false,
		};
	}

	/** 读取控制指针的真实活动代际 — 只用于写失败后的回读复核,读不到时返回 null。 */
	private async readActiveGenerationId(): Promise<string | null> {
		try {
			return (await this.input.generations.readControl()).activeGenerationId;
		} catch {
			return null;
		}
	}

	private async run(): Promise<GenerationMigrationResult> {
		const input = this.input;

		// --- 1. 身份前提:owner 仍可写 + 配置身份可确认 ---
		try {
			input.owner.assertWritable();
		} catch {
			return this.fail('inspect', 'owner-not-writable', 'migration-io-failed', null, null);
		}
		const identity = confirmsLegacyConfigIdentity(input.config);
		if (!identity.confirmed) {
			return this.fail('inspect', 'config-identity-unconfirmed', 'config-identity-unconfirmed', null, null);
		}

		// --- 2. 旧清单可判定性 ---
		let manifest: IndexManifestData;
		try {
			manifest = JSON.parse(await fs.promises.readFile(input.legacy.manifestPath, 'utf8')) as IndexManifestData;
		} catch {
			return this.fail('inspect', 'legacy-manifest-invalid', 'legacy-manifest-invalid', null, null);
		}
		if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.entries)) {
			return this.fail('inspect', 'legacy-manifest-invalid', 'legacy-manifest-invalid', null, null);
		}
		const legacyIdentity = mapLegacyConfigIdentity(manifest, {
			embeddingDimension: input.config.embeddingDimension,
		});
		if (legacyIdentity === null) {
			// 关键路径(B1):缺 `chunkerVersion` 且其余分块输入齐全时,清单本身合法、只是分块身份
			// 不可确认 —— 必须报 `config-identity-unconfirmed`(走显式重建入口),而不是「清单非法」;
			// 其余缺失/非法字段才按清单不可信处理。两条路径都不复用任何旧块。
			const unconfirmable = isChunkerGenerationUnconfirmable(manifest) || !Number.isInteger(input.config.embeddingDimension) || input.config.embeddingDimension <= 0;
			if (unconfirmable) {
				return this.fail('inspect', 'config-identity-unconfirmed', 'config-identity-unconfirmed', null, null);
			}
			return this.fail('inspect', 'legacy-manifest-invalid', 'legacy-manifest-invalid', null, null);
		}
		// 关键路径:旧清单里的模型标识必须与当前配置可比较;分块参数不一致同样按不兼容处理。
		const legacyConfirmed = confirmsLegacyConfigIdentity(legacyIdentity);
		if (!legacyConfirmed.confirmed) {
			return this.fail('inspect', 'config-identity-unconfirmed', 'config-identity-unconfirmed', null, null);
		}
		if (legacyIdentity.embeddingModelId !== input.config.embeddingModelId
			|| legacyIdentity.chunkSize !== input.chunkLimits.chunkSize
			|| legacyIdentity.chunkOverlap !== input.chunkLimits.chunkOverlap
			|| legacyIdentity.chunkerVersion !== input.config.chunkerVersion) {
			return this.fail('inspect', 'config-identity-unconfirmed', 'config-identity-unconfirmed', null, null);
		}
		if (!fs.existsSync(input.legacy.legacyIndexDir)) {
			return this.fail('inspect', 'legacy-index-missing', 'legacy-index-missing', null, null);
		}
		// 关键路径(T6 checkbox 1):旧索引可能没有构建戳 —— 缺失不构成不兼容,
		// 但戳存在却不可解析说明索引形态不可证明,必须按不兼容处理。
		const stampOutcome = await readBuildStampOutcome(input.legacy.legacyIndexDir);
		if (stampOutcome.result === 'unreadable') {
			return this.fail('inspect', 'legacy-manifest-invalid', 'legacy-manifest-invalid', null, null);
		}
		if (stampOutcome.result === 'present' && stampOutcome.stamp !== null) {
			const stamp = stampOutcome.stamp;
			if (stamp.embedModelId !== legacyIdentity.embeddingModelId
				|| stamp.chunkSize !== legacyIdentity.chunkSize
				|| stamp.chunkOverlap !== legacyIdentity.chunkOverlap
				|| stamp.chunkerVersion !== legacyIdentity.chunkerVersion) {
				// 清单与构建戳互相矛盾,无法证明任何一侧的身份。
				return this.fail('inspect', 'config-identity-unconfirmed', 'config-identity-unconfirmed', null, null);
			}
		}

		// --- 3. 代际身份与复制进度 ---
		const fingerprint = await computeConfigFingerprint(input.config);
		const generationId = deriveGenerationId(fingerprint);
		const generationRoot = input.generations.generationRootOf(generationId);
		const statePath = path.join(generationRoot, INDEX_GENERATION_MIGRATION_STATE_FILENAME);
		const copied = new Map<string, string>();
		try {
			const raw = JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as unknown;
			if (isRecord(raw) && isRecord(raw['copied'])) {
				for (const [name, digest] of Object.entries(raw['copied'])) {
					if (typeof digest === 'string') copied.set(name, digest);
				}
			}
		} catch {
			// 进度文件缺失或损坏:从头复制,已存在的文件仍按摘要复用。
		}

		// --- 4. 复制白名单文件 ---
		const copyOutcome = await this.copyLegacyFiles(input.legacy.legacyIndexDir, generationRoot, copied);
		if (copyOutcome.failure !== null) {
			return this.fail(
				'copy',
				copyOutcome.failure === 'space' ? 'space-insufficient' : 'io-failed',
				copyOutcome.failure === 'space' ? 'migration-space-insufficient' : 'migration-io-failed',
				generationId,
				fingerprint,
			);
		}

		// --- 5. 逐文件兼容校验(不调用模型、不调用分块器) ---
		const validations = await this.validateLegacyFiles(manifest, input.currentInputs, input.legacy.store, generationRoot);

		// --- 6. 写完成记录 ---
		const receiptOutcome = await this.writeReceipts(generationRoot, generationId, fingerprint, validations);
		if (receiptOutcome.failure !== null) {
			return this.fail('receipts', 'io-failed', 'migration-io-failed', generationId, fingerprint, validations);
		}

		// --- 7. 原子发布控制指针 ---
		// 关键路径:
		// - 先把代际登记进 `control`(status `migrated` + `verifiedAt`,不抢活动指针),
		//   再走与常规切换**同一处状态机** `publishActiveGeneration` 发布 —— 迁移发布同样受
		//   「两种模式都校验目标状态」「必须降级旧 active」的约束,不再单独抢指针;
		// - 写失败后回读 `control` 复核:只要指针已经指向本代际,`published` 就如实为 true,
		//   不被写盘异常改写成「未发布」;
		// - 迁移进度状态文件属于发布后的收尾,写失败只影响 `statePersisted`,不影响 `published`。
		const published = await this.publishOnce(generationId, generationRoot, existing => ({
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId,
			fingerprint,
			kind: 'legacy-migration',
			// 关键路径:同一配置重复迁移时,已是活动代际的记录保持 `active`,不能让登记动作
			// 把「控制指针指向的活动代际」短暂降级成 `migrated`。
			status: existing?.status === 'active' ? 'active' : 'migrated',
			root: generationRoot,
			// 迁移已逐文件核对块集合与完成记录,因此 `verifiedAt` 表示「本轮核对已完成」。
			verifiedAt: this.now(),
			quarantineReason: null,
			createdAt: existing?.createdAt ?? this.now(),
			updatedAt: this.now(),
		}));
		if (published !== 'published') {
			return published === 'owner-lost'
				? this.fail('publish', 'owner-not-writable', 'owner-not-writable', generationId, fingerprint, validations)
				: this.fail('publish', 'io-failed', 'migration-io-failed', generationId, fingerprint, validations);
		}
		const activeGenerationId = await this.readActiveGenerationId();
		const statePersisted = await this.persistMigrationState(statePath, copied);

		return {
			published: true,
			committed: true,
			generationId,
			activeGenerationId: activeGenerationId ?? generationId,
			configFingerprint: fingerprint,
			files: validations,
			phase: 'done',
			reason: null,
			errorCode: null,
			copiedFileNames: copyOutcome.copiedNames,
			copiedBytes: copyOutcome.bytes,
			statePersisted,
		};
	}

	/**
	 * 登记并发布代际 — 写失败后回读 `control` 复核真实状态。
	 *
	 * 关键路径:控制指针的原子写可能「已 rename 生效但后续 flush 抛错」;这时若直接把异常当成
	 * 「未发布」,返回结论就与磁盘相反。因此失败后回读控制指针:指针确实指向目标代际时按已发布
	 * 处理,否则才如实失败。
	 *
	 * @param generationId - 目标代际。
	 * @param generationRoot - 代际目录。
	 * @param buildRecord - 由既有记录构造本次登记记录。
	 * @returns `published`(已发布)/ `owner-lost`(发布前写所有权失效)/ `failed`(写入失败且未发布)。
	 */
	private async publishOnce(
		generationId: string,
		generationRoot: string,
		buildRecord: (existing: GenerationRecord | null) => GenerationRecord,
	): Promise<'published' | 'owner-lost' | 'failed'> {
		const input = this.input;
		try {
			const existing = await input.generations.getGenerationById(generationId);
			const record = buildRecord(existing);
			// 关键路径:先补齐代际目录内的手工入口与配置快照(原子写),再登记/发布控制指针 ——
			// 控制指针一旦指向该代际,目录内的身份文件必须已经就绪。
			await input.generations.writeGenerationConfig(generationRoot, generationId, record.fingerprint, input.config);
			await input.generations.writeGenerationEntry(generationRoot, record);
			const control = await input.generations.readControl();
			// 只登记,不动活动指针:发布交给同一处状态机,避免出现两条 `active`。
			await input.generations.writeControl({ ...control, generations: { ...control.generations, [generationId]: record } });
			// 发布前再断言一次写所有权 —— 迁移可能耗时很久,epoch 有足够窗口被接管。
			input.owner.assertWritable();
			await input.generations.publishActiveGeneration({ generationId, mode: 'configured-switch' });
			return 'published';
		} catch (error) {
			// 关键路径:写所有权失效与「写失败」是两种结论;前者必须如实报告,不能被压成 io-failed。
			const ownerLost = error instanceof IndexGenerationError && error.code === 'owner-not-writable';
			if ((await this.readActiveGenerationId()) === generationId) return 'published';
			return ownerLost ? 'owner-lost' : 'failed';
		}
	}

	/** 写迁移进度状态文件 — 独立于发布判定,失败只反映在 `statePersisted`。 */
	private async persistMigrationState(statePath: string, copied: ReadonlyMap<string, string>): Promise<boolean> {
		const io = this.input.io;
		if (io?.failMigrationStateWrite !== undefined) return false;
		try {
			await writeJsonAtomically(statePath, {
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				copied: Object.fromEntries(copied),
			});
			return true;
		} catch {
			return false;
		}
	}

	/** 复制旧 Vectra 文件白名单到代际目录 — 已复制且摘要一致的文件直接复用。 */
	private async copyLegacyFiles(
		legacyDir: string,
		generationRoot: string,
		copied: Map<string, string>,
	): Promise<{ failure: 'space' | 'io' | null; bytes: number; copiedNames: string[] }> {
		const io = this.input.io;
		const statePath = path.join(generationRoot, INDEX_GENERATION_MIGRATION_STATE_FILENAME);
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(legacyDir, { withFileTypes: true });
		} catch (error) {
			if (readErrno(error) === 'ENOENT') return { failure: 'io', bytes: 0, copiedNames: [] };
			return { failure: 'io', bytes: 0, copiedNames: [] };
		}
		await fs.promises.mkdir(generationRoot, { recursive: true });
		let bytes = 0;
		const copiedNames: string[] = [];
		// 关键路径:进度状态文件按「文件数阈值」或「字节阈值」批量刷新,阶段结束再强制刷一次。
		// 每复制一个文件就把整个 `copied` map 序列化落盘是 O(N²) 写盘(状态文件本身随 N 增长)。
		let pendingFiles = 0;
		let pendingBytes = 0;
		const flushState = async (force: boolean): Promise<void> => {
			if (!force && pendingFiles < MIGRATION_STATE_FLUSH_FILE_INTERVAL && pendingBytes < MIGRATION_STATE_FLUSH_BYTE_INTERVAL) return;
			if (!force && pendingFiles === 0 && pendingBytes === 0) return;
			const payload = JSON.stringify({ schemaVersion: INDEX_RECORD_SCHEMA_VERSION, copied: Object.fromEntries(copied) }, null, 2);
			await writeJsonText(statePath, payload);
			io?.onStateFlush?.({ copied: copied.size, payloadBytes: payload.length });
			pendingFiles = 0;
			pendingBytes = 0;
		};
		const finish = async (failure: 'space' | 'io' | null): Promise<{ failure: 'space' | 'io' | null; bytes: number; copiedNames: string[] }> => {
			// 关键路径:阶段结束(含失败退出)强制刷一次,保证中断后重入时进度不丢。
			try {
				await flushState(true);
			} catch {
				return { failure: 'io', bytes, copiedNames };
			}
			return { failure, bytes, copiedNames };
		};
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (!entry.isFile()) continue;
			// 关键路径:只有旧 Vectra 白名单文件参与复制;未知文件与保护文件原地保留、不参与。
			const kind = legacyIndexFileKind(entry.name);
			if (kind === null) continue;
			const sourcePath = path.join(legacyDir, entry.name);
			const targetPath = path.join(generationRoot, entry.name);
			let buffer: Buffer;
			try {
				buffer = await fs.promises.readFile(sourcePath);
			} catch {
				return await finish('io');
			}
			const digest = createDigest(buffer);
			const recorded = copied.get(entry.name);
			if (recorded === digest && await fileDigest(targetPath) === digest) {
				continue;
			}
			// 空间预算:超预算只报告失败,不删除旧数据、不回滚已复制文件(下次可续)。
			if (this.input.spaceBudgetBytes !== undefined && bytes + buffer.byteLength > this.input.spaceBudgetBytes) {
				return await finish('space');
			}
			if (io?.failAfterBytes !== undefined && bytes >= io.failAfterBytes) {
				return await finish(io.failErrno === 'ENOSPC' ? 'space' : 'io');
			}
			try {
				await fs.promises.writeFile(targetPath, buffer);
			} catch (error) {
				const errno = readErrno(error) ?? io?.failErrno ?? null;
				return await finish(errno === 'ENOSPC' ? 'space' : 'io');
			}
			if (createDigest(await fs.promises.readFile(targetPath)) !== digest) {
				return await finish('io');
			}
			copied.set(entry.name, digest);
			copiedNames.push(entry.name);
			bytes += buffer.byteLength;
			pendingFiles += 1;
			pendingBytes += buffer.byteLength;
			try {
				await flushState(false);
			} catch {
				return { failure: 'io', bytes, copiedNames };
			}
		}
		return await finish(null);
	}

	/**
	 * 逐文件核对旧数据是否可复用 — 完整检查块 ID/序号、边界与结构元数据、维度、有限值与多余块。
	 *
	 * 关键路径(批量枚举接缝):块枚举优先走 `store.inspectFiles`(一次枚举、调用方分组),
	 * 方法缺失或整体失败时逐条回退 `store.inspectFile`;两条路径必须给出完全一致的结论。
	 *
	 * @param manifest - 旧清单。
	 * @param currentInputs - 当前内容 hash 视图。
	 * @param store - 旧索引只读枚举面。
	 * @param generationRoot - 迁移目标代际目录 — 用于核对代际内既有的完成记录是否过期。
	 * @returns 全部文件的结论(含需重算的)。
	 */
	private async validateLegacyFiles(
		manifest: IndexManifestData,
		currentInputs: ReadonlyMap<string, string | null>,
		store: GenerationLegacyBlockStore,
		generationRoot: string,
	): Promise<GenerationFileValidation[]> {
		const expectedDimension = this.input.expectedDimension ?? this.input.config.embeddingDimension;
		const results: GenerationFileValidation[] = [];
		/** 通过前置校验、真正需要枚举块集合的路径(批量枚举只覆盖这些)。 */
		const eligible: Array<{ path: string; declaredChunkCount: number; inputHash: string }> = [];
		for (const [filePath, entry] of Object.entries(manifest.entries).sort(([left], [right]) => left.localeCompare(right))) {
			// 关键路径(T6 checkbox 1):条目先过字段级校验;`chunkCount === 0` 单独标记,
			// 由实际存储决定是「空文件」还是「清单不可信」。
			const parsed = parseLegacyManifestEntry(filePath, entry);
			const declaredChunkCount = typeof entry.chunkCount === 'number' ? entry.chunkCount : -1;
			const inputHash = typeof entry.hash === 'string' ? entry.hash : '';
			const base: Omit<GenerationFileValidation, 'status' | 'reason' | 'actualChunkCount' | 'blockSetHash' | 'commitId'> = {
				path: filePath,
				inputHash,
				declaredChunkCount,
			};
			if (!parsed.ok && parsed.reason !== 'entry-chunk-count-zero') {
				results.push({ ...base, status: 'reindex', reason: 'manifest-entry-missing', actualChunkCount: 0, blockSetHash: null, commitId: null });
				continue;
			}
			if (inputHash.length === 0 || !Number.isInteger(declaredChunkCount) || declaredChunkCount < 0) {
				results.push({ ...base, status: 'reindex', reason: 'manifest-entry-missing', actualChunkCount: 0, blockSetHash: null, commitId: null });
				continue;
			}
			const current = currentInputs.get(filePath);
			if (current === undefined || current === null || current !== inputHash) {
				results.push({ ...base, status: 'reindex', reason: 'input-hash-mismatch', actualChunkCount: 0, blockSetHash: null, commitId: null });
				continue;
			}
			eligible.push({ path: filePath, declaredChunkCount, inputHash });
		}

		// 批量枚举:一次拿回全部可枚举路径的块集合;方法缺失或抛错时保持 null,逐条回退。
		let enumerated: Map<string, PreparedBlock[]> | null = null;
		if (eligible.length > 0 && typeof store.inspectFiles === 'function') {
			try {
				enumerated = await store.inspectFiles(eligible.map((item) => item.path));
			} catch {
				enumerated = null;
			}
		}

		for (const item of eligible) {
			const base = { path: item.path, inputHash: item.inputHash, declaredChunkCount: item.declaredChunkCount };
			const push = (status: GenerationFileValidation['status'], reason: GenerationFileReason | null, actualChunkCount: number): void => {
				results.push({ ...base, status, reason, actualChunkCount, blockSetHash: null, commitId: null });
			};
			let blocks: PreparedBlock[];
			if (enumerated !== null) {
				const batch = enumerated.get(item.path);
				if (batch === undefined) {
					// 批量枚举没有给出该路径 → 与「枚举不到块」同义,按不可复用处理。
					push('reindex', 'legacy-block-missing', 0);
					continue;
				}
				blocks = batch;
			} else {
				try {
					blocks = await store.inspectFile(item.path);
				} catch {
					push('reindex', 'legacy-block-missing', 0);
					continue;
				}
			}
			const verdict = validateLegacyFileBlocks({ path: item.path, blocks, declaredChunkCount: item.declaredChunkCount, expectedDimension });
			if (verdict.reason !== null) {
				push('reindex', verdict.reason, blocks.length);
				continue;
			}
			const blockSetHash = await computeBlockSetHash(blocks);
			// 关键路径:代际内既有的完成记录若描述的是另一套块集合,说明旧数据在两次迁移之间变了 ——
			// 记录已过期,不能当作本次核对通过,必须重算并清掉这条陈旧记录。
			const stale = await this.readStaleReceipt(generationRoot, item.path, blockSetHash);
			if (stale) {
				push('reindex', 'block-set-hash-mismatch', blocks.length);
				continue;
			}
			results.push({
				...base,
				status: 'reusable',
				reason: null,
				actualChunkCount: blocks.length,
				blockSetHash,
				commitId: readCommitId(blocks),
			});
		}
		// 关键路径:本轮判定不可复用的路径一律清掉代际内的完成记录,维持
		// 「有记录 ⇒ 本轮已核对通过」这一不变式(`verifyReceipt.matches` 不比对 inputHash,
		// 留下陈旧记录会给调用方一个「当前内容已索引」的假象)。
		for (const item of results) {
			if (item.status !== 'reindex') continue;
			await this.discardReceipt(generationRoot, item.path);
		}
		return results;
	}

	/**
	 * 判断代际内既有完成记录是否已被块集合变化淘汰。
	 *
	 * 关键路径:记录损坏、路径不一致或块集合校验和不同,都说明它描述的已经不是磁盘上的
	 * 这套块集合;此时不能把本次核对当作通过。删除由调用方的收尾清扫统一执行
	 * ({@link discardReceipt})。
	 *
	 * @param generationRoot - 代际目录。
	 * @param filePath - 文件相对路径。
	 * @param blockSetHash - 本次重新计算的块集合校验和。
	 * @returns 记录存在但不再可信时为 true。
	 */
	private async readStaleReceipt(generationRoot: string, filePath: string, blockSetHash: string): Promise<boolean> {
		const target = path.join(generationRoot, JOURNAL_FILES_DIRNAME, `${sha256Sync(filePath)}.json`);
		let raw: string;
		try {
			raw = await fs.promises.readFile(target, 'utf8');
		} catch {
			return false;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return true;
		}
		if (!isRecord(parsed)) return true;
		if (parsed['path'] !== filePath) return true;
		return parsed['blockSetHash'] !== blockSetHash;
	}

	/**
	 * 删除某路径在代际内的完成记录 — 本轮判定不可复用的路径不得留下任何记录。
	 *
	 * 关键路径:`IndexFileJournal.verifyReceipt` 的 `matches` 只比对块集合/块数/commitId,
	 * **不比对 inputHash**;因此陈旧记录若留在磁盘上,调用方只看 `matches` 就会把它当作
	 * 「当前内容已索引」的证据。迁移这边是这些记录的唯一写入者,必须自己保证
	 * 「有记录 ⇒ 本轮核对通过」这一不变式。
	 *
	 * @param generationRoot - 代际目录。
	 * @param filePath - 文件相对路径。
	 */
	private async discardReceipt(generationRoot: string, filePath: string): Promise<void> {
		const target = path.join(generationRoot, JOURNAL_FILES_DIRNAME, `${sha256Sync(filePath)}.json`);
		await fs.promises.rm(target, { force: true });
	}

	/** 把可复用文件写成代际内的完成记录(receipt)。 */
	private async writeReceipts(
		generationRoot: string,
		generationId: string,
		fingerprint: string,
		validations: readonly GenerationFileValidation[],
	): Promise<{ failure: string | null }> {
		const filesDir = path.join(generationRoot, JOURNAL_FILES_DIRNAME);
		try {
			await fs.promises.mkdir(filesDir, { recursive: true });
		} catch {
			return { failure: 'io' };
		}
		const revision = 1;
		for (const validation of validations) {
			if (validation.status !== 'reusable' || validation.blockSetHash === null || validation.commitId === null) continue;
			if (this.input.io?.failReceiptWrite !== undefined) return { failure: 'io' };
			const commit: FileCommit = {
				schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
				generationId,
				path: validation.path,
				configFingerprint: fingerprint,
				commitId: validation.commitId,
				revision,
				chunkCount: validation.actualChunkCount,
				blockSetHash: validation.blockSetHash,
				state: 'present',
				inputHash: validation.inputHash,
			};
			const target = path.join(filesDir, `${sha256Sync(validation.path)}.json`);
			try {
				await writeJsonAtomically(target, commit);
			} catch {
				return { failure: 'io' };
			}
		}
		// 关键路径:代际内建 pending/ 与 quarantine/ 目录,使 T3 的三种隔离内容从一开始就有归属位置。
		for (const dirname of [JOURNAL_PENDING_DIRNAME, JOURNAL_QUARANTINE_DIRNAME]) {
			try {
				await fs.promises.mkdir(path.join(generationRoot, dirname), { recursive: true });
			} catch {
				return { failure: 'io' };
			}
		}
		return { failure: null };
	}
}

/** 单文件块集合校验结论。 */
interface LegacyBlockVerdict {
	/** 不可复用原因;可复用时为 null。 */
	reason: GenerationFileReason | null;
}

/** 标题路径的最大深度 — Markdown 只有 1~6 级标题,更深的路径不可能来自真实分块。 */
const MAX_HEADING_PATH_DEPTH = 6;

/**
 * 校验旧文件块集合 — 完整检查块 ID/序号、边界与结构元数据、维度、有限值与多余块,**不调用模型**。
 *
 * 关键路径(spec §5「完整检查块 ID/序号、边界与结构元数据、维度、有限值和多余块」):
 * - `startOffset` 是必备的结构元数据:缺失或非「非负整数」一律判不可复用 —— 无法证明边界时
 *   宁可重算,不把「路径存在、块数非零」当作内容正确的证据;
 * - 边界只看**起点单调**:按 `chunkIndex` 排序后后一块的 `startOffset` 不得小于前一块。
 *   这里**不**要求相邻块区间互不重叠 —— 旧分块器按 `chunkOverlap` 故意让相邻块共享尾部,
 *   要求区间不相交会把合法的旧索引整体误判为需重算;
 * - `headingPath` 存在时必须是非空字符串数组且深度不超过 6(与 Markdown 标题层级一致);
 *   不存在时不因此判不可复用(只校验存在时的形状与层级合理性);
 * - `metadata.path` 存在时必须与当前路径一致,否则视为外来块。
 *
 * @param input - 路径、块集合、清单声明块数与当前维度。
 * @returns 校验结论。
 */
export function validateLegacyFileBlocks(input: {
	path: string;
	blocks: readonly PreparedBlock[];
	declaredChunkCount: number;
	expectedDimension: number;
}): LegacyBlockVerdict {
	const seen = new Set<number>();
	/** 结构元数据按 `chunkIndex` 排序后的视图 — 边界单调性必须与分块序号一致。 */
	const boundaries: Array<{ chunkIndex: number; startOffset: number }> = [];
	for (const block of input.blocks) {
		const index = block.metadata['chunkIndex'];
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
			return { reason: 'chunk-contiguity-broken' };
		}
		if (seen.has(index)) return { reason: 'chunk-contiguity-broken' };
		seen.add(index);
		const declaredPath = block.metadata['path'];
		if (declaredPath !== undefined && declaredPath !== input.path) return { reason: 'block-id-foreign' };
		if (block.vector.length !== input.expectedDimension) return { reason: 'dimension-mismatch' };
		for (const value of block.vector) {
			if (!Number.isFinite(value)) return { reason: 'vector-not-finite' };
		}
		const startOffset = block.metadata['startOffset'];
		if (typeof startOffset !== 'number' || !Number.isInteger(startOffset) || startOffset < 0) {
			return { reason: 'structural-metadata-missing' };
		}
		const headingPath = block.metadata['headingPath'];
		if (headingPath !== undefined) {
			if (!Array.isArray(headingPath) || headingPath.length > MAX_HEADING_PATH_DEPTH) {
				return { reason: 'structural-metadata-missing' };
			}
			for (const entry of headingPath) {
				if (typeof entry !== 'string' || entry.trim().length === 0) return { reason: 'structural-metadata-missing' };
			}
		}
		boundaries.push({ chunkIndex: index, startOffset });
	}
	// 关键路径:起点随分块序号倒退(边界重叠/乱序)说明结构元数据与实际块序不自洽。
	boundaries.sort((left, right) => left.chunkIndex - right.chunkIndex);
	for (let position = 1; position < boundaries.length; position += 1) {
		const previous = boundaries[position - 1];
		const current = boundaries[position];
		if (previous === undefined || current === undefined) continue;
		if (current.startOffset < previous.startOffset) return { reason: 'boundary-overlap' };
	}
	// 关键路径:清单声明块数为 0 时,磁盘必须确实没有块 —— 「块数 0」不能当空文件的证据(旧版缺陷)。
	if (input.declaredChunkCount === 0) {
		return input.blocks.length === 0 ? { reason: null } : { reason: 'zero-chunk-without-blocks' };
	}
	if (input.blocks.length !== input.declaredChunkCount) {
		return { reason: 'chunk-count-mismatch' };
	}
	for (let index = 0; index < input.declaredChunkCount; index += 1) {
		if (!seen.has(index)) return { reason: 'chunk-contiguity-broken' };
	}
	return { reason: null };
}

// ==================== 代际日志探测 ====================

/**
 * 只读的代际日志探测 — 回收判定需要知道「是否还有未决事务/隔离」。
 *
 * 关键路径:不构造 `IndexFileJournal`,因为回收探测不能要求 owner 写门面;这里只读磁盘。
 */
export class GenerationJournalProbe {
	private readonly generationRoot: string;

	constructor(generationRoot: string) {
		this.generationRoot = path.resolve(generationRoot);
	}

	/** 代际内未决事务涉及的路径。 */
	async listPendingPaths(): Promise<string[]> {
		const dir = path.join(this.generationRoot, JOURNAL_PENDING_DIRNAME);
		const paths: string[] = [];
		for (const entry of await readDirOrEmpty(dir)) {
			if (!entry.isDirectory()) continue;
			try {
				const raw = await fs.promises.readFile(path.join(dir, entry.name, JOURNAL_PREPARED_FILENAME), 'utf8');
				const parsed = JSON.parse(raw) as unknown;
				if (!isRecord(parsed)) continue;
				const declared = isRecord(parsed['next']) ? parsed['next']['path'] : undefined;
				// 关键路径:只接受规范化后的安全相对路径;非法声明用事务目录名占位,保持回收判定保守。
				if (typeof declared === 'string' && declared.length > 0) paths.push(declared);
				else paths.push(entry.name);
			} catch {
				// 无法解析的事务仍然占用该代际:用目录名作为占位,保证回收判定保守。
				paths.push(entry.name);
			}
		}
		return paths.sort((left, right) => left.localeCompare(right));
	}

	/** 代际级隔离记录是否存在(存在即隔离,损坏也失败关闭)。 */
	async isGenerationQuarantined(): Promise<boolean> {
		const target = path.join(this.generationRoot, JOURNAL_QUARANTINE_DIRNAME, JOURNAL_GENERATION_QUARANTINE_FILENAME);
		try {
			await fs.promises.access(target);
			return true;
		} catch {
			return false;
		}
	}

	/** 代际内被隔离的路径(`quarantine/<pathHash>.json`,不含 `generation.json` 与取证事务目录)。 */
	async listPathStateFiles(): Promise<string[]> {
		const dir = path.join(this.generationRoot, JOURNAL_QUARANTINE_DIRNAME);
		const names: string[] = [];
		for (const entry of await readDirOrEmpty(dir)) {
			if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== JOURNAL_GENERATION_QUARANTINE_FILENAME) {
				names.push(entry.name);
			}
		}
		return names;
	}

	/**
	 * 代际内保留的取证事务目录名(`quarantine/transactions/<transactionId>/`)。
	 *
	 * 关键路径:这类目录是「不可归属坏日志」的唯一取证依据。回收判定如果不把它们算作
	 * 「未解决内容」,只持取证内容的代际会被整体回收 —— 取证随目录一起消失,再也无法解释
	 * 为什么当初隔离。名称一律按目录名返回,不做任何猜测性处理。
	 */
	async listQuarantinedTransactionDirs(): Promise<string[]> {
		const dir = path.join(this.generationRoot, JOURNAL_QUARANTINE_DIRNAME, JOURNAL_QUARANTINE_TRANSACTIONS_DIRNAME);
		const names: string[] = [];
		for (const entry of await readDirOrEmpty(dir)) {
			if (entry.isDirectory() && entry.name.length > 0) names.push(entry.name);
		}
		return names.sort((left, right) => left.localeCompare(right));
	}
}

// ==================== 通用工具 ====================

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取 errno 字符串。 */
function readErrno(error: unknown): string | null {
	if (!isRecord(error)) return null;
	const code = error['code'];
	return typeof code === 'string' ? code : null;
}

/** 读取目录内容;目录缺失返回空数组。 */
async function readDirOrEmpty(dir: string): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** 解析真实路径;不存在或无法解析时返回 null。 */
async function realpathOrNull(target: string): Promise<string | null> {
	try {
		return await fs.promises.realpath(target);
	} catch {
		return null;
	}
}

/**
 * 复制阶段进度状态文件的刷新阈值 — 文件数。
 *
 * 关键路径:进度状态文件本身随已复制文件数增长,每复制一个文件就整份重写是 O(N²) 写盘;
 * 按阈值批量刷新 + 阶段结束强制刷一次,把写入次数压到「文件数 / 阈值 + 1」。
 */
export const MIGRATION_STATE_FLUSH_FILE_INTERVAL = 16;

/** 复制阶段进度状态文件的刷新阈值 — 新增字节数。 */
export const MIGRATION_STATE_FLUSH_BYTE_INTERVAL = 256 * 1024;

/** 目录 fsync 不被平台支持的错误码 — 视为成功(与 T1 `AtomicIndexStorage.flushPath` 同一判定)。 */
const DIRECTORY_SYNC_UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'ENOSYS']);

/**
 * 把文件刷到持久存储。
 *
 * 关键路径:rename 只保证可见性;关键状态文件(control、完成记录、代际入口)必须显式 fsync,
 * 不依赖进程退出时的缓冲区回写。
 *
 * @param target - 目标文件或目录绝对路径。
 */
async function flushPath(target: string): Promise<void> {
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(target, 'r');
	} catch (error) {
		// 关键路径:目录在 Windows 上打不开 —— 与同步路径共用同一降级判定。
		const code = readErrno(error);
		if (code !== null && DIRECTORY_SYNC_UNSUPPORTED_CODES.has(code)) return;
		throw error;
	}
	let syncError: Error | null = null;
	try {
		await handle.sync();
	} catch (error) {
		syncError = error instanceof Error ? error : new Error(String(error));
	}
	try {
		await handle.close();
	} catch {
		// 关闭失败不影响已完成的 sync 结论。
	}
	if (syncError === null) return;
	const code = readErrno(syncError);
	// 关键路径:Windows 打不开/同步不了目录;平台能力缺失降级为成功,真实 IO 错误必须抛出。
	if (code !== null && DIRECTORY_SYNC_UNSUPPORTED_CODES.has(code)) return;
	throw syncError;
}

/** 计算缓冲区摘要(与日志侧 `pathHash` / 完成记录同口径:hex sha256)。 */
function createDigest(buffer: Uint8Array): string {
	return createHash('sha256').update(buffer).digest('hex');
}

/** 计算文件摘要;文件不存在返回 null。 */
async function fileDigest(target: string): Promise<string | null> {
	try {
		return createDigest(await fs.promises.readFile(target));
	} catch {
		return null;
	}
}

/** 按日志侧同一算法计算规范化相对路径摘要 — 完成记录文件名必须与 `IndexFileJournal` 一致。 */
function sha256Sync(input: string): string {
	const normalized = input.split(/[\\/]+/).filter((segment) => segment.length > 0).join('/');
	return createDigest(Buffer.from(normalized, 'utf8'));
}

/** 取块集合里统一下来的 commitId;不一致时返回第一个。 */
function readCommitId(blocks: readonly PreparedBlock[]): string {
	for (const block of blocks) {
		const commitId = block.metadata['commitId'];
		if (typeof commitId === 'string' && commitId.length > 0) return commitId;
	}
	return 'legacy-migration-0';
}

/**
 * 原子写文本:同目录**唯一**临时文件 → fsync → rename → fsync 目标与父目录。
 *
 * 关键路径:临时名必须唯一(`.tmp` 固定名会让两个写入者互相覆盖,中断也会留下歧义残留);
 * rename 之前先 fsync 临时文件,保证「rename 生效即内容完整」;rename 之后再 fsync 目标与
 * 父目录,保证目录项也落盘。
 *
 * @param target - 目标文件绝对路径。
 * @param payload - 已序列化的内容。
 */
async function writeJsonText(target: string, payload: string): Promise<void> {
	const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
	await fs.promises.writeFile(tmp, payload, 'utf8');
	try {
		await flushPath(tmp);
		await fs.promises.rename(tmp, target);
	} catch (error) {
		await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
	await flushPath(target);
	await flushPath(path.dirname(target));
}

/** 原子写 JSON 值 — 唯一临时名 + 文件/目录 flush。 */
async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
	await writeJsonText(target, JSON.stringify(value, null, 2));
}

/** 空的回收探测结论 — 调用方未提供某代际探测结果时的保守默认值。 */
function emptyReconcileProbe(): GenerationReconcileProbeResult {
	return { pendingPaths: 0, generationQuarantined: false, pathQuarantined: 0, quarantinedTransactions: 0 };
}

/**
 * 读取并校验代际入口记录 — 形状自洽才构成「这个目录属于本框架」的证据。
 *
 * 关键路径:只认本框架写出的形状(schema 版本、合法代际 ID、64 位指纹、合法 kind/status
 * 与数字 createdAt);伪造或缺字段的入口一律返回 null,调用方据此拒绝清理。
 *
 * @param entryPath - `generation.json` 绝对路径。
 * @returns 规范化后的入口记录;不可信时为 null。
 */
async function readGenerationEntry(entryPath: string): Promise<GenerationEntryRecord | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.promises.readFile(entryPath, 'utf8'));
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;
	if (parsed['schemaVersion'] !== INDEX_RECORD_SCHEMA_VERSION) return null;
	const generationId = parsed['generationId'];
	if (!isGenerationId(generationId)) return null;
	const fingerprint = parsed['fingerprint'];
	if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return null;
	const kind = parsed['kind'];
	if (typeof kind !== 'string' || !(GENERATION_KINDS as readonly string[]).includes(kind)) return null;
	const status = parsed['status'];
	if (typeof status !== 'string' || !(GENERATION_STATUSES as readonly string[]).includes(status)) return null;
	const createdAt = parsed['createdAt'];
	if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
	return {
		schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
		generationId,
		fingerprint,
		kind: kind as GenerationKind,
		status: status as GenerationStatus,
		createdAt,
	};
}

/** 解析代际记录 — 字段不合规一律以 `control-invalid` 拒绝。 */
function parseGenerationRecord(id: string, value: unknown, indexRoot: string): GenerationRecord {
	if (!isGenerationId(id)) throw new IndexGenerationError('control-invalid', `代际表中的键不是合法代际 ID:${String(id)}`);
	if (!isRecord(value)) throw new IndexGenerationError('control-invalid', `代际 ${id} 的记录不是对象`);
	if (value['generationId'] !== id) throw new IndexGenerationError('control-invalid', `代际 ${id} 的记录内 ID 不一致`);
	if (value['schemaVersion'] !== INDEX_RECORD_SCHEMA_VERSION) throw new IndexGenerationError('control-invalid', `代际 ${id} 的 schema 版本不符`);
	const fingerprint = value['fingerprint'];
	if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
		throw new IndexGenerationError('control-invalid', `代际 ${id} 的配置指纹非法`);
	}
	const status = value['status'];
	if (typeof status !== 'string' || !(GENERATION_STATUSES as readonly string[]).includes(status)) {
		throw new IndexGenerationError('control-invalid', `代际 ${id} 的状态非法`);
	}
	const kind = value['kind'];
	if (typeof kind !== 'string' || !(GENERATION_KINDS as readonly string[]).includes(kind)) {
		throw new IndexGenerationError('control-invalid', `代际 ${id} 的来源非法`);
	}
	const verifiedAt = value['verifiedAt'] ?? null;
	if (verifiedAt !== null && (typeof verifiedAt !== 'number' || !Number.isFinite(verifiedAt))) {
		throw new IndexGenerationError('control-invalid', `代际 ${id} 的核对时间戳非法`);
	}
	const quarantineReason = value['quarantineReason'] ?? null;
	if (quarantineReason !== null && typeof quarantineReason !== 'string') {
		throw new IndexGenerationError('control-invalid', `代际 ${id} 的隔离原因非法`);
	}
	const expectedRoot = path.join(indexRoot, INDEX_GENERATIONS_DIRNAME, id);
	const root = value['root'];
	if (root !== expectedRoot) throw new IndexGenerationError('control-invalid', `代际 ${id} 的目录与索引根不一致`);
	return {
		schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
		generationId: id,
		fingerprint,
		kind: kind as GenerationKind,
		status: status as GenerationStatus,
		root: expectedRoot,
		verifiedAt,
		quarantineReason,
		createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : 0,
		updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : 0,
	};
}