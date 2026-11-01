/**
 * @file src/core/index-processor-port.ts
 * @description 宿主装配的生产接缝 — 协调器处理器端口、首个提交登记活动代际、严格归属断言与代际目录解析
 * @module core/index-processor-port
 * @depends worker/chunker, ports/embedding, core/index-task-coordinator, core/index-file-journal, core/index-generations
 *
 * 设计要点:
 * - 本文件只承载「装配层才有的知识」,不放数据库或检索逻辑:
 *   1) {@link ChunkingCoordinatorProcessor} 把「内容 → 完整块集合」接到 T4 协调器端口上,
 *      复用既有分块器与嵌入端口,不自行实现分块或推理;
 *   2) {@link createFirstCommitPromoter} 在首个**持久提交成功**后登记活动代际(spec §5 的
 *      upgrade 登记),不等待全库完成,因此部分检索可用;
 *   3) {@link createStrictDropOwnershipAssertion} 把 T6 的「形状白名单」收紧为
 *      「必须是本索引根 `generations/` 下的代际目录」;
 *   4) {@link resolveIndexGeneration} 解析启动期目录:活动代际**配置指纹一致**才复用;
 *      指纹不一致时新建隔离代际(旧代际保留、活动指针不动,由装配层在本轮核对完成后
 *      走 `configured-switch` 切换);无活动代际时按 legacy 索引迁移,无 legacy 时新建
 *      `building` 代际。
 * - 本文件**不**构造 `VectraStore`:生产构造点仍集中在 `main.ts` 与 `worker/handler.ts`,
 *   由源码守卫锁定「每处都注入原子存储」。代际目录与 legacy 只读来源都由调用方传入。
 * - 目录归属与「哪里能写」由 `IndexGenerations` 持有;这里只做判定与转发,不自行拼盘删除路径。
 */

import path from 'node:path';
import { devLogger } from '../logging/dev-logger';
import { chunkMarkdown, type ChunkOptions } from '../worker/chunker';
import type { EmbeddingPort } from '../ports/embedding';
import { IndexDirectoryNotOwnedError } from './persistent-index-backend';
import {
	GenerationMigrationEngine,
	INDEX_GENERATIONS_DIRNAME,
	deriveGenerationId,
	isGenerationId,
	type GenerationControlRecord,
	type GenerationLegacyBlockStore,
	type GenerationMigrationResult,
	type GenerationReconcileDecision,
	type GenerationReconcileProbeResult,
	type GenerationRecord,
	type IndexGenerations,
} from './index-generations';
import type {
	CoordinatorBlock,
	CoordinatorCommitResult,
	CoordinatorJournalPort,
	CoordinatorPrepareInput,
	CoordinatorProcessorPort,
} from './index-task-coordinator';
import type { EmbedOptions, FileCommit, IndexConfigDescriptor } from './index-persistence-types';
import { computeConfigFingerprint } from './index-persistence-types';
import type { JournalWriteOwner } from './index-file-journal';

// ==================== 协调器处理器端口 ====================

/** 处理器端口的装配依赖 — 分块参数每次读取(用户改设置后无需重建端口)。 */
export interface CoordinatorProcessorDeps {
	/** 批量嵌入端口。 */
	embedding: EmbeddingPort;
	/** 读取当前分块参数 — 与 Worker 侧 `buildChunkOptions` 同源。 */
	getChunkOptions: () => ChunkOptions;
}

/**
 * 生产 `CoordinatorProcessorPort` 实现 — 分块 + 推理,产出完整块集合。
 *
 * 关键路径:
 * - 只做「内容 → 块」,不读盘、不写盘、不提交:提交由协调器经 T3 日志在 owner 锁内完成;
 * - `options`(取消信号与批次活动回调)**整包转发**给嵌入端口,不吞掉取消与活动上报 ——
 *   否则 T5 的停滞看护与取消在生产等于零收益;
 * - 空内容返回空数组(零块),由日志落成 `present` 的零块完成记录,不在这里做删除决策。
 */
export class ChunkingCoordinatorProcessor implements CoordinatorProcessorPort {
	constructor(private readonly deps: CoordinatorProcessorDeps) {}

	/**
	 * 切块并嵌入一份内容。
	 *
	 * @param input - 路径与内容。
	 * @param options - 取消信号与批次活动回调;原样转发给嵌入端口。
	 * @returns 完整新块集合;空内容为空数组。
	 * @throws {Error} 取消已生效,或嵌入端口返回的向量数与块数不一致。
	 */
	async prepareBlocks(
		input: { path: string; content: string },
		options?: EmbedOptions,
	): Promise<readonly CoordinatorBlock[]> {
		if (options?.signal?.aborted === true) throw new Error('索引任务已取消,未开始分块与嵌入');
		const chunks = chunkMarkdown(input.content, this.deps.getChunkOptions());
		if (chunks.length === 0) return [];
		// 关键路径:第二参必须转发 —— 取消信号与批次活动都靠它跨到嵌入适配器。
		const vectors = await this.deps.embedding.embed(chunks.map((chunk) => chunk.embedText), options);
		if (vectors.length !== chunks.length) {
			throw new Error(`嵌入端口返回 ${vectors.length} 个向量,与块数 ${chunks.length} 不一致:${input.path}`);
		}
		return chunks.map((chunk, index): CoordinatorBlock => {
			const vector = vectors[index];
			if (vector === undefined) throw new Error(`缺少第 ${index} 块的向量:${input.path}`);
			return {
				id: `${input.path}#chunk-${index}`,
				vector,
				metadata: {
					path: input.path,
					chunkIndex: index,
					startOffset: chunk.startOffset,
					prefix: chunk.prefix,
					headingPath: chunk.headingPath,
				},
			};
		});
	}
}

// ==================== 首个提交登记活动代际 ====================

/** 首个提交登记器依赖。 */
export interface FirstCommitPromoterDeps {
	/** 真实日志端口 — 本模块只装饰 `commit`,其余方法原样转发。 */
	journal: CoordinatorJournalPort;
	/** 代际管理实例(写入口自会校验 owner)。 */
	generations: IndexGenerations;
	/** 本代际 ID。 */
	generationId: string;
	/** 登记成功后的观测回调(诊断/测试用;抛错不影响提交结果)。 */
	onPromoted?: (record: GenerationControlRecord) => void;
}

/**
 * 装饰 T4 协调器的日志端口:首个**持久提交成功**后登记活动代际(spec §5)。
 *
 * 关键路径:
 * - 只在「尚无活动代际」时登记,模式固定为 `upgrade`(首次建库专用)。已有活动代际时的
 *   配置切换由装配层在**全部核对完成后**走 `configured-switch`,与这里严格分开;
 * - 登记只发生在 `commit` 真实返回之后,且 `superseded`(日志已被后继版本取代)不计入;
 * - 登记失败**不改变提交结果**:本文件的职责是让首个已完成文件立即可检索,而不是让
 *   控制指针写失败把已落盘的向量回滚(提交已经完成,回滚不存在)。
 *
 * @param deps - 日志、代际实例与代际 ID。
 * @returns 结构上满足 `CoordinatorJournalPort` 的端口,可选项只在被装饰方存在时才转发。
 */
export function createFirstCommitPromoter(deps: FirstCommitPromoterDeps): CoordinatorJournalPort {
	const journal = deps.journal;
	/**
	 * 一次性闩锁 — 一旦观察到「活动代际已存在」就永不再读控制指针。
	 *
	 * 关键路径(代码质量审查 I4 / T8 首次构建耗时):`promote` 原本每次成功提交都读整份
	 * `control.json`,全量建库 N 篇即 N 次多余磁盘读 + JSON 解析。首个持久提交登记成功后
	 * 活动指针必然非空,后续提交不可能再改变登记结论,因此第一次读到非空即闩死。
	 * 只有「读/写抛错」这种**没有结论**的情况不闩死,留给下一次提交重试。
	 */
	let promotionSettled = false;
	const port: CoordinatorJournalPort = {
		prepare: (input: CoordinatorPrepareInput) => journal.prepare(input),
		commit: async (transactionId: string): Promise<CoordinatorCommitResult> => {
			const result = await journal.commit(transactionId);
			if (!result.superseded) await promote();
			return result;
		},
		cleanup: (transactionId: string) => journal.cleanup(transactionId),
		readReceipt: (p: string): Promise<FileCommit | null> => journal.readReceipt(p),
	};
	// 关键路径:可选成员只在被装饰方真的实现时才出现 —— 无条件补成 `[]` 会把「未实现该核对」
	// 悄悄变成「核对结果为无记录」,协调器口径随之改变。
	if (journal.listReceipts !== undefined) port.listReceipts = () => journal.listReceipts!();
	if (journal.listPathStates !== undefined) port.listPathStates = () => journal.listPathStates!();
	if (journal.isGenerationQuarantined !== undefined) {
		port.isGenerationQuarantined = () => journal.isGenerationQuarantined!();
	}
	if (journal.listTombstones !== undefined) port.listTombstones = () => journal.listTombstones!();
	return port;

	/**
	 * 尚无活动代际时把它登记为活动代际;失败只记录,不影响已经完成的提交。
	 *
	 * 关键路径:已经有活动代际(本实例的或配置切换前的)时本实例**永不** promote,并立即闩死;
	 * 提交失败/读控制指针失败时保持未闩死,下一次提交可以重试。
	 */
	async function promote(): Promise<void> {
		if (promotionSettled) return;
		try {
			const control = await deps.generations.readControl();
			if (control.activeGenerationId !== null) {
				// 关键路径:活动指针已非空 —— 无论它是不是本代际,登记结论都不会再变,闩死。
				promotionSettled = true;
				return;
			}
			const updated = await deps.generations.publishActiveGeneration({
				generationId: deps.generationId,
				mode: 'upgrade',
			});
			promotionSettled = true;
			deps.onPromoted?.(updated);
			devLogger.info('index', `首个文件持久提交完成,登记活动代际 ${deps.generationId}`);
		}
		catch (error) {
			devLogger.warn('index', '首个提交后登记活动代际失败(提交结果不受影响)', error);
		}
	}
}

// ==================== 严格归属断言 ====================

/** 严格归属断言的装配选项。 */
export interface StrictDropOwnershipOptions {
	/** `.index/` 根绝对路径。 */
	indexRoot: string;
	/**
	 * 活动代际判定 — 活动代际目录**永远**不可作为递归删除目标。
	 *
	 * 关键路径(T7 数据风险收口):形状与归属都合法的 `generations/<id>` 仍可能是**当前正在
	 * 使用的活动代际**;清库/重建的降级路径(`smartReindex` 的清单不兼容分支、未注入协调器时的
	 * `dropIndex`)一旦打到它,会连带删掉向量、`files/` 完成记录、清单与构建戳,而控制指针仍
	 * 指向该目录。这里把「活动」也纳入拒绝条件,与 `dropSafeGeneration` 的控制指针校验形成纵深。
	 */
	isActiveGeneration?: (generationId: string) => boolean;
}

/**
 * 构造严格版 `assertDropOwnership` — 只允许删除「本索引根 `generations/` 下的非活动代际目录」。
 *
 * 关键路径(T6 §8.2):缺省判定只到「形状白名单」,`.index/` 根、`generations/` 聚合目录
 * 与 pluginDir 形状的非空目录都会被拒,但任何「看起来像索引目录」的普通目录仍可被递归删除。
 * 装配代际目录后必须收紧为**代际白名单**:
 * 1. 目标不是 `.index/` 根,也不是 `generations/` 聚合目录;
 * 2. 父目录必须是本索引根的 `generations/`(不承认任何外部同名目录);
 * 3. 目录名必须匹配 `gen-[0-9a-f]{16}`;
 * 4. 注入 `isActiveGeneration` 时,当前活动代际目录同样拒绝 —— 形状合法不等于可删。
 *
 * 断言是**纯判定**:抛出前不删除任何文件,调用方(后端/存储)据此拒绝清库。
 *
 * @param options - 索引根与可选的活动代际判定。
 * @returns 断言函数;不通过时抛 {@link IndexDirectoryNotOwnedError}。
 */
export function createStrictDropOwnershipAssertion(options: StrictDropOwnershipOptions): (indexDir: string) => void {
	const indexRoot = path.resolve(options.indexRoot);
	const generationsRoot = path.join(indexRoot, INDEX_GENERATIONS_DIRNAME);
	return (indexDir: string): void => {
		const resolved = path.resolve(indexDir);
		if (resolved === indexRoot) {
			throw new IndexDirectoryNotOwnedError(resolved, '目标是 .index 索引根,只允许删除 generations/ 下的代际目录');
		}
		if (resolved === generationsRoot) {
			throw new IndexDirectoryNotOwnedError(resolved, '目标是代际聚合目录 generations/,不允许递归删除');
		}
		if (path.dirname(resolved) !== generationsRoot) {
			throw new IndexDirectoryNotOwnedError(resolved, `目标不在本索引根的 generations/ 下:${generationsRoot}`);
		}
		if (!isGenerationId(path.basename(resolved))) {
			throw new IndexDirectoryNotOwnedError(resolved, '目标目录名不是合法代际 ID(gen-<16 位小写十六进制>)');
		}
		if (options.isActiveGeneration?.(path.basename(resolved)) === true) {
			throw new IndexDirectoryNotOwnedError(resolved, '目标是当前活动代际目录,拒绝递归删除正在使用的索引');
		}
	};
}

// ==================== 代际目录解析 ====================

/** legacy 索引来源 — 只读枚举面由调用方(装配层)构造,本模块不构造存储。 */
export interface IndexGenerationLegacySource {
	/** 旧 Vectra 数据目录(旧版 `.index/` 根)。 */
	indexDir: string;
	/** 旧清单文件绝对路径。 */
	manifestPath: string;
	/** 旧索引的只读块枚举入口。 */
	store: GenerationLegacyBlockStore;
	/** 当前内容 hash 视图;缺失的路径按不复用处理。 */
	currentInputs: ReadonlyMap<string, string | null>;
}

/** 解析结果中的代际身份 — 调用方据此构造 `VectraStore` / `AtomicIndexStorage` / 日志。 */
export interface ResolvedIndexGeneration {
	/** 代际 ID(目录身份)。 */
	generationId: string;
	/** 代际数据目录绝对路径。 */
	generationRoot: string;
	/** 配置指纹。 */
	configFingerprint: string;
	/** 当前状态。 */
	status: GenerationRecord['status'];
	/** 是否已是活动代际(未活动时为 `building`,等首个持久提交后登记)。 */
	active: boolean;
}

/** 解析选项。 */
export interface ResolveIndexGenerationOptions {
	/** 代际管理实例(已绑定 owner)。 */
	generations: IndexGenerations;
	/** `.index/` 根绝对路径。 */
	indexRoot: string;
	/** 当前生效配置。 */
	config: IndexConfigDescriptor;
	/** 写所有权门面 — 迁移与新建都在 owner 锁内。 */
	owner: JournalWriteOwner;
	/** 是否允许创建/迁移。只读装配(`autoIndex=false`)必须传 false:零写入。 */
	allowCreate: boolean;
	/** legacy 只读来源;无旧索引时传 null。 */
	legacy?: IndexGenerationLegacySource | null;
	/** 分块参数,用于与旧清单声明交叉核对。 */
	chunkLimits?: { chunkSize: number; chunkOverlap: number };
	/** 期望向量维度。 */
	expectedDimension?: number;
}

/**
 * 新建前的回收结论面 — 决策 + 取证事务汇总。
 *
 * 关键路径:`GenerationReconcileDecision` 自身不携带逐代际探测明细(取证事务数在
 * {@link GenerationReconcileProbeResult} 里),而「保留了多少取证事务」正是诊断必须可查的
 * 事实之一(代码质量审查 I4),因此在装配层出口处汇总一次,不让调用方重跑探测。
 */
export interface IndexReconcileOutcome {
	/** 回收决策。 */
	decision: GenerationReconcileDecision;
	/** 被保留代际中保留的取证事务目录总数。 */
	quarantinedTransactions: number;
}

/** 解析结论 — 至少要报告「用了哪个代际」与「迁移发生了什么」。 */
export interface ResolveIndexGenerationResult {
	/** 解析出的代际;只读且无活动代际时为 null。 */
	resolved: ResolvedIndexGeneration | null;
	/** 本次执行的迁移结论;未跑迁移时为 null。 */
	migration: GenerationMigrationResult | null;
	/** 是否因为无法回收旧代际而暂停新建(spec §5 的第三配置上限)。 */
	reconcileBlocked: boolean;
	/**
	 * 本次新建前的回收决策面(T6 §8.5);未触发回收路径时为 null。
	 *
	 * 关键路径:孤儿目录数、被保留的代际、取证事务与阻断原因都只在这里可查。装配层需要把它们
	 * 接进诊断/状态,否则「回收发生了什么」在 `src/` 里没有任何消费者(代码质量审查 I4)。
	 */
	reconcile: IndexReconcileOutcome | null;
	/** 读取到的控制指针。 */
	control: GenerationControlRecord;
}

/**
 * 解析启动期索引目录。
 *
 * 决策顺序(与 T6 §8 的硬前置一致):
 * 1. `control.activeGenerationId` 存在:
 *    - 该代际记录的**配置指纹与当前一致** → 直接使用该代际目录,不迁移、不新建;
 *    - 指纹**不一致** → 不复用(否则新配置的日志/清单/完成记录会写进旧配置的代际目录,
 *      旧记录指纹不符 → 检索按不可判定处理,而 T6 §8.5 的 `configured-switch` 也因此不可达)。
 *      新建/取回**当前指纹**的隔离代际,旧活动代际与活动指针一律不动;是否切换由装配层在
 *      本轮核对完成后走 `configured-switch` 决定。切回曾用过的配置时按其指纹取回该代际,
 *      并先降级为「核对中」(`beginVerification`)——「曾活动」不等于「本轮已核对」。
 * 2. 无活动代际且不允许创建(只读装配)→ 返回 null,由调用方走只读可见性视图;
 * 3. 无活动代际且存在 legacy 索引 → 在 owner 锁内跑 `migrateLegacyIndex`;
 *    迁移报 `config-identity-unconfirmed`(旧清单身份不可确认)时走**显式重建入口**:
 *    新建 fresh 代际并让协调器逐文件重算,不复用任何旧块;
 *    其余迁移失败(空间不足、旧索引缺失等)按错误上抛(带稳定错误码),由装配层降级并如实报告;
 * 4. 无 legacy → 新建 fresh `building` 代际;活动指针等首个持久提交后由
 *    {@link createFirstCommitPromoter} 登记(spec §5「首个文件持久提交后原子登记」)。
 *
 * 本函数**从不**登记活动指针:`resolved.active === false` 的代际一律由装配层在本轮核对完成后
 * 发布;部分失败(本轮未 ready)时指针保持不变。
 *
 * @param options - 代际实例、配置、owner 与 legacy 来源。
 * @returns 解析结论。
 * @throws {Error} 迁移在「不可确认身份」之外失败(错误携带 `code`)、新建代际被回收上限阻断,
 *   或代际 ID 与记录的配置指纹不自洽(控制指针损坏)。
 */
export async function resolveIndexGeneration(
	options: ResolveIndexGenerationOptions,
): Promise<ResolveIndexGenerationResult> {
	const control = await options.generations.readControl();
	const fingerprint = await computeConfigFingerprint(options.config);
	const active = control.activeGenerationId;
	if (active !== null) {
		const record = control.generations[active];
		if (record === undefined) throw new Error(`控制指针的活动代际 ${active} 不在代际表中`);
		if (record.fingerprint === fingerprint) {
			return {
				resolved: {
					generationId: active,
					generationRoot: options.generations.generationRootOf(active),
					configFingerprint: record.fingerprint,
					status: record.status,
					active: true,
				},
				migration: null,
				reconcileBlocked: false,
				reconcile: null,
				control,
			};
		}
		// 关键路径(T7 修复):配置指纹不一致时**不得复用**旧活动代际。复用会让新配置的日志、
		// 清单、构建戳与完成记录写进旧配置的代际目录(该目录的完成记录指纹与新指纹不符 →
		// 本轮一个文件都无法复用,检索按不可判定处理),同时让 T6 §8.5 的 `configured-switch`
		// 在生产启动路径不可达(内存活动指针直接等于本代际,装配层不会安装发布订阅)。
		devLogger.warn('index', `活动代际 ${active} 的配置指纹与当前配置不一致,不复用该代际`);
		// 只读装配不建隔离代际,也不得混用不同配置的向量 —— 如实返回「当前配置没有可用代际」,
		// 由调用方走只读可见性视图(旧代际的完成记录按指纹不符处理)。
		if (!options.allowCreate) {
			return { resolved: null, migration: null, reconcileBlocked: false, reconcile: null, control };
		}
		return await acquireGenerationForConfig(options, control, fingerprint, null);
	}
	if (!options.allowCreate) return { resolved: null, migration: null, reconcileBlocked: false, reconcile: null, control };

	let migration: GenerationMigrationResult | null = null;
	if (options.legacy) {
		migration = await GenerationMigrationEngine.migrateLegacyIndex({
			indexRoot: options.indexRoot,
			generations: options.generations,
			config: options.config,
			legacy: {
				legacyIndexDir: options.legacy.indexDir,
				manifestPath: options.legacy.manifestPath,
				store: options.legacy.store,
			},
			owner: options.owner,
			currentInputs: options.legacy.currentInputs,
			chunkLimits: options.chunkLimits ?? {
				chunkSize: options.config.chunkSize,
				chunkOverlap: options.config.chunkOverlap,
			},
			...(options.expectedDimension === undefined ? {} : { expectedDimension: options.expectedDimension }),
		});
		if (migration.published && migration.generationId !== null) {
			const published = await options.generations.readControl();
			const record = published.generations[migration.generationId];
			return {
				resolved: {
					generationId: migration.generationId,
					generationRoot: options.generations.generationRootOf(migration.generationId),
					configFingerprint: record?.fingerprint ?? migration.configFingerprint ?? '',
					status: record?.status ?? 'active',
					active: true,
				},
				migration,
				reconcileBlocked: false,
				reconcile: null,
				control: published,
			};
		}
		if (migration.reason !== 'config-identity-unconfirmed') {
			// 关键路径(T7/I2/I3):错误必须携带**稳定错误码**,否则装配层无法经码表映射成用户文案,
			// 只能落 `error.index.unknown` + 开发向 message。`reason` 作为兜底码保留可判定性。
			throw Object.assign(
				new Error(
					`旧索引迁移失败,拒绝静默重建:${migration.reason ?? 'unknown'}(${migration.errorCode ?? 'no-code'})`,
				),
				{ code: migration.errorCode ?? 'migration-failed', migrationReason: migration.reason },
			);
		}
		// 关键路径(B1 的落地语义):旧清单身份不可确认时**不复用任何旧块**,走显式重建入口。
		devLogger.warn('index', '旧清单配置身份不可确认,按显式重建入口新建代际(不复用旧块)');
	}

	return await acquireGenerationForConfig(options, control, fingerprint, migration);
}

/**
 * 按当前配置取得代际 — 需要新建第三个代际时先跑回收决策,返回的代际一律**尚未**登记为活动。
 *
 * 关键路径(spec §5):
 * - 不先删除旧代际:隔离代际与旧活动代际并存,切换由装配层在本轮核对完成后原子执行;
 * - 待建代际在同配置下已存在时(`ensureGeneration` 幂等)仍要先降级为「核对中」:
 *   曾活动/曾核对完成的代际在降级时被清空 `verifiedAt`,因此切回相同配置**必须真的重新核对**,
 *   不能凭旧状态直接恢复 ready;
 * - 回收上限阻断时如实返回结论面,不静默复用旧代际(调用方据此报告占用而不是混写)。
 *
 * @param options - 解析选项。
 * @param control - 解析入口读到的控制指针(回收决策基于它)。
 * @param fingerprint - 当前配置指纹。
 * @param migration - 本次迁移结论(未跑迁移时为 null)。
 * @returns 解析结论;被回收上限阻断时 `resolved` 为 null。
 * @throws {Error} 代际 ID 与记录的配置指纹不自洽(控制指针损坏)。
 */
async function acquireGenerationForConfig(
	options: ResolveIndexGenerationOptions,
	control: GenerationControlRecord,
	fingerprint: string,
	migration: GenerationMigrationResult | null,
): Promise<ResolveIndexGenerationResult> {
	const requestedId = deriveGenerationId(fingerprint);
	const preexisting = control.generations[requestedId];
	let reconcile: IndexReconcileOutcome | null = null;
	if (preexisting === undefined && Object.keys(control.generations).length > 0) {
		// 关键路径:默认最多「活动 + 一个待建/回退」;需要第三个时先尝试回收可回收的非活动代际。
		const probes = new Map<string, GenerationReconcileProbeResult>();
		for (const generationId of Object.keys(control.generations)) {
			probes.set(generationId, await options.generations.probeGeneration(generationId));
		}
		const decision = await options.generations.reconcileForNewGeneration({
			probes,
			requestedFingerprint: fingerprint,
		});
		// 关键路径:取证事务数只在探测结果里,决策不携带;按「被保留的代际」汇总,不外推到已回收的。
		let quarantinedTransactions = 0;
		for (const generationId of decision.retained) {
			quarantinedTransactions += probes.get(generationId)?.quarantinedTransactions ?? 0;
		}
		reconcile = { decision, quarantinedTransactions };
		if (!decision.canCreate) {
			return {
				resolved: null,
				migration,
				reconcileBlocked: true,
				reconcile,
				control: await options.generations.readControl(),
			};
		}
	}
	const created = await options.generations.ensureGeneration({ config: options.config });
	if (preexisting !== undefined && preexisting.status === 'migrated') {
		// 关键路径(spec §5):切回相同配置先复核再复用 —— 降级为「核对中」并清空 `verifiedAt`,
		// 由本轮逐文件核对完成后经 `markGenerationMigrated` 重新写入,不得直接恢复旧 ready。
		await options.generations.beginVerification({ generationId: created.generationId });
	}
	const published = await options.generations.readControl();
	const record = published.generations[created.generationId];
	if (record === undefined || record.fingerprint !== fingerprint) {
		// 关键路径:代际 ID 由指纹派生,记录指纹必须与 ID 自洽。控制指针被外部改写时宁可拒绝,
		// 也不能把当前配置的向量写进归属不明的目录(混合态)。
		throw new Error(
			`代际 ${created.generationId} 的记录指纹与当前配置不一致,拒绝在该目录装配索引`,
		);
	}
	return {
		resolved: {
			generationId: created.generationId,
			generationRoot: created.generationRoot,
			configFingerprint: record.fingerprint,
			status: record.status,
			active: false,
		},
		migration,
		reconcileBlocked: false,
		reconcile,
		control: published,
	};
}