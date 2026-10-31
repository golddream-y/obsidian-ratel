/**
 * @file src/core/index-persistence-types.ts
 * @description 持久数据契约 — 持久记录、校验与配置指纹的唯一事实源:类型声明、schema 校验、路径边界与摘要计算
 * @module core/index-persistence-types
 * @depends node:crypto, node:fs/promises, node:path
 *
 * 设计要点:
 * - 本文件同时承载「契约类型」与「校验实现」:持久记录 schema 只在这里定义,T3/T6 的日志与代际
 *   读写复用同一套校验,不各自复制字段判断;本文件不负责日志、事务和代际的读写流程。
 * - 校验一律「先拒绝、后返回规范对象」:调用方拿到的是重新构造的记录,而不是原样透传的未知对象。
 * - 路径分两类:记录里的 vault 相对路径只做词法校验;存储/分片路径还要做解析与符号链接校验。
 * - 错误消息是中文开发向文案,不在此处建 i18n key;错误码稳定,供 T7 映射用户可见文案。
 */

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

// ==================== 常量清单 ====================

/** 当前持久记录 schema 版本 — 所有记录(提交记录、prepared、代际配置)必须声明同一版本。 */
export const INDEX_RECORD_SCHEMA_VERSION = 2;

/**
 * 索引任务阶段清单。
 *
 * 关键路径:`ready` 只表示扫描结束且无待处理失败/事务/事件,不代表「全库一次性构建成功」。
 */
export const INDEX_PHASES = [
	'scanning',
	'processing',
	'stalled',
	'stopping',
	'paused',
	'partial-failure',
	'failed',
	'ready',
] as const;

/** 索引任务阶段。 */
export type IndexPhase = (typeof INDEX_PHASES)[number];

/**
 * 校验错误码清单 — 判别式稳定,调用方与测试都按码判断,不依赖消息措辞。
 *
 * 用户可见性标注(留给 T7 映射 i18n key,本文件不自建 key):
 * - `schema-version-unknown`、`generation-mismatch`、`checksum-mismatch`、`path-symlink-escape`
 *   属于「元数据损坏/索引不可用」类,最终可能上屏;
 * - 其余错误码预期只出现在开发日志与测试断言中。
 */
export const INDEX_VALIDATION_ERROR_CODES = [
	'record-shape-invalid',
	'schema-version-unknown',
	'generation-mismatch',
	'config-fingerprint-mismatch',
	'config-invalid',
	'path-empty',
	'path-absolute',
	'path-not-absolute',
	'path-nul',
	'path-traversal',
	'path-escape',
	'path-symlink-escape',
	'record-state-inconsistent',
	'record-checksum-malformed',
	'revision-not-monotonic',
	'block-id-duplicate',
	'vector-non-finite',
	'vector-dimension-mismatch',
	'block-count-mismatch',
	'checksum-mismatch',
	'part-name-invalid',
	'part-missing',
	'part-unexpected',
	'part-count-mismatch',
] as const;

/** 校验错误码。 */
export type IndexValidationErrorCode = (typeof INDEX_VALIDATION_ERROR_CODES)[number];

// ==================== 错误类型 ====================

/**
 * 持久记录校验错误 — 携带稳定错误码与可选细节。
 *
 * 设计要点:
 * - `code` 是判别式,便于 T3/T6 按类型分流(隔离单路径 / 隔离整个代际);
 * - `detail` 只放诊断字段(路径、期望值、实际值),不放正文内容,避免把笔记内容带进日志。
 */
export class IndexValidationError extends Error {
	/** 稳定错误码。 */
	readonly code: IndexValidationErrorCode;
	/** 诊断细节;不含笔记正文。 */
	readonly detail: Readonly<Record<string, unknown>>;

	constructor(
		code: IndexValidationErrorCode,
		message: string,
		options: { detail?: Record<string, unknown> } = {},
	) {
		super(message);
		this.name = 'IndexValidationError';
		this.code = code;
		this.detail = options.detail ?? {};
	}
}

/** 抛出校验错误(内部 helper,统一错误类型)。 */
function fail(
	code: IndexValidationErrorCode,
	message: string,
	detail?: Record<string, unknown>,
): never {
	throw new IndexValidationError(code, message, detail ? { detail } : undefined);
}

// ==================== 持久记录契约 ====================

/** 提交记录公共字段。 */
export interface FileCommitBase {
	/** 记录 schema 版本。 */
	schemaVersion: typeof INDEX_RECORD_SCHEMA_VERSION;
	/** 代际标识 — 目录身份,与配置身份 `configFingerprint` 不混用。 */
	generationId: string;
	/** vault 规范化相对路径(正斜杠)。 */
	path: string;
	/** 生成该版本向量时的配置指纹。 */
	configFingerprint: string;
	/** 提交标识 — 同时写入该路径的每个块。 */
	commitId: string;
	/** 同路径单调递增的版本号;不以时间戳判断先后。 */
	revision: number;
	/** 该提交的块数量;空文件与删除均为 0。 */
	chunkCount: number;
	/**
	 * 块集合校验和 — 覆盖有序块 ID、元数据与向量值。
	 *
	 * 关键路径:`state: 'deleted'` 的记录没有块,此字段固定为空集合摘要 `EMPTY_BLOCK_SET_HASH`,
	 * 与 `chunkCount: 0` 一起构成删除凭据;不能沿用被删除版本的摘要,否则删除记录会被误当成旧内容的证据。
	 */
	blockSetHash: string;
}

/**
 * 已提交文件记录。
 *
 * 关键路径:`deleted` 是持久删除凭据,`inputHash=null` 且零块、`blockSetHash` 为空集合摘要;
 * 空文件属于 `present` 且保留正文 hash。
 */
export type FileCommit = FileCommitBase &
	(
		| { state: 'present'; inputHash: string }
		| { state: 'deleted'; inputHash: null; chunkCount: 0 }
	);

/** prepared 分片声明 — 分片名是事务目录内的普通文件名,不接受跨目录引用。 */
export interface PreparedPart {
	/** 分片文件名。 */
	name: string;
	/** 分片内容 SHA-256。 */
	hash: string;
	/** 该分片包含的块数量。 */
	count: number;
}

/**
 * 待提交事务记录 — 只有全部分片完整后才原子写出。
 *
 * 关键路径:`previousCommitId` / `previousRevision` 是重放的前驱依据;`next` 与落盘后的提交记录逐字段一致。
 */
export interface PreparedFile {
	/** 记录 schema 版本。 */
	schemaVersion: typeof INDEX_RECORD_SCHEMA_VERSION;
	/** 操作类型。 */
	operation: 'replace' | 'delete';
	/** 事务成功后应写入的提交记录。 */
	next: FileCommit;
	/** 前驱提交 ID;首次提交为 null。 */
	previousCommitId: string | null;
	/** 前驱 revision;首次提交为 0。 */
	previousRevision: number;
	/** 分片声明;零块事务为空数组。 */
	parts: PreparedPart[];
}

/** 参与块集合校验和的块。 */
export interface IndexBlockInput {
	/** 块 ID — 同一块集合内必须唯一。 */
	readonly id: string;
	/** 向量值 — 必须全部为有限数。 */
	readonly vector: readonly number[];
	/** 块元数据 — 参与校验和,键顺序无关。 */
	readonly metadata?: Readonly<Record<string, unknown>>;
}

// ==================== 配置指纹 ====================

/**
 * 影响向量空间形态的配置字段。
 *
 * 关键路径:
 * - 只放「改变嵌入结果或分块边界」的字段;凭证、baseUrl、任务 ID、进度等运行期状态一律不参与。
 * - 字段顺序由 `INDEX_CONFIG_FINGERPRINT_FIELDS` 显式确定,不依赖对象键顺序。
 */
export interface IndexConfigDescriptor {
	/** 嵌入模型标识,形如 `local:bge-small-zh-v1.5` / `api:text-embedding-3-small`。 */
	embeddingModelId: string;
	/** 可确认的模型修订;无法确认时为 null,此时不假设与其他修订兼容。 */
	embeddingModelRevision: string | null;
	/** 向量维度。 */
	embeddingDimension: number;
	/** 分块规则代数。 */
	chunkerVersion: number;
	/** 实际生效的块大小。 */
	chunkSize: number;
	/** 实际生效的块间重叠。 */
	chunkOverlap: number;
	/** 影响嵌入文本拼装的模板版本;无额外拼装时为 null。 */
	embeddingTextVersion: string | null;
}

/** 指纹参与字段的显式顺序 — 序列化只按此顺序进行。 */
export const INDEX_CONFIG_FINGERPRINT_FIELDS = [
	'embeddingModelId',
	'embeddingModelRevision',
	'embeddingDimension',
	'chunkerVersion',
	'chunkSize',
	'chunkOverlap',
	'embeddingTextVersion',
] as const;

/**
 * 计算配置指纹 — 稳定字段顺序序列化后取 SHA-256。
 *
 * @param config - 当前生效的配置描述。
 * @returns 64 位小写十六进制摘要。
 * @throws {IndexValidationError} 配置字段非法(`config-invalid`)。
 * @example
 *   await computeConfigFingerprint(config); // '3f2a...'
 */
export async function computeConfigFingerprint(config: IndexConfigDescriptor): Promise<string> {
	assertConfigDescriptor(config);
	const ordered = INDEX_CONFIG_FINGERPRINT_FIELDS.map((field) => [field, config[field]] as const);
	return digestSha256(JSON.stringify(ordered));
}

/** 校验配置字段本身合法 — 指纹不能建立在非法配置上。 */
function assertConfigDescriptor(config: IndexConfigDescriptor): void {
	if (!isRecord(config)) fail('config-invalid', '配置描述必须是对象');
	requireNonEmptyString(config, 'embeddingModelId');
	const revision = config.embeddingModelRevision;
	if (revision !== null && (typeof revision !== 'string' || revision.length === 0)) {
		fail('config-invalid', 'embeddingModelRevision 必须是非空字符串或 null');
	}
	requirePositiveInteger(config, 'embeddingDimension', 'config-invalid');
	requirePositiveInteger(config, 'chunkerVersion', 'config-invalid');
	const chunkSize = requirePositiveInteger(config, 'chunkSize', 'config-invalid');
	const chunkOverlap = requireNonNegativeInteger(config, 'chunkOverlap', 'config-invalid');
	if (chunkOverlap >= chunkSize) {
		fail('config-invalid', `chunkOverlap(${chunkOverlap}) 必须小于 chunkSize(${chunkSize})`);
	}
	const textVersion = config.embeddingTextVersion;
	if (textVersion !== null && (typeof textVersion !== 'string' || textVersion.length === 0)) {
		fail('config-invalid', 'embeddingTextVersion 必须是非空字符串或 null');
	}
}

// ==================== 路径校验 ====================

/**
 * 校验记录中的 vault 相对路径 — 只做词法校验,不访问磁盘。
 *
 * @param relativePath - 记录里的路径字段。
 * @returns 正斜杠规范形式。
 * @throws {IndexValidationError} 空路径、含 NUL、绝对路径、空段、`..` 父级段。
 */
export function assertSafeRecordPath(relativePath: string): string {
	if (typeof relativePath !== 'string' || relativePath.length === 0) {
		fail('path-empty', '记录路径不能为空');
	}
	if (relativePath.includes('\u0000')) {
		fail('path-nul', '记录路径不得包含 NUL 字符');
	}
	// 关键路径:同时拒绝 POSIX 与 Windows 形式的绝对路径,避免换平台后变成越界写入。
	if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
		fail('path-absolute', `记录路径必须是 vault 相对路径:${relativePath}`);
	}
	const normalized: string[] = [];
	for (const segment of relativePath.split(/[\\/]+/)) {
		if (segment.length === 0 || segment === '.') {
			fail('path-empty', `记录路径包含空段或当前目录段:${relativePath}`);
		}
		if (segment === '..') {
			fail('path-traversal', `记录路径不得包含父级段(..):${relativePath}`);
		}
		normalized.push(segment);
	}
	return normalized.join('/');
}

/**
 * 校验 prepared 分片名 — 必须是事务目录内的普通文件名。
 *
 * @param name - 分片声明中的文件名。
 * @returns 原文件名。
 * @throws {IndexValidationError} 空名、点段、含路径分隔符或 NUL(`part-name-invalid`)。
 */
export function assertSafePartName(name: string): string {
	if (typeof name !== 'string' || name.length === 0) {
		fail('part-name-invalid', '分片名不能为空');
	}
	if (name.includes('\u0000')) {
		fail('part-name-invalid', '分片名不得包含 NUL 字符');
	}
	if (name === '.' || name === '..') {
		fail('part-name-invalid', `分片名不得是点段:${name}`);
	}
	if (/[\\/]/.test(name)) {
		fail('part-name-invalid', `分片名不得包含路径分隔符:${name}`);
	}
	return name;
}

/**
 * 代际根 realpath 缓存 — 同一代际根在多次路径校验间复用,避免每次 2~3 次 realpath IO。
 *
 * 关键路径:只缓存成功结果。根尚不存在时不能缓存 null,否则根随后创建仍会按「不存在」只做词法校验;
 * 代际根一旦建立就不再改变解析目标,缓存不会让后续校验绕过符号链接检查(目标路径每次仍重新解析)。
 */
const rootRealpathCache = new Map<string, string>();

/**
 * 校验存储路径落在所属代际根内 — 解析绝对路径,并核对符号链接解析结果。
 *
 * 关键路径:
 * - 代际根尚不存在时只做词法包含判断:根不存在则其下不可能存在可逃逸的符号链接;
 * - 目标文件通常尚不存在,因此校验的是「最近存在的祖先目录」的 realpath;
 * - 代际根的 realpath 按根缓存,祖先遍历到根即复用缓存,不再重复解析。
 *
 * @param absolutePath - 待校验的绝对路径。
 * @param root - 代际根绝对路径。
 * @returns 解析后的绝对路径。
 * @throws {IndexValidationError} 非绝对路径(`path-not-absolute`)、词法越界(`path-escape`)、符号链接逃逸(`path-symlink-escape`)。
 */
export async function assertPathWithinRoot(absolutePath: string, root: string): Promise<string> {
	if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
		fail('path-not-absolute', `存储路径必须是绝对路径:${String(absolutePath)}`);
	}
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(absolutePath);
	if (!isWithinRoot(resolved, resolvedRoot)) {
		fail('path-escape', `路径逃出代际根:${resolved} 不在 ${resolvedRoot} 内`);
	}
	const realRoot = await resolveRootRealpath(resolvedRoot);
	if (realRoot === null) return resolved;
	const realTarget = await realpathOfExistingAncestor(resolved, resolvedRoot, realRoot);
	if (realTarget === null) return resolved;
	if (!isWithinRoot(realTarget, realRoot)) {
		fail('path-symlink-escape', `路径经符号链接逃出代际根:${resolved} → ${realTarget}`);
	}
	return resolved;
}

/** 判断 candidate 是否等于 root 或位于其下。 */
function isWithinRoot(candidate: string, root: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** 取代际根 realpath;成功结果按根缓存,不存在时返回 null 且不缓存。 */
async function resolveRootRealpath(resolvedRoot: string): Promise<string | null> {
	const cached = rootRealpathCache.get(resolvedRoot);
	if (cached !== undefined) return cached;
	const realRoot = await realpathOrNull(resolvedRoot);
	if (realRoot !== null) rootRealpathCache.set(resolvedRoot, realRoot);
	return realRoot;
}

/** realpath,不存在时返回 null;其他 IO 错误继续抛出。 */
async function realpathOrNull(target: string): Promise<string | null> {
	try {
		return await realpath(target);
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw error;
	}
}

/**
 * 逐级向上找到第一个存在的路径并取其 realpath。
 *
 * 关键路径:遍历到代际根本身时直接返回已缓存的 realRoot,避免对根重复 realpath。
 */
async function realpathOfExistingAncestor(
	target: string,
	resolvedRoot: string,
	realRoot: string,
): Promise<string | null> {
	let current = target;
	for (;;) {
		if (current === resolvedRoot) return realRoot;
		const resolved = await realpathOrNull(current);
		if (resolved !== null) return resolved;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * 读取错误对象上的 `code` 字段。
 *
 * 关键路径:Node 的 IO 错误是 `Error` 子类,`code` 不在类型上;集中做一次结构守卫,
 * 避免各处散落 `(error as { code?: unknown }).code` 断言。
 */
function getErrorCode(error: unknown): string | null {
	if (typeof error !== 'object' || error === null) return null;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : null;
}

/** 判断是否为「文件不存在」类错误。 */
function isNotFoundError(error: unknown): boolean {
	return getErrorCode(error) === 'ENOENT';
}

// ==================== 提交记录校验 ====================

/** 提交记录校验选项 — 记录必须属于当前代际与当前配置。 */
export interface FileCommitValidationOptions {
	/** 当前活动代际 ID。 */
	generationId: string;
	/** 当前配置指纹。 */
	configFingerprint: string;
}

/**
 * 校验并规范化文件提交记录。
 *
 * @param value - 从磁盘读出的未知 JSON。
 * @param options - 期望代际与配置指纹。
 * @returns 重新构造的提交记录。
 * @throws {IndexValidationError} schema 版本、代际、指纹、路径、状态或 checksum 不合法。
 */
export async function validateFileCommit(
	value: unknown,
	options: FileCommitValidationOptions,
): Promise<FileCommit> {
	if (!isRecord(value)) fail('record-shape-invalid', '文件提交记录必须是对象');
	if (value['schemaVersion'] !== INDEX_RECORD_SCHEMA_VERSION) {
		fail(
			'schema-version-unknown',
			`未知的持久记录 schemaVersion:期望 ${INDEX_RECORD_SCHEMA_VERSION},实际 ${String(value['schemaVersion'])}`,
		);
	}
	const generationId = requireNonEmptyString(value, 'generationId');
	if (generationId !== options.generationId) {
		fail('generation-mismatch', `记录代际 ${generationId} 与当前代际 ${options.generationId} 不一致`);
	}
	const configFingerprint = requireNonEmptyString(value, 'configFingerprint');
	if (configFingerprint !== options.configFingerprint) {
		fail('config-fingerprint-mismatch', '记录配置指纹与当前配置不一致,不能作为当前版本依据');
	}
	const recordPath = assertSafeRecordPath(requireNonEmptyString(value, 'path'));
	const commitId = requireNonEmptyString(value, 'commitId');
	const revision = requirePositiveInteger(value, 'revision');
	const chunkCount = requireNonNegativeInteger(value, 'chunkCount');
	const blockSetHash = requireChecksum(value, 'blockSetHash');
	const state = value['state'];

	if (state === 'present') {
		const inputHash = requireChecksum(value, 'inputHash');
		return {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId,
			path: recordPath,
			configFingerprint,
			commitId,
			revision,
			chunkCount,
			blockSetHash,
			state: 'present',
			inputHash,
		};
	}
	if (state === 'deleted') {
		if (value['inputHash'] !== null) {
			fail('record-state-inconsistent', 'deleted 记录的 inputHash 必须为 null');
		}
		if (chunkCount !== 0) {
			fail('record-state-inconsistent', `deleted 记录的 chunkCount 必须为 0,实际 ${chunkCount}`);
		}
		// 关键路径:删除记录的 blockSetHash 语义固定为空集合摘要,不接受被删除版本的旧摘要。
		if (blockSetHash !== EMPTY_BLOCK_SET_HASH) {
			fail(
				'record-state-inconsistent',
				'deleted 记录的 blockSetHash 必须是空集合摘要(EMPTY_BLOCK_SET_HASH)',
			);
		}
		return {
			schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
			generationId,
			path: recordPath,
			configFingerprint,
			commitId,
			revision,
			chunkCount: 0,
			blockSetHash,
			state: 'deleted',
			inputHash: null,
		};
	}
	return fail('record-shape-invalid', `未知的记录状态:${String(state)}`);
}

// ==================== prepared 事务校验 ====================

/** prepared 事务校验选项。 */
export interface PreparedFileValidationOptions extends FileCommitValidationOptions {
	/** 事务目录绝对路径;提供时额外核对每个分片解析后仍在目录内。 */
	transactionRoot?: string;
}

/**
 * 校验并规范化待提交事务记录。
 *
 * @param value - 从磁盘读出的未知 JSON。
 * @param options - 期望代际、配置指纹与可选事务目录。
 * @returns 重新构造的 prepared 记录。
 * @throws {IndexValidationError} schema、操作与 next 状态不符、revision 未递增、分片声明或计数不合法。
 */
export async function validatePreparedFile(
	value: unknown,
	options: PreparedFileValidationOptions,
): Promise<PreparedFile> {
	if (!isRecord(value)) fail('record-shape-invalid', 'prepared 记录必须是对象');
	if (value['schemaVersion'] !== INDEX_RECORD_SCHEMA_VERSION) {
		fail(
			'schema-version-unknown',
			`未知的 prepared schemaVersion:期望 ${INDEX_RECORD_SCHEMA_VERSION},实际 ${String(value['schemaVersion'])}`,
		);
	}
	const operation = value['operation'];
	if (operation !== 'replace' && operation !== 'delete') {
		fail('record-shape-invalid', `未知的事务操作:${String(operation)}`);
	}
	const next = await validateFileCommit(value['next'], options);
	const previousCommitId = value['previousCommitId'];
	if (
		previousCommitId !== null &&
		(typeof previousCommitId !== 'string' || previousCommitId.length === 0)
	) {
		fail('record-shape-invalid', 'previousCommitId 必须是非空字符串或 null');
	}
	const previousRevision = requireNonNegativeInteger(value, 'previousRevision');
	if (next.revision <= previousRevision) {
		fail(
			'revision-not-monotonic',
			`后继 revision(${next.revision}) 必须大于前驱 revision(${previousRevision})`,
		);
	}
	if (operation === 'delete' && next.state !== 'deleted') {
		fail('record-state-inconsistent', 'delete 事务的 next 必须是 deleted 记录');
	}
	if (operation === 'replace' && next.state !== 'present') {
		fail('record-state-inconsistent', 'replace 事务的 next 必须是 present 记录');
	}

	const partsValue = value['parts'];
	if (!Array.isArray(partsValue)) fail('record-shape-invalid', 'parts 必须是数组');
	const parts: PreparedPart[] = [];
	const names = new Set<string>();
	let totalCount = 0;
	for (const rawPart of partsValue) {
		if (!isRecord(rawPart)) fail('record-shape-invalid', '分片声明必须是对象');
		const name = assertSafePartName(requireNonEmptyString(rawPart, 'name'));
		if (names.has(name)) fail('record-shape-invalid', `分片名重复:${name}`);
		names.add(name);
		const hash = requireChecksum(rawPart, 'hash');
		const count = requireNonNegativeInteger(rawPart, 'count');
		totalCount += count;
		parts.push({ name, hash, count });
	}
	if (operation === 'delete' && parts.length > 0) {
		fail('record-state-inconsistent', 'delete 事务不得携带分片');
	}
	if (totalCount !== next.chunkCount) {
		fail('part-count-mismatch', `分片计数之和 ${totalCount} 与块数 ${next.chunkCount} 不一致`);
	}
	if (options.transactionRoot !== undefined) {
		for (const part of parts) {
			await assertPathWithinRoot(path.join(options.transactionRoot, part.name), options.transactionRoot);
		}
	}
	return {
		schemaVersion: INDEX_RECORD_SCHEMA_VERSION,
		operation,
		next,
		previousCommitId,
		previousRevision,
		parts,
	};
}

/**
 * 校验 prepared 分片内容与声明 checksum 一致。
 *
 * 关键路径:只验证分片字节的完整性;块集合本身由 `validateBlockSet` 用 `blockSetHash` 验证,
 * 两者一起才能证明「同一提交」。
 *
 * @param prepared - 已通过 `validatePreparedFile` 的事务。
 * @param shards - 分片名到内容的映射(字符串按 UTF-8 编码计算摘要)。
 * @throws {IndexValidationError} 分片缺失(`part-missing`)、未声明(`part-unexpected`)或内容不符(`checksum-mismatch`)。
 */
export async function verifyPreparedChecksums(
	prepared: PreparedFile,
	shards: ReadonlyMap<string, string | Uint8Array>,
): Promise<void> {
	const declared = new Set(prepared.parts.map((part) => part.name));
	for (const part of prepared.parts) {
		const content = shards.get(part.name);
		if (content === undefined) {
			fail('part-missing', `缺少 prepared 声明的分片:${part.name}`);
		}
		const actual = digestSha256(content);
		if (actual !== part.hash) {
			fail('checksum-mismatch', `分片 ${part.name} 的 checksum 与声明不符`);
		}
	}
	for (const name of shards.keys()) {
		if (!declared.has(name)) {
			fail('part-unexpected', `出现未在 prepared 中声明的分片:${name}`);
		}
	}
}

// ==================== 块集合校验 ====================

/** 块集合校验选项。 */
export interface BlockSetValidationOptions {
	/** 期望的块集合校验和。 */
	expectedBlockSetHash?: string;
	/** 期望的块数量。 */
	expectedChunkCount?: number;
	/** 期望的向量维度。 */
	expectedDimension?: number;
}

/**
 * 空块集合的摘要 — 删除记录(`state: 'deleted'`)的 `blockSetHash` 必须等于该值。
 *
 * 关键路径:删除不是「没有记录」,而是「有记录且块集合为空」;固定摘要让删除凭据可被校验,
 * 同时与 `computeBlockSetHash([])` 保持同一算法,避免两套空集合语义。
 */
export const EMPTY_BLOCK_SET_HASH = digestSha256('[]');

/**
 * 计算块集合校验和 — 覆盖有序块 ID、元数据(键顺序无关)与向量值。
 *
 * @param blocks - 块集合。
 * @returns 64 位小写十六进制摘要。
 * @throws {IndexValidationError} 块 ID 重复或向量含非有限值。
 */
export async function computeBlockSetHash(blocks: readonly IndexBlockInput[]): Promise<string> {
	if (!Array.isArray(blocks)) fail('record-shape-invalid', '块集合必须是数组');
	// 关键路径:`Array.isArray` 会把只读数组窄化成 any[],这里显式收回元素类型。
	const list: readonly IndexBlockInput[] = blocks;
	assertBlockShapes(list);
	const canonical = list.map((block) => [
		block.id,
		canonicalizeValue(block.metadata ?? null),
		block.vector.map((value) => value),
	]);
	return digestSha256(JSON.stringify(canonical));
}

/**
 * 校验块集合 — 数量、维度、有限值、ID 唯一性与可选校验和。
 *
 * @param blocks - 块集合。
 * @param options - 期望的校验和/块数/维度。
 * @throws {IndexValidationError} 见各错误码。
 */
export async function validateBlockSet(
	blocks: readonly IndexBlockInput[],
	options: BlockSetValidationOptions = {},
): Promise<void> {
	if (!Array.isArray(blocks)) fail('record-shape-invalid', '块集合必须是数组');
	const list: readonly IndexBlockInput[] = blocks;
	assertBlockShapes(list);
	if (options.expectedDimension !== undefined) {
		for (const block of list) {
			if (block.vector.length !== options.expectedDimension) {
				fail(
					'vector-dimension-mismatch',
					`块 ${block.id} 的向量维度 ${block.vector.length} 与期望 ${options.expectedDimension} 不一致`,
				);
			}
		}
	}
	if (options.expectedChunkCount !== undefined && list.length !== options.expectedChunkCount) {
		fail('block-count-mismatch', `块数 ${list.length} 与期望 ${options.expectedChunkCount} 不一致`);
	}
	if (options.expectedBlockSetHash !== undefined) {
		const actual = await computeBlockSetHash(list);
		if (actual !== options.expectedBlockSetHash) {
			fail('checksum-mismatch', '块集合校验和与声明不符');
		}
	}
}

/** 校验块 ID 唯一与向量有限 — 哈希与校验的前置条件。 */
function assertBlockShapes(blocks: readonly IndexBlockInput[]): void {
	const ids = new Set<string>();
	for (const block of blocks) {
		if (!isRecord(block)) fail('record-shape-invalid', '块必须是对象');
		if (typeof block.id !== 'string' || block.id.length === 0) {
			fail('record-shape-invalid', '块 ID 必须是非空字符串');
		}
		if (ids.has(block.id)) fail('block-id-duplicate', `块 ID 重复:${block.id}`);
		ids.add(block.id);
		if (!Array.isArray(block.vector)) {
			fail('record-shape-invalid', `块 ${block.id} 缺少向量数组`);
		}
		for (const value of block.vector) {
			// 关键路径:vectra 不校验向量合法性,NaN/Infinity 会让 JSON 变成 null 并污染检索分数。
			if (typeof value !== 'number' || !Number.isFinite(value)) {
				fail('vector-non-finite', `块 ${block.id} 的向量含非有限值(NaN/Infinity)`);
			}
		}
	}
}

/**
 * 递归规范化元数据 — 只接受 JSON 可表达的值,对象按键排序。
 *
 * 关键路径:
 * - 普通对象 / 数组 / 字符串 / 有限数字 / 布尔 / null 是唯一合法输入;
 *   `Date`、`Map`、`Set`、类实例等会经 `JSON.stringify` 折叠成 `{}` 或丢字段,必须显式拒绝,
 *   不能把不同元数据算成同一指纹;
 * - `undefined` 统一丢弃:对象字段直接省略(与 `JSON.stringify` 一致),数组元素按 JSON 语义记为 `null`;
 * - 循环引用与不可 JSON 化的值(`bigint`/函数/符号)一律拒绝。
 */
function canonicalizeValue(value: unknown, seen: Set<object> = new Set()): unknown {
	if (value === null) return null;
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return value;
		case 'number':
			if (!Number.isFinite(value)) fail('record-shape-invalid', '块元数据含非有限数值');
			return value;
		case 'undefined':
			// 关键路径:对象字段由调用方丢弃;数组元素与 JSON.stringify 对齐为 null。
			return null;
		case 'object':
			break;
		default:
			fail('record-shape-invalid', `块元数据含不可 JSON 化的值:${typeof value}`);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) fail('record-shape-invalid', '块元数据存在循环引用');
		seen.add(value);
		const result = value.map((entry) => canonicalizeValue(entry, seen));
		seen.delete(value);
		return result;
	}
	if (!isPlainObject(value)) {
		fail(
			'record-shape-invalid',
			`块元数据含非 JSON 可表达的对象:${Object.prototype.toString.call(value)}`,
		);
	}
	if (seen.has(value)) fail('record-shape-invalid', '块元数据存在循环引用');
	seen.add(value);
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const entry = value[key];
		// 关键路径:`{ a: undefined }` 与 `{}` 必须得到同一指纹,不能把 undefined 字段序列化进去。
		if (entry === undefined) continue;
		sorted[key] = canonicalizeValue(entry, seen);
	}
	seen.delete(value);
	return sorted;
}

/** 判断是否为普通对象(原型为 `Object.prototype` 或 null);`Date`/`Map`/类实例都返回 false。 */
function isPlainObject(value: object): value is Record<string, unknown> {
	const prototype = Object.getPrototypeOf(value) as object | null;
	return prototype === Object.prototype || prototype === null;
}

// ==================== 通用断言与摘要 ====================

/** 计算 SHA-256 摘要(hex)。 */
function digestSha256(input: string | Uint8Array): string {
	return createHash('sha256').update(input).digest('hex');
}

/** 判断是否为普通对象(排除数组与 null)。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取非空字符串字段。 */
function requireNonEmptyString(source: Record<string, unknown>, field: string): string {
	const value = source[field];
	if (typeof value !== 'string' || value.length === 0) {
		fail('record-shape-invalid', `字段 ${field} 必须是非空字符串`);
	}
	return value;
}

/** 读取正整数字段。 */
function requirePositiveInteger(
	source: Record<string, unknown>,
	field: string,
	code: IndexValidationErrorCode = 'record-shape-invalid',
): number {
	const value = source[field];
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		fail(code, `字段 ${field} 必须是正整数,实际 ${String(value)}`);
	}
	return value;
}

/** 读取非负整数字段。 */
function requireNonNegativeInteger(
	source: Record<string, unknown>,
	field: string,
	code: IndexValidationErrorCode = 'record-shape-invalid',
): number {
	const value = source[field];
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		fail(code, `字段 ${field} 必须是非负整数,实际 ${String(value)}`);
	}
	return value;
}

/** 读取 SHA-256 hex 字段。 */
function requireChecksum(source: Record<string, unknown>, field: string): string {
	const value = source[field];
	if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
		fail('record-checksum-malformed', `字段 ${field} 必须是 64 位小写十六进制 SHA-256`);
	}
	return value;
}
