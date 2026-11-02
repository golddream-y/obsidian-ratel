/**
 * @file src/core/index-runtime-assembly.ts
 * @description 索引运行时装配 — 代际解析、写所有权、日志、协调器、看护与检索门的宿主无关构造
 * @module core/index-runtime-assembly
 * @depends adapters/atomic-index-storage, adapters/vector-vectra, core/index-write-owner,
 *   core/index-generations, core/index-file-journal, core/index-task-coordinator,
 *   core/index-search-visibility, core/index-processor-port, core/index-persistence-types,
 *   core/index-manifest, utils/hash, core/multi-query-searcher, user-feedback/user-status
 *
 * 关键路径(T8 装配下沉):
 * - 本模块**不导入 `obsidian`**,也不读写宿主插件的类字段:路径、Vault 端口、嵌入端口、
 *   分块参数、状态落点与存储/Store 工厂全部由调用方以参数注入。装配算法因此可以在
 *   无宿主替身的独立子进程/夹具里直接构造完整索引管线 —— 这正是 T8 崩溃与规模验收的前提。
 * - `main.ts` 只保留生命周期与接线，把返回值写回实例字段；配置身份判定在本模块统一执行。
 * - 只读装配(`autoIndex=false`)与写路径装配共用同一份存储/日志/可见性构造,避免接线漂移。
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AtomicIndexStorage } from '../adapters/atomic-index-storage';
import { VectraStore, type FileReplaceStore } from '../adapters/vector-vectra';
import { devLogger } from '../logging/dev-logger';
import { sha256 } from '../utils/hash';
import { resolveIndexManifestPath } from './index-manifest';
import { IndexWriteOwner, type IndexWriteOwnerOptions } from './index-write-owner';
import {
	IndexGenerations,
	type GenerationControlRecord,
} from './index-generations';
import { IndexFileJournal } from './index-file-journal';
import {
	IndexStallWatchdog,
	IndexTaskCoordinator,
	type CoordinatorJournalPort,
	type IndexStallSource,
} from './index-task-coordinator';
import {
	captureSearchVisibilitySnapshot,
	createJournalVisibilitySource,
	createReadOnlyOwnerGuard,
	ReadOnlySearchView,
	SearchVisibilityGate,
} from './index-search-visibility';
import {
	ChunkingCoordinatorProcessor,
	createFirstCommitPromoter,
	createStrictDropOwnershipAssertion,
	resolveIndexGeneration,
	type IndexGenerationLegacySource,
	type ResolveIndexGenerationResult,
} from './index-processor-port';
import { INDEX_CONFIG_FINGERPRINT_FIELDS, type IndexConfigDescriptor } from './index-persistence-types';
import type { IndexRuntimeIdentityGuard } from './index-runtime-identity-guard';
import type { ChunkOptions } from '../worker/chunker';
import type { EmbeddingPort } from '../ports/embedding';
import type {
	SearchCandidateGate,
	SearchCandidateVerdict,
} from './multi-query-searcher';
import type { IndexConclusionDiagnostics } from '../user-feedback/user-status';

/** 停滞判定阈值 — 略短于 WorkerManager 的无进展超时,由看护先把阶段标成停滞。 */
export const INDEX_RUNTIME_STALL_AFTER_MS = 60_000;

// ==================== 注入端口 ====================

/**
 * 索引运行时所需的 Vault 端口 — 枚举、读取与 stat。
 *
 * 关键路径:只声明索引链路真正调用的能力;宿主用 `ObsidianVault` 满足它,夹具用合成目录满足它。
 */
export interface IndexRuntimeVaultPort {
	listMarkdownFiles(): string[];
	readFile(path: string): Promise<string>;
	stat(path: string): { mtime: number; size?: number } | null;
}

/** 原子存储工厂 — 夹具注入可观测/故障注入实现,生产用缺省。 */
export type IndexRuntimeStorageFactory = (generationRoot: string) => AtomicIndexStorage;

/** VectraStore 工厂 — 夹具注入可观测实现,生产用缺省。 */
export type IndexRuntimeStoreFactory = (
	indexDir: string,
	options: { autoInit: boolean; storage: AtomicIndexStorage },
) => VectraStore;

/** 缺省原子存储工厂 — 与迁移前 `main.ts` 的 `createIndexStorage` 逐字一致。 */
export function createIndexRuntimeStorage(generationRoot: string): AtomicIndexStorage {
	return new AtomicIndexStorage({ generationRoot });
}

/** 缺省 VectraStore 工厂 — 与迁移前 `main.ts` 的 `createVectraStore` 逐字一致。 */
export function createIndexRuntimeStore(
	indexDir: string,
	options: { autoInit: boolean; storage: AtomicIndexStorage },
): VectraStore {
	return new VectraStore(indexDir, { autoInit: options.autoInit, storage: options.storage });
}

// ==================== 纯函数与共用构造 ====================

/**
 * 由配置描述派生会话内配置身份 — 与配置指纹**同源同序**的全部输入,用于同步比对。
 *
 * 关键路径:身份串必须覆盖指纹的全部字段。此前只取 5 个字段,模型修订与嵌入文本模板
 * 变化会改指纹却不改身份,导致同一会话内「装配期指纹」与「实时参数」不一致而被静默放行。
 *
 * @param config - 当前配置描述。
 * @returns 身份字符串(仅用于比对,不参与指纹/清单)。
 */
export function configIdentityOf(config: IndexConfigDescriptor): string {
	return INDEX_CONFIG_FINGERPRINT_FIELDS.map((field) => String(config[field])).join('|');
}

/**
 * 汇总迁移/回收结论面 — 诊断落点的唯一来源(T7/I4)。
 *
 * @param resolution - 代际解析结论。
 * @returns 结构化结论面(不含笔记正文、路径与密钥)。
 */
export function summarizeIndexConclusion(resolution: ResolveIndexGenerationResult): IndexConclusionDiagnostics {
	const quarantinedGenerations: string[] = [];
	for (const [generationId, record] of Object.entries(resolution.control.generations)) {
		if (record.quarantineReason !== null) quarantinedGenerations.push(`${generationId}:${record.quarantineReason}`);
	}
	const summary: IndexConclusionDiagnostics = { quarantinedGenerations };
	if (resolution.migration !== null) {
		const files = resolution.migration.files;
		summary.migration = {
			phase: resolution.migration.phase,
			reused: files.filter((file) => file.status === 'reusable').length,
			reindex: files.filter((file) => file.status === 'reindex').length,
			statePersisted: resolution.migration.statePersisted,
		};
	}
	if (resolution.reconcile !== null) {
		const { decision, quarantinedTransactions } = resolution.reconcile;
		summary.reconcile = {
			orphanDirectories: decision.orphanDirectories.length,
			retained: decision.retained.length,
			quarantinedTransactions,
			blocked: !decision.canCreate,
			blockedReason: decision.blockedReason,
		};
	}
	return summary;
}

/**
 * 日志使用的存储视图 — 延迟绑定到带访问门的处理器存储。
 *
 * 关键路径(T5/B1):协调器驱动的 `replaceFile` 必须走同一个访问门,否则查询可能读到
 * 文件事务的中间状态。模型就绪前处理器尚未初始化,回落到调用方自己的存储实例。
 *
 * @param getActiveStore - 读取当前处理器存储;未初始化时返回 undefined。
 * @param getFallbackStore - 回落存储(装配期构造的 VectraStore)。
 * @returns 文件级替换存储视图。
 */
export function createActiveFileStore(
	getActiveStore: () => FileReplaceStore | undefined,
	getFallbackStore: () => FileReplaceStore,
): FileReplaceStore {
	const resolve = (): FileReplaceStore => getActiveStore() ?? getFallbackStore();
	return {
		replaceFile: (input) => resolve().replaceFile(input),
		inspectFile: (filePath) => resolve().inspectFile(filePath),
		reload: () => resolve().reload(),
	};
}

/**
 * 停滞看护的进展来源 — 空闲(已 ready / 已暂停)时按「有进展」上报。
 *
 * 关键路径:看护只应判定「任务在跑但没进展」;没有工作时每次都算进展,避免 ready 状态
 * 被误报成停滞。此处的空闲判定来自协调器本身,不引入第二份状态。
 *
 * @param coordinator - 协调器。
 * @returns 停滞来源视图。
 */
export function createIndexStallSource(coordinator: IndexTaskCoordinator): IndexStallSource {
	let idleBump = 0;
	return {
		progressMark: () => {
			if (coordinator.isReady() || coordinator.isPaused()) idleBump += 1;
			return coordinator.progressMark() + idleBump;
		},
		lastActivity: () => coordinator.lastActivity(),
		markStalled: () => coordinator.markStalled(),
		markResumed: () => coordinator.markResumed(),
		expiredRequeues: () => coordinator.expiredRequeues(),
	};
}

/**
 * 严格归属断言 — 只允许删除本索引根 `generations/` 下的**非活动**代际目录(T6 §8.2 + T7 收口)。
 *
 * @param options.indexRoot - 受保护的索引根。
 * @param options.isActiveGeneration - 判定目标代际是否为当前活动代际。
 * @param indexDir - 待删除目录。
 * @throws {IndexDirectoryNotOwnedError} 归属或活动代际判定不通过。
 */
export function assertIndexRuntimeDropOwnership(
	options: { indexRoot: string; isActiveGeneration: (generationId: string) => boolean },
	indexDir: string,
): void {
	createStrictDropOwnershipAssertion({
		indexRoot: options.indexRoot,
		// 关键路径(T7 数据风险):形状/归属合法仍可能是**当前活动代际**。活动代际目录被递归删除
		// 会抹掉向量、`files/` 完成记录、清单与构建戳,而控制指针仍指向它 —— 这里与
		// `dropSafeGeneration` 的控制指针校验形成纵深,任何清库入口都过不去。
		isActiveGeneration: options.isActiveGeneration,
	})(indexDir);
}

/**
 * 读取当前 Vault 的内容 hash 视图 — 只读,失败路径按「未知」(null)处理。
 *
 * @param vault - Vault 端口。
 * @returns 路径 → 内容 hash;不可读为 null。
 */
export async function readCurrentInputHashes(
	vault: IndexRuntimeVaultPort,
): Promise<Map<string, string | null>> {
	const inputs = new Map<string, string | null>();
	for (const filePath of vault.listMarkdownFiles()) {
		try {
			inputs.set(filePath, await sha256(await vault.readFile(filePath)));
		} catch {
			// 关键路径:读不了的路径按「未知」,迁移不得据此复用旧块。
			inputs.set(filePath, null);
		}
	}
	return inputs;
}

/**
 * legacy 索引只读描述 — 没有旧索引时返回 null,且不构造任何存储。
 *
 * @param options.indexRoot - 索引根(旧索引也在这里)。
 * @param options.vault - Vault 端口(用于当前内容 hash)。
 * @param options.createStorage - 原子存储工厂;缺省用生产实现。
 * @returns 迁移输入;不存在旧索引时为 null。
 */
export async function describeLegacyIndex(options: {
	indexRoot: string;
	vault: IndexRuntimeVaultPort;
	createStorage?: IndexRuntimeStorageFactory;
}): Promise<IndexGenerationLegacySource | null> {
	const createStorage = options.createStorage ?? createIndexRuntimeStorage;
	// 关键路径:旧版索引根的标志是 `index.json` 与旧清单同时存在;缺一即不构成 legacy,
	// 不猜测、不迁移(否则会把半截目录当旧索引)。
	try {
		if (!fs.statSync(path.join(options.indexRoot, 'index.json')).isFile()) return null;
	} catch {
		return null;
	}
	const manifestPath = resolveIndexManifestPath(options.indexRoot);
	if (!fs.existsSync(manifestPath)) return null;
	// 关键路径:只读枚举旧块,不初始化写入(`autoInit:false`);迁移只读复制,不改旧目录。
	const legacyStore = new VectraStore(options.indexRoot, {
		autoInit: false,
		storage: createStorage(options.indexRoot),
	});
	const currentInputs = await readCurrentInputHashes(options.vault);
	// 关键路径:绑定后再判定 —— 直接取用类方法会触发 unbound-method,且调用时必须带正确 this。
	const inspectFiles = legacyStore.inspectFiles?.bind(legacyStore);
	return {
		indexDir: options.indexRoot,
		manifestPath,
		store: {
			inspectFile: (p) => legacyStore.inspectFile(p),
			...(inspectFiles === undefined ? {} : { inspectFiles }),
		},
		currentInputs,
	};
}

/**
 * 启动期日志恢复 — 只在存在未决事务时才读全库内容 hash。
 *
 * 关键路径:恢复必须能证明事务声明的输入仍是当前内容,否则绝不发布为当前版本;
 * 没有未决事务时跳过,避免每次启动都读全库正文。
 *
 * @param options.journal - 文件日志;未装配时为 undefined。
 * @param options.vault - Vault 端口。
 */
export async function recoverIndexJournal(options: {
	journal?: IndexFileJournal;
	vault: IndexRuntimeVaultPort;
}): Promise<void> {
	const journal = options.journal;
	if (!journal) return;
	// 关键路径:孤儿隔离事务不需要读正文就能判定,先回收再走恢复;
	// 回收失败不影响恢复本身,但必须留下日志,不能静默累积磁盘垃圾。
	try {
		const reclaimed = await journal.reclaimOrphanQuarantinedTransactions();
		if (reclaimed.reclaimed.length > 0) {
			devLogger.info('index', `回收孤立隔离事务:${reclaimed.reclaimed.length} 个,保留 ${reclaimed.retained.length} 个`);
		}
	} catch (err) {
		devLogger.error('index', '回收孤立隔离事务失败', err);
	}
	let pending: string[];
	try {
		pending = await journal.listPendingPaths();
	} catch (err) {
		devLogger.error('index', '枚举未决索引事务失败', err);
		return;
	}
	if (pending.length === 0) return;
	try {
		const report = await journal.recover({ currentInputs: await readCurrentInputHashes(options.vault) });
		devLogger.info('index', `索引日志恢复:${report.decisions.length} 条决策,失败事务 ${report.failures.length}`);
	} catch (err) {
		devLogger.error('index', '索引日志恢复失败', err);
	}
}

/**
 * 清理非活动代际 — 唯一安全的破坏性入口。
 *
 * 关键路径:活动代际不可删除(`dropSafeGeneration` 拒绝未登记/活动目标),
 * `.index/` 根与 `generations/` 聚合目录也不可删除(T6 §2)。因此本入口只清理
 * **非活动**代际;活动索引的强制重建改走 `reindex`(逐文件重新核对),
 * **不静默丢弃当前有效索引**。清理正在构建/核对的代际会让本轮工作白做,故跳过。
 *
 * @param options.generations - 代际管理实例。
 * @param options.lease - 写所有权租约。
 * @returns 实际清理的代际数量;没有写所有权时为 null(调用方据此显示「拒绝清理」)。
 */
export async function dropInactiveGenerations(options: {
	generations?: IndexGenerations;
	lease?: IndexWriteOwner;
}): Promise<number | null> {
	const generations = options.generations;
	const lease = options.lease;
	if (!generations || !lease) {
		devLogger.warn('index', '索引未装配写所有权,拒绝清库');
		return null;
	}
	lease.assertWritable();
	const control = await generations.readControl();
	let dropped = 0;
	for (const [generationId, record] of Object.entries(control.generations)) {
		if (generationId === control.activeGenerationId) continue;
		if (record.status === 'building' || record.status === 'verifying') continue;
		await generations.dropSafeGeneration(generations.generationRootOf(generationId));
		const next = await generations.readControl();
		const rest = { ...next.generations };
		delete rest[generationId];
		await generations.writeControl({ ...next, generations: rest });
		dropped += 1;
	}
	devLogger.info('index', `已清理 ${dropped} 个非活动代际`);
	return dropped;
}

// ==================== 写路径管线装配 ====================

/** 写路径管线装配依赖。 */
export interface AssembleIndexPipelineDeps {
	/** 代际目录(绝对路径)。 */
	indexDir: string;
	/** 代际 ID。 */
	generationId: string;
	/** 当前配置指纹。 */
	configFingerprint: string;
	/** 写所有权租约。 */
	lease: IndexWriteOwner;
	/** 代际管理实例。 */
	generations: IndexGenerations;
	/** Vault 端口。 */
	vault: IndexRuntimeVaultPort;
	/** 嵌入端口(分块后推理)。 */
	embedding: EmbeddingPort;
	/** 捕获当前分块参数 — 与 Worker 侧 `buildChunkOptions` 同源。 */
	getChunkOptions: () => ChunkOptions;
	/** 期望向量维度。 */
	expectedDimension: number;
	/** 该路径当前是否被黑名单排除。 */
	isExcluded?: (path: string) => boolean;
	/** 候选存在性判定(只读可见性视图);缺省视为不存在。支持异步(宿主 fileExists 是 async)。 */
	fileExists?: (path: string) => boolean | Promise<boolean>;
	/** 读取当前处理器存储(带访问门);未就绪时返回 undefined。 */
	getActiveStore?: () => FileReplaceStore | undefined;
	/** 原子存储工厂。 */
	createStorage?: IndexRuntimeStorageFactory;
	/** VectraStore 工厂。 */
	createStore?: IndexRuntimeStoreFactory;
	/** 首个持久提交登记活动代际后的回调(装配层借此同步内存指针并打日志)。 */
	onGenerationPromoted?: (generationId: string, record: GenerationControlRecord) => void;
	/**
	 * 可选:协调器日志端口的包装接缝(在首个提交登记器之前应用)。
	 *
	 * 关键路径:生产不传即恒等;崩溃/规模夹具用它把「提交返回」等阶段变成可观测点。
	 * 传入的端口必须原样转发 `prepare` / `commit` / `cleanup` / `readReceipt` 语义。
	 */
	wrapJournal?: (journal: IndexFileJournal) => CoordinatorJournalPort;
	/** 停滞看护阈值;缺省用 {@link INDEX_RUNTIME_STALL_AFTER_MS}。 */
	stallAfterMs?: number;
	/** 写运行时身份守卫;提供时同一会话内不同配置会被显式拒绝。 */
	identityGuard?: IndexRuntimeIdentityGuard;
}

/** 写路径管线装配结果 — 存储、日志、可见性视图、协调器与看护。 */
export interface AssembledIndexPipeline {
	store: VectraStore;
	journal: IndexFileJournal;
	readOnlySearchView: ReadOnlySearchView;
	processorPort: ChunkingCoordinatorProcessor;
	coordinator: IndexTaskCoordinator;
	stallWatchdog: IndexStallWatchdog;
}

/**
 * 写路径管线装配 — 存储、日志、可见性视图、协调器与停滞看护。
 *
 * 关键路径:
 * - 日志与协调器绑定**同一个**底层存储实例:提交写到旧实例、检索读新实例会让视图分叉;
 *   模型就绪后不再重建 store。
 * - 日志的存储视图是**延迟绑定**的:协调器必须在带访问门的存储上提交,
 *   而访问门由处理器在模型就绪后才建立 —— 这里用转发视图把两者接起来。
 * - 可见性视图与 `fileRecords` 端口**同批**注入:门在记录不可判定时失败关闭,
 *   缺端口会变成检索全量归零。
 *
 * @param deps - 装配依赖(全部由调用方注入)。
 * @returns 管线对象。
 */
export function assembleIndexPipeline(deps: AssembleIndexPipelineDeps): AssembledIndexPipeline {
	const createStorage = deps.createStorage ?? createIndexRuntimeStorage;
	const createStore = deps.createStore ?? createIndexRuntimeStore;
	const storage = createStorage(deps.indexDir);
	const store = createStore(deps.indexDir, { autoInit: true, storage });
	const journal = new IndexFileJournal({
		generationRoot: deps.indexDir,
		generationId: deps.generationId,
		configFingerprint: deps.configFingerprint,
		owner: deps.lease,
		store: createActiveFileStore(deps.getActiveStore ?? (() => undefined), () => store),
		storage,
		expectedDimension: deps.expectedDimension,
	});
	const isExcluded = deps.isExcluded ?? (() => false);
	const fileExists = deps.fileExists ?? (() => false);
	const readOnlySearchView = new ReadOnlySearchView({
		source: createJournalVisibilitySource(journal),
		configFingerprint: deps.configFingerprint,
		isExcluded: (p) => isExcluded(p),
		// 关键路径(A11):存在性核对只针对候选路径,不扫描全库。
		exists: (p) => fileExists(p),
	});
	const processorPort = new ChunkingCoordinatorProcessor({
		embedding: deps.embedding,
		getChunkOptions: deps.getChunkOptions,
	});
	// 关键路径:包装接缝在首个提交登记器**之前**应用 —— 登记器只装饰 `commit`,包装器的
	// 观测点因此能覆盖真实提交返回的整段(含日志清理)。
	const coordinatorJournal: CoordinatorJournalPort =
		deps.wrapJournal === undefined ? journal : deps.wrapJournal(journal);
	const coordinator = new IndexTaskCoordinator({
		vault: deps.vault,
		// 关键路径:首个持久提交成功即登记活动代际(spec §5),不等待全库完成。
		journal: createFirstCommitPromoter({
			journal: coordinatorJournal,
			generations: deps.generations,
			generationId: deps.generationId,
			onPromoted: (record) => deps.onGenerationPromoted?.(deps.generationId, record),
		}),
		processor: processorPort,
		getConfigFingerprint: () => deps.configFingerprint,
		isExcluded: (p) => isExcluded(p),
	});
	const stallWatchdog = new IndexStallWatchdog({
		source: createIndexStallSource(coordinator),
		stallAfterMs: deps.stallAfterMs ?? INDEX_RUNTIME_STALL_AFTER_MS,
		onStall: (info) => devLogger.warn('index', `索引停滞:无有效进展 ${info.idleMs}ms`, info),
		onResume: (info) => devLogger.info('index', `索引恢复:有效进展 ${info.progressMark}`),
	});
	return { store, journal, readOnlySearchView, processorPort, coordinator, stallWatchdog };
}

/** 写路径运行时整体装配依赖。 */
export interface SetupWritableIndexRuntimeDeps {
	/** 索引根 `.index/`(绝对路径)。 */
	indexRoot: string;
	/** 当前配置。 */
	config: IndexConfigDescriptor;
	/** 当前配置指纹(装配期算一次;日志与可见性门都用它)。 */
	configFingerprint: string;
	/** Vault 端口。 */
	vault: IndexRuntimeVaultPort;
	/** 嵌入端口(分块后推理)。 */
	embedding: EmbeddingPort;
	/** 捕获当前分块参数 — 与 Worker 侧 `buildChunkOptions` 同源。 */
	getChunkOptions: () => ChunkOptions;
	/** 分块参数(与旧清单交叉核对用)。 */
	chunkLimits: { chunkSize: number; chunkOverlap: number };
	/** 该路径当前是否被黑名单排除。 */
	isExcluded?: (path: string) => boolean;
	/** 候选存在性判定(只读可见性视图);支持异步(宿主 fileExists 是 async)。 */
	fileExists?: (path: string) => boolean | Promise<boolean>;
	/** 期望向量维度(日志维度断言与门共用)。 */
	expectedDimension: number;
	/** 读取当前处理器存储(带访问门);未就绪时返回 undefined。 */
	getActiveStore?: () => FileReplaceStore | undefined;
	/** 原子存储工厂(夹具注入可观测/故障注入实现)。 */
	createStorage?: IndexRuntimeStorageFactory;
	/** VectraStore 工厂(夹具注入可观测实现)。 */
	createStore?: IndexRuntimeStoreFactory;
	/** 首个持久提交登记活动代际后的回调(装配层借此同步内存指针并打日志)。 */
	onGenerationPromoted?: (generationId: string, record: GenerationControlRecord) => void;
	/** 可选:协调器日志端口的包装接缝(生产不传;夹具用于崩溃/观测)。 */
	wrapJournal?: (journal: IndexFileJournal) => CoordinatorJournalPort;
	/** 装配期迁移/回收结论的落点(宿主状态 store);不注入时只保留在返回值里。 */
	publishConclusion?: (summary: IndexConclusionDiagnostics) => void;
	/** 停滞看护阈值;缺省用 {@link INDEX_RUNTIME_STALL_AFTER_MS}。 */
	stallAfterMs?: number;
	/** 写运行时身份守卫;提供时同一会话内不同配置会被显式拒绝。 */
	identityGuard?: IndexRuntimeIdentityGuard;
}

/**
 * 隔离代际创建受阻的装配结论：保留活动身份，供宿主决定是否能显式接入旧配置搜索。
 *
 * 本错误不携带可写管线，也不承诺旧代际可用；宿主必须持有真实旧嵌入端口并按旧配置
 * 另行只读装配，不能将当前模型接到该活动目录。
 */
export class IndexRuntimeGenerationBlockedError extends Error {
	readonly code = 'all-generations-retained';
	readonly activeGenerationId: string | null;
	readonly activeConfigFingerprint: string | null;

	constructor(control: GenerationControlRecord) {
		super(control.activeGenerationId === null
			? '索引代际不可用:没有活动代际,且新建被已保留的代际阻断'
			: '索引代际不可用:当前配置的隔离代际新建被已保留的代际阻断,旧活动代际与当前配置不兼容');
		this.name = 'IndexRuntimeGenerationBlockedError';
		this.activeGenerationId = control.activeGenerationId;
		this.activeConfigFingerprint = control.activeGenerationId === null
			? null
			: control.generations[control.activeGenerationId]?.fingerprint ?? null;
	}
}

/** 写路径运行时装配结果。 */
export interface WritableIndexRuntime {
	/** 本实例解析出的代际目录。 */
	indexDir: string;
	/** 本实例解析出的代际 ID。 */
	generationId: string;
	/** 控制指针上的活动代际 ID(配置切换前仍是旧代际)。 */
	activeGenerationId: string | null;
	/** 本次是从旧索引迁移来的。 */
	migrated: boolean;
	/** 迁移/回收结论面。 */
	conclusion: IndexConclusionDiagnostics;
	/** 写所有权租约。 */
	lease: IndexWriteOwner;
	/** 代际管理实例。 */
	generations: IndexGenerations;
	/** 装配好的管线。 */
	pipeline: AssembledIndexPipeline;
	/** 释放身份登记;宿主卸载时调用。未启用守卫时为 undefined。 */
	releaseIdentity?: () => void;
}

/**
 * 写路径装配 — 取写所有权、解析代际、装配管线并恢复未决事务。
 *
 * 关键路径(T6 §8.1):
 * - `.index/` 根只放 `control.json`、`owner.lock` 与 `generations/`;
 *   注入给 `VectraStore` / `AtomicIndexStorage` / 日志的目录**必须是代际目录**,
 *   否则一次全量重建会递归删除控制指针、owner 锁与全部代际;
 * - 旧索引在 owner 锁内迁移;身份不可确认时走显式重建入口,绝不静默复用旧块;
 * - 任何失败都原样抛出,由调用方决定降级(T7/I2 的降级出口在 `main.ts`)。
 *
 * @param deps - 装配依赖(全部由调用方注入)。
 * @returns 写路径运行时对象。
 * @throws {Error} 取锁失败、解析失败或无可用代际。
 */
export async function setupWritableIndexRuntime(
	deps: SetupWritableIndexRuntimeDeps,
): Promise<WritableIndexRuntime> {
	// 关键路径:身份判定必须在取写所有权之前 —— 配置冲突要立刻返回配置语义的错误,
	// 而不是先等前任释放、最后报一个只有占用语义的失败。
	const guard = deps.identityGuard;
	guard?.register(deps.configFingerprint);
	let lease: IndexWriteOwner;
	try {
		// 关键路径:必须走门面 `IndexWriteOwner.acquire` —— 它同时取得 renderer 内 epoch 租约与
		// 索引根的跨进程 `owner.lock`;只取租约不会建锁文件,跨进程互斥就不存在。
		lease = await IndexWriteOwner.acquire({
			root: deps.indexRoot,
			instanceToken: randomUUID(),
		} satisfies IndexWriteOwnerOptions);
	} catch (err) {
		// 关键路径:坏锁/空锁/外机锁按 spec 保守拒绝且不自动回收;这里如实抛出,
		// 由降级状态呈现「占用/暂不可写」,不做重试循环(T2 §5.3)。
		devLogger.error('index', '获取索引写所有权失败(可能被其他实例占用)', err);
		throw err;
	}
	const generations = new IndexGenerations({ indexRoot: deps.indexRoot, owner: lease });
	try {
		const runtime = await finishWritableRuntime(deps, lease, generations);
		if (guard !== undefined) {
			runtime.releaseIdentity = () => guard.release(deps.configFingerprint);
		}
		return runtime;
	} catch (err) {
		// 关键路径:装配失败必须释放已取得的写所有权,否则 owner.lock 会留给下一个实例 ——
		// 迁移前的 `main.ts` 由降级出口释放;算法下沉后由本函数自己兜底(结果对象不会产出,
		// 调用方也就拿不到租约),保证「失败即不占锁」的语义不变。
		await lease.release().catch((releaseError) => {
			devLogger.warn('index', '装配失败后释放索引写所有权失败', releaseError);
		});
		// 失败路径同样要释放身份登记,否则下一次重试会被自己的登记挡住。
		guard?.release(deps.configFingerprint);
		throw err;
	}
}

/**
 * 写路径装配主体 — 解析代际、装配管线并恢复未决事务(失败由调用方释放租约)。
 *
 * @param deps - 装配依赖。
 * @param lease - 已取得的写所有权租约。
 * @param generations - 已绑定租约的代际管理实例。
 * @returns 写路径运行时对象。
 */
async function finishWritableRuntime(
	deps: SetupWritableIndexRuntimeDeps,
	lease: IndexWriteOwner,
	generations: IndexGenerations,
): Promise<WritableIndexRuntime> {
	const createStorage = deps.createStorage ?? createIndexRuntimeStorage;
	const resolution = await resolveIndexGeneration({
		generations,
		indexRoot: deps.indexRoot,
		config: deps.config,
		owner: lease,
		allowCreate: true,
		legacy: await describeLegacyIndex({ indexRoot: deps.indexRoot, vault: deps.vault, createStorage }),
		chunkLimits: deps.chunkLimits,
		expectedDimension: deps.expectedDimension,
	});
	if (!resolution.resolved) {
		// 关键路径:新建被已保留的代际阻断(回收上限)。这是「索引暂不可用」而不是「插件坏了」,
		// 因此按降级处理,并把回收决策面(孤儿目录/取证事务/阻断原因)带进诊断落点。
		const blockedConclusion = summarizeIndexConclusion(resolution);
		deps.publishConclusion?.(blockedConclusion);
		// 关键路径(配置变化路径):阻断时控制指针可能仍指向一个可用的旧活动代际,只是它与
		// 当前配置不兼容。降级不装配任何代际,因此错误文案必须如实区分这两种阻断,
		// 不能一律说成「没有活动代际」。
		// 修复：受阻是当前配置不可写，不代表旧活动数据已丢失；保留身份供宿主显式接线。
		throw new IndexRuntimeGenerationBlockedError(resolution.control);
	}
	const indexDir = resolution.resolved.generationRoot;
	const generationId = resolution.resolved.generationId;
	// 关键路径(T7 修复):内存里的「活动代际」跟随**控制指针**,而不是「本次解析是否印证了它」。
	// 配置变化时本实例解析出的是隔离的 building 代际,而控制指针上的活动代际仍是旧的 ——
	// 旧代际在切换完成前依然是正在使用的索引,清库守卫必须继续拒绝它。
	const activeGenerationId = resolution.control.activeGenerationId;
	devLogger.info('index', `索引代际目录已解析:${indexDir}(活动代际=${String(resolution.resolved.active)})`);
	let migrated = false;
	if (resolution.migration) {
		devLogger.info('index', `旧索引迁移结论:phase=${resolution.migration.phase},published=${String(resolution.migration.published)},statePersisted=${String(resolution.migration.statePersisted)}`);
		// 关键路径:迁移事实进入状态展示(迁移中/迁移后逐文件核对),不静默。
		migrated = true;
	}
	// 关键路径(T7/I4):迁移/回收结论面进诊断落点 —— 不要求上屏,但必须可查看。
	const conclusion = summarizeIndexConclusion(resolution);
	deps.publishConclusion?.(conclusion);

	// 关键路径:非活动代际在核对前先降级为「核对中」,并把 `verifiedAt` 清空 ——
	// 「曾活动」不等于「本轮已核对」,登记活动指针必须等本轮核对完成(T6 §8.5)。
	if (!resolution.resolved.active && resolution.resolved.status === 'migrated') {
		await generations.beginVerification({ generationId });
	}

	const pipeline = assembleIndexPipeline({
		indexDir,
		generationId,
		configFingerprint: deps.configFingerprint,
		lease,
		generations,
		vault: deps.vault,
		embedding: deps.embedding,
		getChunkOptions: deps.getChunkOptions,
		expectedDimension: deps.config.embeddingDimension,
		...(deps.isExcluded === undefined ? {} : { isExcluded: deps.isExcluded }),
		...(deps.fileExists === undefined ? {} : { fileExists: deps.fileExists }),
		...(deps.getActiveStore === undefined ? {} : { getActiveStore: deps.getActiveStore }),
		...(deps.createStorage === undefined ? {} : { createStorage: deps.createStorage }),
		...(deps.createStore === undefined ? {} : { createStore: deps.createStore }),
		...(deps.onGenerationPromoted === undefined ? {} : { onGenerationPromoted: deps.onGenerationPromoted }),
		...(deps.wrapJournal === undefined ? {} : { wrapJournal: deps.wrapJournal }),
		...(deps.stallAfterMs === undefined ? {} : { stallAfterMs: deps.stallAfterMs }),
	});
	await recoverIndexJournal({ journal: pipeline.journal, vault: deps.vault });
	return {
		indexDir,
		generationId,
		activeGenerationId,
		migrated,
		conclusion,
		lease,
		generations,
		pipeline,
	};
}

// ==================== 只读装配 ====================

/** 只读装配依赖。 */
export interface SetupReadOnlyIndexRuntimeDeps {
	/** 索引根 `.index/`(绝对路径)。 */
	indexRoot: string;
	/** 当前配置。 */
	config: IndexConfigDescriptor;
	/** 当前配置指纹。 */
	configFingerprint: string;
	/** Vault 端口。 */
	vault: IndexRuntimeVaultPort;
	/** 候选存在性判定(A11 的存在性核对);缺省视为不存在;支持异步。 */
	fileExists?: (path: string) => boolean | Promise<boolean>;
	/** 该路径当前是否被黑名单排除。 */
	isExcluded?: (path: string) => boolean;
	/** 原子存储工厂。 */
	createStorage?: IndexRuntimeStorageFactory;
	/** VectraStore 工厂。 */
	createStore?: IndexRuntimeStoreFactory;
}

/** 只读装配结果。 */
export interface ReadOnlyIndexRuntime {
	/** 只读装配后指向的目录。 */
	indexDir: string;
	/** 索引目录是否与请求配置兼容；false 时模型就绪也不初始化 Worker 存储。 */
	indexDirUsable: boolean;
	/** 不可用的明确原因；省略表示装配成功。 */
	unavailableReason?: 'control-invalid' | 'no-active-generation' | 'config-mismatch';
	/** 活动代际 ID;无活动代际时为 null。 */
	activeGenerationId: string | null;
	/** 代际管理实例(只读哨兵 owner)。 */
	generations: IndexGenerations;
	/** 只读日志;无活动代际或不落盘时为 undefined。 */
	journal?: IndexFileJournal;
	/** 只读可见性视图;无活动代际时为 undefined。 */
	readOnlySearchView?: ReadOnlySearchView;
	/** 只读存储;无活动代际时为 undefined。 */
	store?: VectraStore;
}

/**
 * 只读装配(`autoIndex=false`)— 零写入契约。
 *
 * 关键路径(A11):不取 owner 锁(不建 `owner.lock`)、不迁移、不新建代际。
 * 用只读哨兵构造日志与可见性视图:有活动代际时读它的可信记录,没有时记录集为空 ——
 * 「没有可信记录则不可检索」,而不是伪造一个合法空索引。
 *
 * @param deps - 装配依赖(全部由调用方注入)。
 * @returns 只读运行时对象。
 */
export async function setupReadOnlyIndexRuntime(
	deps: SetupReadOnlyIndexRuntimeDeps,
): Promise<ReadOnlyIndexRuntime> {
	const createStorage = deps.createStorage ?? createIndexRuntimeStorage;
	const createStore = deps.createStore ?? createIndexRuntimeStore;
	const owner = createReadOnlyOwnerGuard();
	const generations = new IndexGenerations({ indexRoot: deps.indexRoot, owner });
	let resolution: ResolveIndexGenerationResult;
	try {
		// 修复：只读入口也必须经过配置身份解析，不能仅凭控制指针存在就初始化当前模型的存储。
		resolution = await resolveIndexGeneration({
			generations,
			indexRoot: deps.indexRoot,
			config: deps.config,
			owner,
			allowCreate: false,
		});
	} catch (err) {
		devLogger.warn('index', '只读装配解析活动代际失败,检索按不可判定处理', err);
		return {
			indexDir: deps.indexRoot, indexDirUsable: false, activeGenerationId: null,
			unavailableReason: 'control-invalid', generations,
		};
	}
	const control = resolution.control;
	// 关键路径:没有活动代际时把索引目录指向代际聚合目录 —— 只读日志在缺失目录上
	// 返回空记录集(失败关闭);`indexDirUsable` 保持 false,模型就绪后不初始化 worker 存储。
	if (control.activeGenerationId === null) {
		devLogger.info('index', '只读装配:尚无活动代际,检索按不可判定处理');
		return {
			indexDir: path.join(deps.indexRoot, 'generations'),
			indexDirUsable: false,
			activeGenerationId: null,
			unavailableReason: 'no-active-generation',
			generations,
		};
	}
	// 关键路径：配置描述、调用方指纹和活动记录三者必须一致，才允许创建可查询视图。
	// 即使模型同名或维度相同，修订、文本模板与分块身份不同也不能查询旧向量空间。
	if (resolution.resolved === null || resolution.resolved.configFingerprint !== deps.configFingerprint) {
		devLogger.warn('index', '只读装配:活动代际与请求配置不兼容,保留旧数据并关闭检索');
		return {
			indexDir: generations.generationRootOf(control.activeGenerationId),
			indexDirUsable: false,
			activeGenerationId: control.activeGenerationId,
			unavailableReason: 'config-mismatch',
			generations,
		};
	}
	const active = control.activeGenerationId;
	const indexDir = generations.generationRootOf(active);
	const storage = createStorage(indexDir);
	// 关键路径:只读装配不得初始化存储(autoInit:false 才不落盘)。
	const store = createStore(indexDir, { autoInit: false, storage });
	const journal = new IndexFileJournal({
		generationRoot: indexDir,
		generationId: active,
		configFingerprint: deps.configFingerprint,
		owner,
		store,
		storage,
		expectedDimension: deps.config.embeddingDimension,
	});
	const isExcluded = deps.isExcluded ?? (() => false);
	const fileExists = deps.fileExists ?? (() => false);
	const readOnlySearchView = new ReadOnlySearchView({
		source: createJournalVisibilitySource(journal),
		configFingerprint: deps.configFingerprint,
		isExcluded: (p) => isExcluded(p),
		// 关键路径(A11):每次检索只核验候选文件的存在性,不扫描全库;缺失候选被过滤。
		exists: (p) => fileExists(p),
	});
	return {
		indexDir,
		indexDirUsable: true,
		activeGenerationId: active,
		generations,
		journal,
		readOnlySearchView,
		store,
	};
}

// ==================== 检索候选可见性门 ====================

/** 检索候选可见性门依赖 — 全部以闭包读取,装配后仍随宿主状态变化。 */
export interface SearchCandidateGateDeps {
	/** 当前是否关闭自动索引(只读通道)。 */
	isReadOnly: () => boolean;
	/** 只读模式下已知发生变更的路径集合。 */
	readOnlyChanged: () => ReadonlySet<string>;
	/** 只读可见性视图。 */
	getReadOnlySearchView: () => ReadOnlySearchView | undefined;
	/** 写路径日志。 */
	getJournal: () => IndexFileJournal | undefined;
	/** 任务协调器。 */
	getCoordinator: () => IndexTaskCoordinator | undefined;
	/** 当前配置指纹。 */
	getConfigFingerprint: () => string;
	/** 该路径当前是否被黑名单排除。 */
	isExcluded: (path: string) => boolean;
	/** 候选存在性判定;支持异步(宿主 fileExists 是 async)。 */
	fileExists?: (path: string) => boolean | Promise<boolean>;
}

/**
 * 检索候选可见性门 — 原始向量候选进入融合/重排前的唯一闸门(T7/A11)。
 *
 * 关键路径:
 * - **写路径装配**:`SearchVisibilityGate` + 文件日志只读来源 + 协调器的运行期新鲜度与
 *   未决事务集合;未在本轮核对的候选按 `admit-trusted` 准入(可信完成记录本身是准入依据),
 *   已知过期(`known-stale`)、删除、排除、隔离、配置不符与未决事务一律拒绝。
 * - **关闭自动索引**:`ReadOnlySearchView` + `readOnlyChanged()`;内存变更集按
 *   `known-stale` 处理(不是 `unresolved-transaction`),新鲜度一律 `unknown`。
 * - **没有可信记录**(`autoIndex=false` 且无活动代际)时一律拒绝 —— 不把 `null` 当空集。
 * - 每次检索 `refresh()` 重读判定依据;`exists` 只核验候选文件,不扫描全库、不嵌入、不写盘。
 *
 * @param deps - 判定依据(闭包读取)。
 * @returns 与 `MultiQuerySearcher` 契约一致的门。
 */
export function createSearchCandidateGate(deps: SearchCandidateGateDeps): SearchCandidateGate {
	let readOnly = false;
	let changed: ReadonlySet<string> = new Set<string>();
	let view: ReadOnlySearchView | undefined;
	let gate: SearchVisibilityGate | undefined;

	const decide = async (candidatePath: string): Promise<SearchCandidateVerdict> => {
		if (readOnly) {
			if (changed.has(candidatePath)) {
				// 关键路径:关闭自动索引时的内存变更集 = 「磁盘内容已与已提交版本不同」,
				// 语义是 known-stale;按 unresolved-transaction 处理会把普通编辑误报成未结算事务。
				return { visible: false, path: candidatePath, reason: 'known-stale', freshness: 'known-stale' };
			}
			if (view === undefined) {
				return { visible: false, path: candidatePath, reason: 'unjudgeable', freshness: 'unknown' };
			}
			return view.decide(candidatePath);
		}
		if (gate === undefined) {
			return { visible: false, path: candidatePath, reason: 'unjudgeable', freshness: 'unknown' };
		}
		return gate.decide(candidatePath);
	};

	return {
		refresh: async () => {
			readOnly = deps.isReadOnly();
			changed = deps.readOnlyChanged();
			if (readOnly) {
				view = deps.getReadOnlySearchView();
				gate = undefined;
				// 关键路径:只读视图只读可信完成记录并保持新鲜度 unknown;变更集只用于 known-stale。
				await view?.refresh(changed);
				return;
			}
			view = undefined;
			const journal = deps.getJournal();
			if (journal === undefined) {
				gate = undefined;
				return;
			}
			const coordinator = deps.getCoordinator();
			const configFingerprint = deps.getConfigFingerprint();
			const snapshot = await captureSearchVisibilitySnapshot({
				source: createJournalVisibilitySource(journal),
				configFingerprint,
				...(coordinator === undefined ? {} : { unresolvedPaths: coordinator.unresolvedPaths() }),
			});
			const fileExists = deps.fileExists ?? (() => false);
			gate = new SearchVisibilityGate({
				snapshot,
				// 关键路径:未在本轮核对的候选按可信完成记录准入;本轮已标记 known-stale 的仍会被拒。
				unverified: 'admit-trusted',
				configFingerprint,
				isExcluded: (path) => deps.isExcluded(path),
				exists: (path) => fileExists(path),
				...(coordinator === undefined ? {} : { freshnessOf: (path) => coordinator.freshnessOf(path) }),
			});
		},
		decide,
		recordsKind: () => {
			if (readOnly) return view?.recordsKind() ?? 'unjudgeable';
			// 写路径下门已从日志读出行集,不可判定时同样按 unjudgeable 上报。
			return gate?.snapshot().recordsKind ?? 'unjudgeable';
		},
	};
}

// ==================== 代际登记 ====================

/** 活动代际登记依赖 — 以闭包读取宿主状态,登记结果写回同一处。 */
export interface GenerationActivationPublisherDeps {
	getGenerations: () => IndexGenerations | undefined;
	getLease: () => IndexWriteOwner | undefined;
	getActiveGenerationId: () => string | null;
	setActiveGenerationId: (generationId: string) => void;
}

/**
 * 把本实例的代际登记为活动代际 — 无活动代际走 `upgrade`,配置切换走 `configured-switch`。
 *
 * 关键路径(T7 修复):只要本实例解析出的代际**还不是**控制指针上的活动代际,就必须等本轮
 * 核对完成后才切换;未 ready 前旧活动索引保持可用,绝不提前切换。重复登记由内部闩锁拒绝。
 */
export class GenerationActivationPublisher {
	private publishing = false;
	private readonly deps: GenerationActivationPublisherDeps;

	constructor(deps: GenerationActivationPublisherDeps) {
		this.deps = deps;
	}

	/**
	 * 登记目标代际为活动代际。
	 *
	 * @param generationId - 目标代际 ID。
	 */
	async publish(generationId: string): Promise<void> {
		const generations = this.deps.getGenerations();
		const lease = this.deps.getLease();
		if (!generations || !lease || this.publishing || this.deps.getActiveGenerationId() === generationId) return;
		this.publishing = true;
		try {
			lease.assertWritable();
			const control = await generations.readControl();
			if (control.activeGenerationId === generationId) {
				this.deps.setActiveGenerationId(generationId);
				return;
			}
			await generations.markGenerationMigrated({ generationId });
			await generations.publishActiveGeneration({
				generationId,
				mode: control.activeGenerationId === null ? 'upgrade' : 'configured-switch',
			});
			this.deps.setActiveGenerationId(generationId);
			devLogger.info('index', `代际 ${generationId} 已登记为活动代际(本轮核对完成)`);
		} catch (err) {
			devLogger.warn('index', '登记活动代际失败,保留当前活动索引', err);
		} finally {
			this.publishing = false;
		}
	}
}

// ==================== 活动消息 ====================

/**
 * 取消在途索引任务所需的 Worker 端口 — 只声明取消入口,避免装配层依赖完整 WorkerManager。
 */
export interface IndexCancelTarget {
	cancelIndex(options?: { epoch?: number }): void;
}

/**
 * 取消在途索引任务 — 复用既有控制入口的取消路径。
 *
 * 关键路径(T5 接线):先撤销在途可取消的调用(协调器 + Worker 侧取消),再停止调度新文件。
 * 写保护保留到真实终态;不终止共享 Worker,其他查询继续可用。
 *
 * @param options.worker - Worker 取消入口;未装配时为 undefined。
 * @param options.coordinator - 任务协调器。
 * @param options.epoch - 写所有权 epoch;无租约时不传(取消不按 epoch 过滤)。
 */
export function cancelIndexRun(options: {
	worker?: IndexCancelTarget;
	coordinator?: IndexTaskCoordinator;
	epoch?: number;
}): void {
	const epoch = options.epoch;
	try {
		options.worker?.cancelIndex(epoch === undefined ? {} : { epoch });
	} catch (err) {
		devLogger.warn('index', '取消在途索引请求失败', err);
	}
	options.coordinator?.abortActive();
}