/**
 * @file src/core/index-manifest-recovery.ts
 * @description 派生清单恢复 — 只凭文件日志的完成记录/删除凭据核验并重建缺失的索引清单
 * @module core/index-manifest-recovery
 * @depends core/index-build-stamp(仅类型), core/index-manifest(仅类型)
 *
 * 设计要点:
 * - 本模块是 `PersistentIndexBackend.recoverMissingManifest` 的纯提取:不读写磁盘、不接触
 *   Obsidian、不接触 Vectra/日志实现,只消费注入的只读视图并返回纯数据清单;
 * - 判定沿用原实现的失败关闭(fail-closed)口径:配置身份、记录合法性、记录互斥、可检索覆盖、
 *   未决事务、块集合核验、构建戳与 vault 输入哈希,任何一项无法证明就返回拒绝原因码,
 *   既不猜、也不清库、更不退回全量重建(降级决策留给调用方);
 * - 输出不落盘:调用方拿到 `manifest` + `buildStamp` 后自行决定何时、以何种顺序写清单与构建戳。
 *
 * 依赖注入对照(生产侧按这些既有方法装配):
 * - `deps.fileRecords.listReceipts()` ↔ `IndexFileJournal.listReceipts()`(经 `PersistentIndexBackend`
 *   的 `FileRecordReader` 端口);
 * - `deps.fileRecords.listTombstones()` ↔ `IndexFileJournal.listTombstones()`;
 * - `deps.fileRecords.listSearchableReceipts()` ↔ `IndexFileJournal.listSearchableReceipts()`;
 * - `deps.fileRecords.hasPendingTransactions()` ↔ `IndexFileJournal.hasPendingTransactions()`;
 * - `deps.fileRecords.listPendingPaths()` ↔ `IndexFileJournal.listPendingPaths()`;
 * - `deps.verifyBlockSet(path)` ↔ `IndexFileJournal.verifyReceipt(path)` 中「完成记录 vs 实际块集合」
 *   的核验结论(取其 `matches` 与 `receipt`;原实现的 `blockSetHash` 不在本模块比对范围);
 * - `deps.fingerprint()` ↔ `PersistentIndexBackendOptions.getConfigFingerprint()`(当前配置指纹);
 * - `deps.expectedFingerprint` ↔ `IndexFileJournalOptions.configFingerprint`(记录写入时的配置代际);
 * - `deps.vaultInputs()` ↔ `PersistentIndexBackend.snapshot()` 产出的 `{ path, hash }` 视图;
 * - `deps.inFlight()` ↔ `PersistentIndexBackend.roundState()` 的 `active` / `pendingTransactions`;
 * - `deps.readStoredStamp()` ↔ `readBuildStamp(indexDir)`(返回 null 表示缺失/不可解析);
 * - `deps.buildStamp` ↔ `PersistentIndexBackendOptions.getBuildStamp()`;
 * - `deps.now` ↔ `Date.now`(测试用时钟);
 * - `deps.allowFirstBuild` ↔ 原实现的「旧式空索引首次全量」分支,生产路径**不得**置为 true。
 *
 * 已知边界:
 * - 首次构建分支只允许「完成记录、删除记录、可检索集合三者皆空」时显式声明;
 *   该分支返回空清单且不核对 vault 输入(与原先「由调用方走全量」的语义一致);
 * - 所有注入调用抛错都收敛成拒绝原因码,不向上抛异常,避免调用方把读取失败当成可恢复。
 */
import type { IndexBuildStamp } from './index-build-stamp';
import type { IndexManifestData, IndexManifestEntry } from './index-manifest';

// ==================== 类型契约 ====================

/**
 * 完成记录/删除凭据的最小结构视图 — 与 `FileCommit`、`CommittedFileRecord` 结构兼容。
 *
 * 关键路径:`configFingerprint` 在旧端口上是可选的;缺失即无法证明记录属于当前配置,
 * 本模块按拒绝处理,而不是按空串/通配接受。
 */
export interface ManifestRecoveryRecord {
	/** vault 规范化相对路径。 */
	path: string;
	/** 版本状态:完成记录为 present,删除凭据为 deleted。 */
	state: 'present' | 'deleted';
	/** 同路径单调递增版本号。 */
	revision: number;
	/** 输入内容 hash;删除记录必须为 null。 */
	inputHash: string | null;
	/** 块数量;删除记录必须为 0。 */
	chunkCount: number;
	/** 记录写入时的配置指纹。 */
	configFingerprint?: string;
}

/** 完成记录与实际块集合的核验结论 — 对应 `ReceiptVerification` 的最小视图。 */
export interface BlockSetVerification {
	/** 块集合是否与完成记录逐一匹配(数量、commitId、块集合 hash、维度)。 */
	matches: boolean;
	/** 磁盘上重新读取的完成记录;必须与列表里的记录逐字段一致。 */
	receipt: ManifestRecoveryRecord;
}

/** 文件记录读取源 — 对应 `IndexFileJournal` 的只读入口。 */
export interface ManifestRecoveryRecordSource {
	/** 全部可信的 present 完成记录。 */
	listReceipts(): Promise<ReadonlyArray<ManifestRecoveryRecord>>;
	/** 全部可信的删除凭据;与完成记录互斥。 */
	listTombstones(): Promise<ReadonlyArray<ManifestRecoveryRecord>>;
	/** 可检索的完成记录 — 已扣除 tombstone 与隔离/不可用路径。 */
	listSearchableReceipts(): Promise<ReadonlyArray<ManifestRecoveryRecord>>;
	/** 未决事务目录里是否存在任何条目(含损坏/未准备完毕)。 */
	hasPendingTransactions(): Promise<boolean>;
	/** 未决事务声明的目标路径。 */
	listPendingPaths(): Promise<ReadonlyArray<string>>;
}

/** vault 输入视图 — 对应 `snapshot()` 里参与 hash diff 的两个字段。 */
export interface ManifestRecoveryVaultInput {
	/** vault 相对路径。 */
	path: string;
	/** `sha256(content)`。 */
	hash: string;
}

/** 本轮在途计数视图 — 对应 `roundState()` 的写入活跃度。 */
export interface ManifestRecoveryInFlight {
	/** 在途提交数。 */
	active: number;
	/** 未决事务数。 */
	pendingTransactions: number;
}

/** 恢复模块的依赖集合 — 全部由调用方注入。 */
export interface ManifestRecoveryDeps {
	/** 文件日志只读视图。 */
	fileRecords: ManifestRecoveryRecordSource;
	/** 逐路径核对完成记录与实际块集合;返回 null 或 matches=false 都算核验失败。 */
	verifyBlockSet(path: string): Promise<BlockSetVerification | null>;
	/** 当前配置指纹提供者(每次恢复时重新取值)。 */
	fingerprint(): string | null;
	/** 记录必须携带的配置指纹 — 日志写入时的配置代际。 */
	expectedFingerprint: string;
	/** vault 当前输入视图(path + hash)。 */
	vaultInputs(): Promise<ReadonlyArray<ManifestRecoveryVaultInput>>;
	/** 持久化构建戳;null 表示缺失或不可解析(与 `readBuildStamp` 一致,不据此拒绝)。 */
	readStoredStamp(): Promise<IndexBuildStamp | null>;
	/** 当前构建规则,写入输出清单。 */
	buildStamp: IndexBuildStamp;
	/** 本轮在途计数。 */
	inFlight(): ManifestRecoveryInFlight;
	/** 时钟;缺省 `Date.now`。 */
	now?: () => number;
	/** 显式声明「这是首次构建」;只有三者皆空时才允许空清单,生产路径不得置为 true。 */
	allowFirstBuild?: boolean;
}

/**
 * 拒绝原因码 — 每一项都表示「无法证明派生清单可恢复」。
 *
 * 关键路径:调用方只能据此记录日志或交还协调器,不得把任何拒绝当成「清库」或
 * 「退回全量重建」的依据。
 */
export const MANIFEST_RECOVERY_REJECTION_REASONS = [
	/** 必需依赖缺失或不是函数 — 无法开始核验。 */
	'dependencies-missing',
	/** 记录读取失败、返回非数组或抛错 — 无法确认记录集合。 */
	'records-unreadable',
	/** 当前指纹为空/非 64 位小写十六进制,或期望指纹本身不合法。 */
	'fingerprint-invalid',
	/** 当前指纹与期望指纹不一致,或记录携带的指纹与期望代际不一致。 */
	'fingerprint-mismatch',
	/** 单条记录字段不合法(state/path/revision/chunkCount/inputHash)。 */
	'record-invalid',
	/** 同一路径重复出现,或同时出现在完成记录与删除记录两侧。 */
	'record-conflict',
	/** 可检索集合未完整覆盖 present 完成记录,或字段与完成记录不一致。 */
	'searchable-coverage-mismatch',
	/** 存在未决事务目录或未决路径 — 旧完成记录可能已被在途事务覆盖。 */
	'pending-transaction',
	/** 协调器仍有在途提交/未决事务计数。 */
	'round-in-flight',
	/** 在途计数不可读(缺失、非安全整数或为负)。 */
	'round-state-invalid',
	/** 块集合核验失败或核验返回的记录与列表记录不一致。 */
	'block-verification-failed',
	/** 持久化构建戳与当前构建规则不一致。 */
	'build-stamp-mismatch',
	/** vault 输入视图不可读或字段非法。 */
	'vault-input-invalid',
	/** vault 文件集合或内容 hash 与完成记录不一致。 */
	'vault-input-mismatch',
	/** 三者皆空但调用方没有显式声明首次构建。 */
	'empty-index-not-first-build',
] as const;

/** 拒绝原因码联合类型。 */
export type ManifestRecoveryRejectionReason = (typeof MANIFEST_RECOVERY_REJECTION_REASONS)[number];

/** 恢复被拒绝 — 明确原因,不做任何破坏性动作。 */
export interface ManifestRecoveryRejection {
	readonly ok: false;
	/** 拒绝原因码。 */
	readonly reason: ManifestRecoveryRejectionReason;
	/** 定位信息(路径或依赖名),不含笔记正文。 */
	readonly detail?: string;
}

/** 恢复成功 — 纯数据清单与构建戳信息,尚未写盘。 */
export interface ManifestRecoverySuccess {
	readonly ok: true;
	/** 可直接交给 `IndexManifest.save` 的纯数据清单。 */
	readonly manifest: IndexManifestData;
	/** 与清单同源的构建戳;写入顺序由调用方决定。 */
	readonly buildStamp: IndexBuildStamp;
	/** 与 vault 输入逐条一致的条目数(即原实现返回的 skipped)。 */
	readonly skipped: number;
	/** 是否走了「显式首次构建」空清单分支。 */
	readonly firstBuild: boolean;
}

/** 恢复结果。 */
export type ManifestRecoveryResult = ManifestRecoveryRejection | ManifestRecoverySuccess;

// ==================== 内部工具 ====================

/** 与配置指纹格式一致的 64 位小写十六进制。 */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** 是否为 64 位小写十六进制 hash。 */
function isHex64(value: unknown): value is string {
	return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

/** 是否为非负安全整数。 */
function isSafeCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 构造一条拒绝结果。 */
function reject(reason: ManifestRecoveryRejectionReason, detail?: string): ManifestRecoveryRejection {
	return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/** 依赖对象是否具备记录源的全部入口。 */
function isRecordSource(value: unknown): value is ManifestRecoveryRecordSource {
	if (!value || typeof value !== 'object') return false;
	const source = value as Partial<ManifestRecoveryRecordSource>;
	return typeof source.listReceipts === 'function'
		&& typeof source.listTombstones === 'function'
		&& typeof source.listSearchableReceipts === 'function'
		&& typeof source.hasPendingTransactions === 'function'
		&& typeof source.listPendingPaths === 'function';
}

/** 单条记录字段核验 — 返回 null 表示合法。 */
function validateRecord(
	record: ManifestRecoveryRecord,
	expectedState: ManifestRecoveryRecord['state'],
	expectedFingerprint: string,
	seen: ReadonlySet<string>,
): ManifestRecoveryRejectionReason | null {
	if (!record || typeof record !== 'object' || Array.isArray(record)) return 'record-invalid';
	if (record.state !== expectedState) return 'record-invalid';
	if (typeof record.path !== 'string' || record.path.length === 0) return 'record-invalid';
	// 互斥与去重:同一路径只允许一条当前凭据,跨两侧重复说明记录集自相矛盾。
	if (seen.has(record.path)) return 'record-conflict';
	if (record.configFingerprint !== expectedFingerprint) return 'fingerprint-mismatch';
	if (!Number.isSafeInteger(record.revision) || record.revision < 1) return 'record-invalid';
	if (!Number.isSafeInteger(record.chunkCount) || record.chunkCount < 0) return 'record-invalid';
	if (expectedState === 'present') {
		if (!isHex64(record.inputHash)) return 'record-invalid';
	} else if (record.inputHash !== null || record.chunkCount !== 0) {
		// 删除凭据必须同时满足 inputHash=null 与 chunkCount=0,只满足一半不能当作已删除。
		return 'record-invalid';
	}
	return null;
}

// ==================== 恢复入口 ====================

/**
 * 从可信完成记录恢复派生清单 — 只做核验与纯数据组装,不写盘。
 *
 * 核验顺序与 `PersistentIndexBackend.recoverMissingManifest` 一致:
 * 记录集合 → 显式首次构建 → 配置指纹 → 未决事务/未决路径 → 在途计数 → 记录字段与互斥 →
 * 可检索覆盖 → 逐条块集合核验 → 持久化构建戳 → vault 输入 hash diff。
 *
 * @param deps - 全部只读依赖;任一缺失或返回不可信都失败关闭。
 * @returns 成功时给出 `manifest` + `buildStamp`(调用方负责写盘);失败时给出明确原因码。
 * @example
 *   const result = await recoverDerivedManifest({
 *     fileRecords: journal,
 *     verifyBlockSet: (path) => journal.verifyReceipt(path),
 *     fingerprint: () => backendOptions.getConfigFingerprint?.(),
 *     expectedFingerprint: journalConfigFingerprint,
 *     vaultInputs: async () => snapshot().then((files) => files.map(({ path, hash }) => ({ path, hash }))),
 *     readStoredStamp: () => readBuildStamp(indexDir),
 *     buildStamp: getBuildStamp(),
 *     inFlight: () => roundState(),
 *   });
 *   if (result.ok) await manifest.save(result.manifest);
 */
export async function recoverDerivedManifest(deps: ManifestRecoveryDeps): Promise<ManifestRecoveryResult> {
	if (!deps || typeof deps !== 'object'
		|| !isRecordSource(deps.fileRecords)
		|| typeof deps.verifyBlockSet !== 'function'
		|| typeof deps.fingerprint !== 'function'
		|| typeof deps.vaultInputs !== 'function'
		|| typeof deps.readStoredStamp !== 'function'
		|| typeof deps.inFlight !== 'function'
		|| !deps.buildStamp) {
		return reject('dependencies-missing');
	}

	// 关键路径:三路记录必须来自同一次读取;分三次串行读取会放大 TOCTOU 窗口。
	let lists: [ReadonlyArray<ManifestRecoveryRecord>, ReadonlyArray<ManifestRecoveryRecord>, ReadonlyArray<ManifestRecoveryRecord>];
	try {
		lists = await Promise.all([
			deps.fileRecords.listReceipts(),
			deps.fileRecords.listTombstones(),
			deps.fileRecords.listSearchableReceipts(),
		]) as typeof lists;
	}
	catch {
		return reject('records-unreadable');
	}
	const [receipts, tombstones, searchable] = lists;
	// 原实现同样拒绝非数组:非数组不能当作空集,否则会把「读失败」伪装成「没有记录」。
	if (!Array.isArray(receipts) || !Array.isArray(tombstones) || !Array.isArray(searchable)) {
		return reject('records-unreadable');
	}

	const now = deps.now ?? Date.now;

	// 关键路径:纯旧空库只有调用方显式声明首次构建时才允许空清单;生产恢复路径不得设置该标志。
	if (receipts.length === 0 && tombstones.length === 0 && searchable.length === 0) {
		if (deps.allowFirstBuild !== true) return reject('empty-index-not-first-build');
		return {
			ok: true,
			firstBuild: true,
			// 首次构建的清单由后续全量扫描填充,这里只给出可落盘的空白骨架。
			manifest: { version: 1, ...deps.buildStamp, entries: {}, lastIndexTime: now() },
			buildStamp: { ...deps.buildStamp },
			skipped: 0,
		};
	}

	let currentFingerprint: unknown;
	try {
		currentFingerprint = deps.fingerprint();
	}
	catch {
		return reject('fingerprint-invalid');
	}
	if (!isHex64(currentFingerprint)) return reject('fingerprint-invalid');
	if (!isHex64(deps.expectedFingerprint)) return reject('fingerprint-invalid', 'expectedFingerprint');
	// 关键路径:日志写入时的配置代际与当前配置代际必须一致;不一致说明记录属于另一套配置。
	if (currentFingerprint !== deps.expectedFingerprint) return reject('fingerprint-mismatch');

	let hasPending: unknown;
	try {
		hasPending = await deps.fileRecords.hasPendingTransactions();
	}
	catch {
		return reject('records-unreadable', 'hasPendingTransactions');
	}
	if (typeof hasPending !== 'boolean') return reject('records-unreadable', 'hasPendingTransactions');
	if (hasPending) return reject('pending-transaction', 'pending-directory');

	let pendingPaths: unknown;
	try {
		pendingPaths = await deps.fileRecords.listPendingPaths();
	}
	catch {
		return reject('records-unreadable', 'listPendingPaths');
	}
	if (!Array.isArray(pendingPaths)) return reject('records-unreadable', 'listPendingPaths');
	if (pendingPaths.length > 0) return reject('pending-transaction', String(pendingPaths.length));

	let inFlight: ManifestRecoveryInFlight;
	try {
		inFlight = deps.inFlight();
	}
	catch {
		return reject('round-state-invalid');
	}
	if (!inFlight || typeof inFlight !== 'object'
		|| !isSafeCount(inFlight.active) || !isSafeCount(inFlight.pendingTransactions)) {
		return reject('round-state-invalid');
	}
	if (inFlight.active > 0 || inFlight.pendingTransactions > 0) return reject('round-in-flight');

	// 完成记录与删除凭据必须合法且互斥:同一路径同时出现两侧,无法判断当前真值。
	const seen = new Set<string>();
	for (const [records, expectedState] of [[receipts, 'present'], [tombstones, 'deleted']] as const) {
		for (const record of records) {
			const failure = validateRecord(record, expectedState, deps.expectedFingerprint, seen);
			if (failure !== null) return reject(failure, record && typeof record.path === 'string' ? record.path : undefined);
			seen.add(record.path);
		}
	}

	// 关键路径:可检索集合必须与 present 集合逐条同构;隔离/不可用路径不能冒充可检索。
	const searchableByPath = new Map<string, ManifestRecoveryRecord>();
	for (const record of searchable) {
		if (!record || typeof record !== 'object' || typeof record.path !== 'string' || record.path.length === 0) {
			return reject('searchable-coverage-mismatch', 'invalid-searchable-record');
		}
		if (searchableByPath.has(record.path)) return reject('searchable-coverage-mismatch', record.path);
		searchableByPath.set(record.path, record);
	}
	if (receipts.length + tombstones.length === 0
		|| searchable.length !== receipts.length
		|| searchableByPath.size !== receipts.length) {
		return reject('searchable-coverage-mismatch');
	}
	for (const record of receipts) {
		const candidate = searchableByPath.get(record.path);
		if (!candidate
			|| candidate.state !== 'present'
			|| candidate.inputHash !== record.inputHash
			|| candidate.revision !== record.revision
			|| candidate.chunkCount !== record.chunkCount
			|| candidate.configFingerprint !== deps.expectedFingerprint) {
			return reject('searchable-coverage-mismatch', record.path);
		}
	}

	// 关键路径:完成记录只能证明「提交过」;恢复前必须逐条核对当前向量块与磁盘记录,
	// 删除凭据同样要核验(目标状态是「该路径没有块」)。
	for (const record of [...receipts, ...tombstones]) {
		let verified: BlockSetVerification | null;
		try {
			verified = await deps.verifyBlockSet(record.path);
		}
		catch {
			// 核验抛错同样不能放行:无法确认块集合就失败关闭。
			return reject('block-verification-failed', record.path);
		}
		if (!verified || verified.matches !== true || !verified.receipt) {
			return reject('block-verification-failed', record.path);
		}
		const diskReceipt = verified.receipt;
		// 关键路径:核验期间记录可能被重写,返回的记录必须与列表记录逐字段一致才算同一版本。
		if (diskReceipt.path !== record.path
			|| diskReceipt.revision !== record.revision
			|| diskReceipt.state !== record.state
			|| diskReceipt.inputHash !== record.inputHash
			|| diskReceipt.chunkCount !== record.chunkCount
			|| diskReceipt.configFingerprint !== deps.expectedFingerprint) {
			return reject('block-verification-failed', record.path);
		}
	}

	// 关键路径:持久化构建戳存在时必须与当前规则一致;缺失/null 不构成不兼容(沿用 readBuildStamp 口径)。
	let storedStamp: IndexBuildStamp | null;
	try {
		storedStamp = await deps.readStoredStamp();
	}
	catch {
		return reject('build-stamp-mismatch', 'read-failed');
	}
	if (storedStamp !== null && storedStamp !== undefined && !isSameBuildStamp(storedStamp, deps.buildStamp)) {
		return reject('build-stamp-mismatch');
	}

	let vaultInputs: ReadonlyArray<ManifestRecoveryVaultInput>;
	try {
		vaultInputs = await deps.vaultInputs();
	}
	catch {
		return reject('vault-input-invalid', 'read-failed');
	}
	if (!Array.isArray(vaultInputs)) return reject('vault-input-invalid');

	// 关键路径:mtime 只能来自实际索引时的快照;日志没有该字段,统一设 0 强制下次启动用 hash 核实。
	const entries: Record<string, IndexManifestEntry> = {};
	for (const record of receipts) {
		entries[record.path] = {
			path: record.path,
			hash: record.inputHash!,
			mtime: 0,
			chunkCount: record.chunkCount,
		};
	}

	// 关键路径:清单不能自证;必须与 vault 当前输入逐一 hash 相等、且两侧文件集合相同,
	// 否则恢复出来的清单会把未索引文件标成已处理(或漏掉已删除文件)。
	const vaultPaths = new Set<string>();
	for (const input of vaultInputs) {
		if (!input || typeof input !== 'object'
			|| typeof input.path !== 'string' || input.path.length === 0
			|| !isHex64(input.hash)
			|| vaultPaths.has(input.path)) {
			return reject('vault-input-invalid', input && typeof input.path === 'string' ? input.path : undefined);
		}
		vaultPaths.add(input.path);
		const entry = entries[input.path];
		if (!entry || entry.hash !== input.hash) return reject('vault-input-mismatch', input.path);
	}
	if (vaultPaths.size !== receipts.length) {
		// 记录里有、vault 里没有:等价于原实现的 toDelete 非空。
		const extra = receipts.find(record => !vaultPaths.has(record.path));
		return reject('vault-input-mismatch', extra?.path);
	}

	return {
		ok: true,
		firstBuild: false,
		manifest: { version: 1, ...deps.buildStamp, entries, lastIndexTime: now() },
		buildStamp: { ...deps.buildStamp },
		skipped: vaultInputs.length,
	};
}

/** 构建戳是否与当前规则完全一致 — 与 `isBuildStampCurrent` 的字段口径一致。 */
function isSameBuildStamp(stored: IndexBuildStamp, current: IndexBuildStamp): boolean {
	return stored.chunkerVersion === current.chunkerVersion
		&& stored.chunkSize === current.chunkSize
		&& stored.chunkOverlap === current.chunkOverlap
		&& stored.embedModelId === current.embedModelId;
}
