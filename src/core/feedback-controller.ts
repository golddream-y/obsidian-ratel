/**
 * @file src/core/feedback-controller.ts
 * @description 订阅 Model/Index status$ 驱动 UserStatus 与 UserNotice — 用户反馈集中接线
 * @module core/feedback-controller
 * @depends core/model-manager, core/index-manager, core/index-persistence-types,
 *          user-feedback/user-notice, user-feedback/user-status, logging/dev-logger, i18n
 */

import { get, type Readable } from 'svelte/store';
import type { Unsubscriber } from 'svelte/store';
import type { ModelStatus } from './model-manager';
import type { IndexStatus } from './index-manager';
import type { IndexPhase } from './index-persistence-types';
import { INDEX_VALIDATION_ERROR_CODES } from './index-persistence-types';
import { devLogger } from '../logging/dev-logger';
import type { UserNotice } from '../user-feedback/user-notice';
import { UserStatus, type UserStatusSnapshot, type IndexNotice } from '../user-feedback/user-status';
import { tNow, type StringKey } from '../i18n';
// 关键路径:错误码键类型取自各界面的 `as const` 元组导出的码类型 —— 只导入类型,零运行时依赖。
import type { WorkerManagerErrorCode } from '../worker/manager';
import type { IndexGenerationErrorCode } from './index-generations';
import type { IndexJournalErrorCode } from './index-file-journal';
import type { IndexValidationErrorCode } from './index-persistence-types';
import type { IndexWriteOwnerErrorCode } from './index-write-owner';
import type { AtomicStorageErrorCode } from '../adapters/atomic-index-storage';

/**
 * 索引状态展示的补充信号 — 由宿主装配层提供,不属于 IndexManager 状态机。
 *
 * 关键路径:这些事实(迁移结论、缺少 epoch 保护、可信记录是否可判定)在 T4/T5/T6 里是
 * 结构化可查询的,但 IndexStatus 不携带;不提供时按「无此信号」处理,不猜测。
 */
export interface IndexDisplaySignals {
	/** 本轮是否正在迁移/核对旧索引。 */
	migrating?: boolean;
	/** 本轮写请求是否缺少 epoch 保护(T6 的结构化事实)。 */
	epochSourceMissing?: boolean;
	/** 可信完成记录是否可判定;`unjudgeable` 时不得显示为「0 篇可检索」。 */
	recordsKind?: 'known' | 'unjudgeable';
	/** 记录集与当前配置的关系;`mismatch`/`unknown` 时不得显示为「已核对」。 */
	recordsConfig?: 'current' | 'mismatch' | 'unknown';
}

/** FeedbackController 构造依赖 — 注入 status$ 与快照读取函数,便于单测 */
export interface FeedbackControllerDeps {
	modelStatus$: Readable<ModelStatus>;
	indexStatus$: Readable<IndexStatus>;
	userNotice: UserNotice;
	userStatus: UserStatus;
	getEmbeddingReady: () => boolean;
	// 关键路径:Key 已迁至钥匙串,这里只暴露端点分类所需的最小字段(不传明文 Key)。
	getSettings: () => { embedProvider: 'local' | 'api'; embedApiBase: string; chatApiBase: string };
	onFullIndexComplete?: (indexed: number, errors: number) => void;
	/** 索引状态展示的补充信号;未提供时按无信号处理。 */
	getIndexSignals?: () => IndexDisplaySignals | undefined;
}

type ProgressHandle = ReturnType<UserNotice['toastProgress']>;

/**
 * 将 ModelManager / IndexManager 状态机翻译为使用者可见的 StatusBar 与 Notice。
 *
 * 设计要点:
 * - 里程碑才弹 Notice;增量索引只更新 statusBar$
 * - 独占管理模型下载 progress Notice 的生命周期
 * - 订阅回调内 try/catch,自身失败仅 devLogger,不抛给用户
 * - 状态展示区分总文件数、已提交数、待处理/失败数与当前阶段(T4/T5 的 stalled/stopping、
 *   T6 的迁移、只读通道的「记录不可判定」);新一轮 taskId 的进度不复用旧任务统计
 * - **不在这里宣告全库完成**:是否发送完成通知由调用方按 `isIndexComplete()` 与本轮失败数判定
 *
 * @example
 * const ctl = new FeedbackController(deps);
 * ctl.start();
 * // onunload:
 * ctl.destroy();
 */
export class FeedbackController {
	private readonly deps: FeedbackControllerDeps;
	private unsubscribers: Unsubscriber[] = [];
	/** 索引状态订阅句柄 — 与 model 订阅分开保存,便于降级重试后重新绑定(T7/I2)。 */
	private indexUnsubscriber?: Unsubscriber;
	private modelProgress: ProgressHandle | null = null;
	private apiModeNotified = false;
	/** 最近一次已发布的索引阶段 — 只用于识别「停滞 → 恢复」的跨次变化。 */
	private lastIndexPhase: IndexPhase | undefined;

	constructor(deps: FeedbackControllerDeps) {
		this.deps = deps;
	}

	/**
	 * 注册 status$ 订阅,并执行启动期一次性检查(API Embedding 模式、Embedding 就绪)。
	 */
	start(): void {
		this.applyStartupChecks();
		this.unsubscribers.push(
			this.deps.modelStatus$.subscribe((status) => this.safeRun(() => this.handleModelStatus(status))),
		);
		this.bindIndexStatus();
	}

	/**
	 * 把索引状态订阅重新绑到给定的 store — 降级重试重建 IndexController 后必须调用,
	 * 否则反馈层会继续订阅已被替换的旧状态机(T7/I2)。
	 *
	 * 关键路径:旧订阅先退订再绑新的;绑定后立刻按当前值刷新一次,避免状态停留在此前快照。
	 *
	 * @param status$ - 新的索引状态源。
	 */
	rebindIndexStatus(status$: Readable<IndexStatus>): void {
		this.deps.indexStatus$ = status$;
		this.bindIndexStatus();
		this.refreshIndexStatus();
	}

	/**
	 * 退订所有 status$ 订阅,并关闭进行中的 progress Notice。
	 */
	destroy(): void {
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		this.indexUnsubscriber?.();
		this.indexUnsubscriber = undefined;
		this.hideModelProgress();
	}

	/** 索引状态订阅的唯一绑定点 — start 与 rebindIndexStatus 共用。 */
	private bindIndexStatus(): void {
		this.indexUnsubscriber?.();
		this.indexUnsubscriber = this.deps.indexStatus$.subscribe((status) => this.safeRun(() => this.handleIndexStatus(status)));
	}

	/**
	 * 全量索引完成时由 main.onLayoutReady 调用 — 优先走外部回调,否则更新 statusBar$。
	 *
	 * 关键路径:迁移到 StatusLine — 不再弹 toast,只更新 statusBar$ 让 StatusLine 恢复"就绪"。
	 * 严重失败仍由 IndexManager 的 Failed 状态走 toastError 路径。
	 * **调用方必须先确认 `isIndexComplete()` 为真且本轮无失败**,本方法不再次判全库完成。
	 *
	 * @param indexed - 成功索引文档数
	 * @param errors - 失败文档数
	 */
	notifyFullIndexComplete(indexed: number, errors: number): void {
		if (errors > 0) {
			this.deps.userStatus.patch({ index: 'failed', indexDetail: tNow('notice.indexPartialFailure', { count: errors }) });
			return;
		}
		if (this.deps.onFullIndexComplete) {
			this.deps.onFullIndexComplete(indexed, errors);
			return;
		}
		this.safeRun(() => {
			const status = get(this.deps.indexStatus$);
			if (status.state !== 'Ready') return;
			// 修复:indexed 是本次处理数，完整总量以已经提交成功的Ready状态为准。
			this.deps.userStatus.patch({
				index: 'ready',
				indexDocCount: status.totalDocs,
				indexDetail: undefined,
			});
		});
	}

	/**
	 * 本地 Embedding 模型注入完成时由 main.onLayoutReady 调用。
	 *
	 * 关键路径:ModelManager.download() 内 status$.set(Ready) 触发 handleModelStatus 时,
	 * EmbeddingLocal.setEmbedding() 尚未执行,isReady 仍为 false,patchEmbeddingReady 得到 loading。
	 * 注入真实 ONNX 适配器后需再次 patch,把 embedding 状态推进到 ready。
	 */
	notifyEmbeddingReady(): void {
		this.safeRun(() => {
			this.deps.userStatus.patch({ embedding: 'ready' });
		});
	}

	/**
	 * 重新评估 Embedding 就绪状态 — embedProvider 切换或适配器重建后调用。
	 *
	 * 关键路径:settings 面板切 embedProvider 会调 rebuildEmbeddingAdapter(),
	 * 新 EmbeddingApi 立即可用(ready)、新 EmbeddingLocal 占位需等模型下载(loading),
	 * 需让 FeedbackController 重新读 getEmbeddingReady() 同步状态。
	 */
	refreshEmbeddingStatus(): void {
		this.safeRun(() => this.patchEmbeddingReady());
	}

	/**
	 * 重新发布索引展示信号 — 迁移结论/epoch 保护/可信记录可判定性变化时由宿主调用。
	 *
	 * 关键路径:这些信号不随 IndexStatus 变化,但必须立即上屏(例如关闭自动索引后
	 * 发现记录不可判定),所以允许宿主在装配完成后主动刷新一次。
	 */
	refreshIndexStatus(): void {
		this.safeRun(() => this.handleIndexStatus(get(this.deps.indexStatus$)));
	}

	private applyStartupChecks(): void {
		this.safeRun(() => {
			this.patchEmbeddingReady();

			// 关键路径:InlineWorker 是 Obsidian 渲染进程唯一可行路径(ADR-002),
			// 不再作为「降级」红字提示;抽屉「运行模式」仍显示默认 worker: inline。
			// API Embedding 降级提示迁移到 StatusDrawer,不再弹 toast。
			const settings = this.deps.getSettings();
			if (settings.embedProvider === 'api' && !this.apiModeNotified) {
				this.apiModeNotified = true;
				this.deps.userStatus.patch({
					degraded: tNow('status.degraded.apiEmbedding'),
				});
			}
		});
	}

	private patchEmbeddingReady(): void {
		this.deps.userStatus.patch({
			embedding: this.deps.getEmbeddingReady() ? 'ready' : 'loading',
		});
	}

	private handleModelStatus(status: ModelStatus): void {
		switch (status.state) {
			case 'NotStarted':
				this.deps.userStatus.patch({ model: 'idle', modelDetail: undefined });
				break;
			case 'Checking':
				this.deps.userStatus.patch({ model: 'checking', modelDetail: undefined });
				break;
			case 'Downloading': {
				const percent = Math.min(100, Math.round(status.progress * 100));
				const detail = `${percent}%`;
				const message = tNow('notice.modelDownloading', { detail });
				this.deps.userStatus.patch({ model: 'downloading', modelDetail: detail });
				if (!this.modelProgress) {
					this.modelProgress = this.deps.userNotice.toastProgress(message);
				} else {
					this.modelProgress.update(message);
				}
				break;
			}
			case 'Initializing':
				this.deps.userStatus.patch({ model: 'initializing', modelDetail: undefined });
				if (this.modelProgress) {
					this.modelProgress.update(tNow('notice.modelInit'));
				} else {
					this.modelProgress = this.deps.userNotice.toastProgress(
						tNow('notice.modelInit'),
					);
				}
				break;
			case 'Ready':
				this.hideModelProgress();
				this.deps.userStatus.patch({ model: 'ready', modelDetail: undefined });
				this.patchEmbeddingReady();
				break;
			case 'Failed':
				this.hideModelProgress();
				this.deps.userStatus.patch({ model: 'failed', modelDetail: status.reason });
				this.deps.userNotice.toastError(tNow('notice.modelLoadFailed', { reason: status.reason }));
				break;
			case 'Switching':
				this.deps.userStatus.patch({
					model: 'checking',
					modelDetail: `${status.from} → ${status.to}`,
				});
				break;
		}
	}

	private handleIndexStatus(status: IndexStatus): void {
		const patch = this.mapIndexStatus(status);
		if (Object.keys(patch).length > 0) {
			this.deps.userStatus.patch(patch);
		}

		if (status.state === 'Failed') {
			// 关键路径(T7/I1):失败文案必须经 `describeIndexError` —— 有稳定码时走码表,
			// 没有码时退回既有 reason(可能已是本地化文案)。绝不把开发向 message 直接上屏。
			this.deps.userNotice.toastError(tNow('notice.indexFailed', { reason: describeIndexFailure(status) }));
		}
	}

	/**
	 * 将 IndexManager 状态映射为 UserStatus 字段增量。
	 *
	 * 关键路径:
	 * - 区分总文件数、已提交数、待处理数与本轮失败数,避免只给一个模糊进度;
	 * - `reverifying` 明确说明「重新核对」,不让旧任务的完成统计污染新任务;
	 * - 阶段取协调器 phase(含 `stalled`/`stopping`),迁移由宿主信号补足;
	 * - 须知按 迁移中 > 缺少 epoch 保护 > 记录配置不符 > 记录不可判定 > 停滞/正在停止/恢复 排序,
	 *   未提供信号且未就绪时不覆盖宿主写入的须知(例如磁盘失败)。
	 *
	 * @param status - IndexManager 当前状态
	 * @returns 供 userStatus.patch 使用的部分快照
	 */
	private mapIndexStatus(status: IndexStatus): Partial<UserStatusSnapshot> {
		// 关键路径:只有携带 phase 的状态才带阶段;其余状态按「未知」处理,不猜测。
		const phase = status.state === 'Scanning' || status.state === 'Queueing' || status.state === 'Ready' || status.state === 'Failed'
			? status.phase
			: undefined;
		// 关键路径:识别「停滞 → 恢复」需要上一次已发布阶段;不引入第二份状态机。
		const resumed = this.lastIndexPhase === 'stalled' && phase !== undefined && phase !== 'stalled';
		if (phase !== undefined) this.lastIndexPhase = phase;
		const signals = this.readIndexSignals();

		const patch: Partial<UserStatusSnapshot> = {};
		switch (status.state) {
			case 'Idle':
				Object.assign(patch, {
					index: 'idle', indexDetail: undefined, indexPartial: false, indexPhase: undefined,
					indexTotalFiles: undefined, indexCommittedFiles: undefined,
					indexPendingFiles: undefined, indexFailedFiles: undefined,
				});
				break;
			case 'Init':
				Object.assign(patch, { index: 'init', indexDetail: undefined, indexPartial: false });
				break;
			case 'Diffing':
				// 关键路径:smartReindex hash diff 阶段,用户感知"正在检查变更"(spec §5.6)。
				Object.assign(patch, { index: 'diffing', indexDetail: tNow('status.detail.checkingChanges') });
				break;
			case 'Scanning':
				Object.assign(patch, {
					index: 'scanning',
					indexDetail: `${status.scanned}/${status.total}`,
					indexTotalFiles: status.total,
					indexCommittedFiles: status.committed ?? 0,
					indexPendingFiles: status.pending ?? 0,
					indexFailedFiles: status.failed ?? 0,
					indexPartial: (status.committed ?? 0) > 0,
				});
				break;
			case 'Queueing':
				Object.assign(patch, {
					index: phase === 'processing' ? 'processing' : 'queueing',
					// 关键路径:待处理量增加(重新核对)与单纯排队必须分开说明。
					indexDetail: status.reverifying === true
						? tNow('status.detail.reverifying')
						: tNow('status.detail.pending', { count: status.pending }),
					indexTotalFiles: status.total ?? (status.committed ?? 0),
					indexCommittedFiles: status.committed ?? 0,
					indexPendingFiles: status.pending,
					indexFailedFiles: status.failed ?? 0,
					indexPartial: (status.committed ?? 0) > 0,
				});
				break;
			case 'Processing':
				Object.assign(patch, { index: 'processing', indexDetail: status.currentBatch[0] ?? undefined });
				break;
			case 'Ready': {
				const committed = status.committedDocs ?? status.totalDocs;
				const total = status.totalFiles ?? status.totalDocs;
				Object.assign(patch, {
					index: 'ready',
					indexDocCount: status.totalDocs,
					indexDetail: undefined,
					indexTotalFiles: total,
					indexCommittedFiles: committed,
					indexPendingFiles: status.pendingDocs ?? 0,
					indexFailedFiles: status.failedDocs ?? 0,
					// 关键路径:已提交少于总文件数时仍是「部分可用」,不得宣称全库已核对。
					indexPartial: committed < total,
				});
				break;
			}
			case 'Paused':
				// 关键路径:Paused 与 Queueing 都用 pending 计数,但语义不同(待处理 vs 待索引),复用同一 key
				Object.assign(patch, {
					index: 'paused',
					indexDetail: tNow('status.detail.pending', { count: status.pending }),
					indexPendingFiles: status.pending,
				});
				break;
			case 'Failed':
				// 关键路径(T7/I1):详情同样经码表映射,不让开发向 message 出现在状态抽屉里。
				Object.assign(patch, { index: 'failed', indexDetail: describeIndexFailure(status) });
				if (status.total !== undefined) Object.assign(patch, {
					indexTotalFiles: status.total, indexCommittedFiles: status.committed ?? 0,
					indexPendingFiles: status.pending ?? 0, indexFailedFiles: status.failed ?? 0,
					indexPartial: (status.committed ?? 0) > 0,
				});
				break;
			case 'Unloaded':
				Object.assign(patch, { index: 'idle', indexDetail: undefined });
				break;
			default:
				break;
		}

		// 展示阶段:协调器 phase 优先;迁移中(尚未 ready)覆盖为 migrating。
		const migrating = signals?.migrating === true && status.state !== 'Ready';
		patch.indexPhase = migrating ? 'migrating' : phase;

		// 须知:迁移中 > 缺少 epoch 保护 > 记录配置不符 > 记录不可判定 > 停滞/正在停止/恢复。
		const notice = this.composeIndexNotice(signals, {
			migrated: migrating,
			stalled: phase === 'stalled',
			stopping: phase === 'stopping',
			resumed,
		});
		if (notice !== undefined) patch.indexNotice = notice;
		else if (status.state === 'Ready') {
			// 关键路径:真正就绪时清掉此前写入的须知(磁盘失败/不可判定不再成立)。
			patch.indexNotice = undefined;
		}
		// 其余状态:未提供信号时不覆盖宿主写入的须知(例如磁盘写入失败)。

		// 详情优先级:迁移 > 停滞/正在停止/恢复 > 须知对应说明 > 基础进度文案。
		if (migrating) patch.indexDetail = tNow('status.detail.migrating');
		else if (phase === 'stalled') patch.indexDetail = tNow('status.detail.stalled');
		else if (phase === 'stopping') patch.indexDetail = tNow('status.detail.stopping');
		else if (resumed) patch.indexDetail = tNow('status.detail.resumed');
		else if (notice === 'epoch-missing') patch.indexDetail = tNow('status.detail.epochMissing');
		else if (notice === 'config-mismatch') patch.indexDetail = tNow('status.detail.configMismatch');
		else if (notice === 'records-unknown') patch.indexDetail = tNow('status.detail.recordsUnknown');

		return patch;
	}

	/** 组合当前须知;无信号且状态本身没有须知时为 undefined(不覆盖既有值)。 */
	private composeIndexNotice(
		signals: IndexDisplaySignals | undefined,
		flags: { migrated: boolean; stalled: boolean; stopping: boolean; resumed: boolean },
	): IndexNotice | undefined {
		if (flags.migrated) return 'migrating';
		if (signals?.epochSourceMissing === true) return 'epoch-missing';
		// 关键路径:只有「已确认存在配置不符记录」才提示配置代际变化;信号读取失败
		// (`unknown`)不算配置变化,由 recordsKind 的 `unjudgeable` 分支如实呈现。
		if (signals?.recordsConfig === 'mismatch') return 'config-mismatch';
		if (signals?.recordsKind === 'unjudgeable') return 'records-unknown';
		if (flags.resumed) return 'resumed';
		if (flags.stalled) return 'stalled';
		if (flags.stopping) return 'stopping';
		return undefined;
	}

	/** 读取宿主提供的展示信号 — 自身失败只记录,不影响状态发布。 */
	private readIndexSignals(): IndexDisplaySignals | undefined {
		try {
			return this.deps.getIndexSignals?.();
		} catch (err) {
			devLogger.error('index', '读取索引展示信号失败', err);
			return undefined;
		}
	}

	private hideModelProgress(): void {
		this.modelProgress?.hide();
		this.modelProgress = null;
	}

	private safeRun(fn: () => void): void {
		try {
			fn();
		} catch (err) {
			devLogger.error('main', 'FeedbackController 回调失败', err);
		}
	}
}

// ==================== 错误码 → 用户文案 ====================

/**
 * 会被映射为专门文案的稳定错误码 — 六份既有 `as const` 错误码元组的码类型联合,
 * 外加两个只在本文件映射的码。
 *
 * 关键路径(T7 代码质量审查):把键类型从裸字面量收成码类型联合后,拼写错误在编译期暴露,
 * 也不会再出现「映射表里写了一个任何模块都不会产生的码」这类静默漂移。
 */
type IndexErrorTextCode =
	| WorkerManagerErrorCode
	| IndexGenerationErrorCode
	| IndexJournalErrorCode
	| IndexValidationErrorCode
	| IndexWriteOwnerErrorCode
	| AtomicStorageErrorCode
	// 归属断言错误(定义在 persistent-index-backend,该模块未导出码类型)
	| 'index-directory-not-owned'
	// Vectra 存储拒绝清库(drop-refused)
	| 'drop-refused'
	// 迁移失败的兜底码(迁移结论没有稳定码时由装配层赋予)
	| 'migration-failed'
	| 'all-generations-retained';

/** 错误码 → i18n key 映射 — 开发向 Error.message 一律不上屏。 */
const INDEX_ERROR_TEXT_KEYS: Partial<Record<IndexErrorTextCode, StringKey>> = {
	// T5 Worker/管理器错误码
	'index-stalled': 'error.index.worker.indexStalled',
	'index-cancelled': 'error.index.worker.indexCancelled',
	'runtime-reset': 'error.index.worker.runtimeReset',
	'worker-destroyed': 'error.index.worker.workerDestroyed',
	'request-blocked': 'error.index.worker.requestBlocked',
	'request-timeout': 'error.index.worker.requestTimeout',
	// T2/T6 归属与写所有权
	'index-directory-not-owned': 'error.index.directoryNotOwned',
	'drop-refused': 'error.index.dropRefused',
	'owner-not-writable': 'error.index.ownerNotWritable',
	// T6 迁移/代际与控制指针失败(降级出口的实际原因)
	'migration-failed': 'error.index.migrationFailed',
	'migration-space-insufficient': 'error.index.migrationSpaceInsufficient',
	'migration-io-failed': 'error.index.migrationIoFailed',
	'migration-interrupted': 'error.index.migrationInterrupted',
	'legacy-manifest-invalid': 'error.index.legacyManifestInvalid',
	'legacy-index-missing': 'error.index.legacyIndexMissing',
	'control-invalid': 'error.index.controlInvalid',
	'space-budget-exceeded': 'error.index.spaceBudgetExceeded',
	'generation-not-droppable': 'error.index.generationNotDroppable',
	'all-generations-retained': 'error.index.generationsRetained',
	// T2 写所有权:取锁失败是「索引暂不可写」最常见的原因
	'owner-busy': 'error.index.ownerBusy',
	'concurrent-takeover': 'error.index.concurrentTakeover',
	'owner-lock-corrupt': 'error.index.ownerLockCorrupt',
	// T1 校验错误码中「可能上屏」的四个
	'schema-version-unknown': 'error.index.validation.schemaVersionUnknown',
	'generation-mismatch': 'error.index.validation.generationMismatch',
	'config-fingerprint-mismatch': 'error.index.validation.configFingerprintMismatch',
	'checksum-mismatch': 'error.index.validation.checksumMismatch',
	// T3 文件日志错误码
	'owner-epoch-mismatch': 'error.index.journal.ownerEpochMismatch',
	'generation-quarantined': 'error.index.journal.generationQuarantined',
	'confirmation-required': 'error.index.journal.confirmationRequired',
	'prepared-not-found': 'error.index.journal.preparedNotFound',
	'transaction-mismatch': 'error.index.journal.transactionMismatch',
	'receipt-path-mismatch': 'error.index.journal.receiptPathMismatch',
	'prior-version-mismatch': 'error.index.journal.priorVersionMismatch',
	'prior-version-unresolved': 'error.index.journal.priorVersionUnresolved',
	'path-in-flight': 'error.index.journal.pathInFlight',
	'cleanup-failed': 'error.index.journal.cleanupFailed',
	'io-failure': 'error.index.journal.ioFailure',
};

/**
 * 把索引失败状态映射为用户可见文案(T7/I1)。
 *
 * 关键路径:
 * - `errorCode` 存在 → 与 `describeIndexError` 走**同一张码表**,未知码给「带码兜底」;
 * - 没有码 → 退回 `reason`。它可能是宿主写入的本地化文案(例如「N 个文件处理失败」),
 *   再包一层 `error.index.unknown` 会得到双重包装,因此原样使用。
 *
 * @param status - `IndexStatus` 的失败态。
 * @returns 已本地化的用户文案。
 */
export function describeIndexFailure(status: { reason: string; errorCode?: string }): string {
	if (status.errorCode !== undefined) return describeIndexError({ code: status.errorCode });
	return status.reason;
}

/** 磁盘/IO 类错误码 — 状态里呈现「磁盘失败」而不是混成普通失败。 */
const INDEX_DISK_FAILURE_CODES = new Set<string>([
	'io-failure',
	'checksum-mismatch',
	'unknown-after-rename',
	'migration-io-failed',
	'migration-interrupted',
	'migration-space-insufficient',
	'space-budget-exceeded',
	'ENOSPC',
	'EIO',
	'EROFS',
]);

/**
 * 把索引错误映射为用户可见文案。
 *
 * 关键路径:
 * - 优先用稳定错误码查表;未收录的校验错误码给「带码兜底」,其余未知码给通用码文案,
 *   **不把开发向 message 直接上屏**;
 * - 没有任何码的对象/字符串兜底带上原始消息,保证不静默。
 *
 * @param error - 任意捕获到的错误(通常来自 IndexManager/WorkerManager/索引适配器)。
 * @returns 已本地化的用户文案。
 */
export function describeIndexError(error: unknown): string {
	const code = errorCodeOf(error);
	if (code !== undefined) {
		// 关键路径:运行时仍是「任意码 → 查表」,未收录的码落带码兜底;类型只约束键,不放宽行为。
		const key = INDEX_ERROR_TEXT_KEYS[code as IndexErrorTextCode];
		if (key !== undefined) return tNow(key);
		if (isIndexValidationCode(code)) return tNow('error.index.validation.other', { code });
		return tNow('error.index.codeUnknown', { code });
	}
	const message = error instanceof Error ? error.message : String(error);
	return tNow('error.index.unknown', { message });
}

/**
 * 该错误是否属于磁盘/IO 类失败 — 调用方据此在状态里标记「磁盘失败」。
 *
 * @param error - 任意捕获到的错误。
 * @returns 属于磁盘/IO 类失败时为 true。
 */
export function isIndexDiskFailure(error: unknown): boolean {
	const code = errorCodeOf(error);
	return code !== undefined && INDEX_DISK_FAILURE_CODES.has(code);
}

/** 读取错误的稳定码;没有字符串码时为 undefined。 */
function errorCodeOf(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/** 该码是否属于 T1 校验错误码族(未单列文案时走带码兜底)。 */
function isIndexValidationCode(code: string): boolean {
	return VALIDATION_CODE_FLAGS.has(code);
}

/** T1 校验错误码集合 — 直接从类型文件读同一份 `as const` 元组,不复制第二份清单。 */
const VALIDATION_CODE_FLAGS = new Set<string>(INDEX_VALIDATION_ERROR_CODES);