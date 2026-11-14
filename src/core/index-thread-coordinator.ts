/**
 * @file src/core/index-thread-coordinator.ts
 * @description 线程版索引协调器 — 用同一条 `IndexTaskCoordinatorPort` 契约驱动索引线程
 * @module src/core/index-thread-coordinator
 *
 * 关键路径:
 * - 与现役主线程协调器实现**同一端口**:上层 `IndexManager` 不需要知道索引跑在哪里。
 * - 分块、向量、日志与提交都在线程内完成;本类只做枚举、读取与调度,不碰存储。
 * - 暂停先停调度,再等当前文件收敛;不在持锁期间长休息(调速属 M2)。
 * - 失败按文件计数并保留,不把未处理当成已索引;只有全部核实才允许 ready。
 * - 关闭后不再开始新任务;销毁会关闭线程,释放写权。
 */

import { devLogger } from '../logging/dev-logger';
import type { IndexPhase } from './index-persistence-types';
import type { IndexTaskCoordinatorPort } from './index-manager';
import type { IndexTaskCounters } from './index-task-coordinator';

/** 线程侧客户端需要的最小能力。 */
export interface ThreadIndexClient {
	start(options: {
		root: string;
		generationId: string;
		configFingerprint: string;
		expectedDimension?: number;
		access?: 'read-only' | 'read-write';
		chunkOptions?: { maxTokens?: number; overlapTokens?: number };
	}): Promise<void>;
	/** 注册「单篇完成」监听器 — 批量写入时按篇推进计数。 */
	onFileCommitted?: ((event: { path: string; chunkCount: number; skipped: boolean }) => void) | null;
	/** 注册「变更确认」监听器 — 重新分块前先用旧记录的块数占住分母。 */
	onFileChanged?: ((event: { path: string; chunkCount: number }) => void) | null;
	/** 注册「分块完成」监听器 — 分母按实际块数精确化(全新文件也要等这一步才入分母)。 */
	onFileChunked?: ((event: { path: string; chunkCount: number }) => void) | null;
	/** 注册「块已写入存储」监听器 — 与完成记录提交分开记账。 */
	onFileBlocksStored?: ((event: { path: string; chunkCount: number }) => void) | null;
	/** 单文件写入;`skipped: true` 表示内容未变、按完成记录直接复用(未做推理)。 */
	indexFile(filePath: string, content: string): Promise<{ chunkCount: number; skipped?: boolean }>;
	/** 批量写入;缺失时退化为逐个 `indexFile`。 */
	indexFiles?(files: ReadonlyArray<{ path: string; content: string }>): Promise<Array<{ path: string; chunkCount: number; skipped?: boolean }>>;
	deleteFile(filePath: string): Promise<{ removed: number }>;
	recover(inputs: ReadonlyArray<{ path: string; hash: string | null }>): Promise<{ pending: number; decisions: number; failures: number }>;
	close(reason?: string): Promise<void>;
	/** 已落盘的完成记录；用于恢复阶段显示真实进度。缺失时不做恢复提示。 */
	listCommitted?(): Promise<Array<{ path: string; state: 'present' | 'deleted'; chunkCount?: number }>>;
	/** 崩溃后重启;缺失表示该实现不支持自动恢复。 */
	restart?(): Promise<void>;
	/** 撤销在途请求;缺失表示只能停止调度新文件。 */
	abortActive?(reason?: string): void;
}

/** Vault 端口。 */
export interface ThreadIndexVault {
	listMarkdownFiles(): string[];
	readFile(filePath: string): Promise<string>;
}

/** 启动参数。 */
export interface ThreadCoordinatorStartOptions {
	root: string;
	generationId: string;
	configFingerprint: string;
	expectedDimension?: number;
	access?: 'read-only' | 'read-write';
	chunkOptions?: { maxTokens?: number; overlapTokens?: number };
	/**
	 * 本地词表内容 — 随启动帧下发给索引线程。
	 *
	 * 关键路径:分块的 token 计数必须与主线程共用同一份词表,否则同一条 chunkSize
	 * 在两种索引模式下切出不同的块,完成记录的内容哈希随之失配。
	 */
	vocabContent?: string;
}

/** 构造参数。 */
export interface IndexThreadCoordinatorOptions {
	client: ThreadIndexClient;
	vault: ThreadIndexVault;
	start: ThreadCoordinatorStartOptions;
}

/**
 * 判断错误是否来自「调用被撤销」。
 * @param message 错误消息
 */
function isAbortMessage(message: string): boolean {
	return message.includes('请求已取消') || message.includes('aborted');
}

/** 失败样本上限。 */
const MAX_FAILURE_SAMPLES = 5;

/** 每轮允许的崩溃重启次数上界。 */
const MAX_CRASH_RESTARTS = 2;

/**
 * 判断错误是否是「线程已退出」类。
 * @param message 错误消息
 */
function isCrashMessage(message: string): boolean {
	return message.includes('worker-exit') || message.includes('线程已退出') || message.includes('索引线程已退出');
}

/** 一次待处理动作。 */
interface ThreadQueueEntry {
	op: 'upsert' | 'delete';
}

/** 线程版协调器。 */
export class IndexThreadCoordinator implements IndexTaskCoordinatorPort {
	private readonly client: ThreadIndexClient;
	private readonly vault: ThreadIndexVault;
	private readonly startOptions: ThreadCoordinatorStartOptions;
	private readonly queue = new Map<string, ThreadQueueEntry>();
	private readonly failing = new Set<string>();
	/**
	 * 延后重试的文件 —— 首次失败不立刻算「失败」,先跳过继续处理其余文件。
	 *
	 * 关键路径(2026-11-06 线上):大文件在机器繁忙时单篇 embed 可能超时,若立刻计入失败,
	 * 用户会看到「进度不前、失败数上涨」。改为先记入延后集合,整轮跑完再回来重试一次,
	 * 只有重试后仍失败才最终计入失败。
	 */
	private readonly deferred = new Map<string, ThreadQueueEntry['op']>();
	/** 当前是否处于「最后一轮延后重试」—— 此轮失败即最终失败。 */
	private retryPass = false;
	/**
	 * 延后重试轮数上限。
	 *
	 * 关键路径(2026-11-06):首轮 + 2 轮延后 = 单文件最多尝试 3 次。机器繁忙时单篇超时
	 * 多半是瞬时的,给足 3 次机会;仍失败就放弃,不能让同一篇无限重试把整轮拖住。
	 */
	private static readonly MAX_DEFERRED_PASSES = 2;
	/**
	 * 已放弃的文件 —— 后续轮次直接跳过。
	 *
	 * 关键路径:不记下来就会「每次启动重试 3 次、每次都失败」,用户永远等不到收敛。
	 * 该集合在协调器实例内保留;重建协调器 (重载插件) 会重新给一次机会。
	 */
	private readonly abandoned = new Set<string>();
	/** 失败文件的原操作 —— 重试必须按原操作重排队,删除失败不能变成重写。 */
	private readonly failedOps = new Map<string, ThreadQueueEntry['op']>();
	/** 失败样本(路径 + 原因),最多保留 5 条 —— 状态只报数量时仍能定位是哪个文件、为什么。 */
	private readonly failureSamples: Array<{ path: string; message: string }> = [];
	private readonly verified = new Set<string>();
	/**
	 * 本轮已完成删除的路径 — 与 `verified` 分开。
	 *
	 * 关键路径:删除后文件已不在库里,不能再计入 `committed` / `total`,
	 * 否则启动对账处理旧记录时会出现「已索引 2897 / 当前只有 2877 篇」。
	 * 该集合只用于删除幂等,失效篇数走 `removedFiles`。
	 */
	private readonly deleted = new Set<string>();
	/**
	 * 本轮**真正写入**完成记录的篇数（不含重载后按内容哈希直接跳过的未变更笔记）。
	 *
	 * 关键路径(2026-11-06):对外展示的「已索引」必须包含跳过项,否则数字会倒退;
	 * 但**速率**只能基于真正写入的篇数 —— 否则重载后大量文件被秒跳过,
	 * 速率会算出 40+ 篇/秒这种与推理速度无关的假数字。
	 */
	private writtenThisRound = 0;
	/** 本轮跳过(内容未变、按完成记录复用)的文件数 — 诊断恢复是否生效。 */
	private skippedThisRound = 0;
	/** 本轮扫描到的库内篇数 — 与完成记录条数一起输出,供用户/诊断直接对账。 */
	private inventoryCount = 0;
	/** 本轮读到的完成记录条数(含失效记录)。 */
	private recordsTotal = 0;
	/** 是否仍有启动时的相关完成记录等待核对；不依赖墙钟时间。 */
	private restoring = false;
	/** 本轮启动时完成记录与当前库路径交集的大小 — 恢复进度的分母。 */
	private restoredTotal = 0;
	/** 尚未成功或最终失败的相关路径；删除即计数，重复回调不会重复推进。 */
	private receiptPaths: Set<string> = new Set();
	/** 已核对过的唯一相关路径数，不等于成功提交数。 */
	private examinedCount = 0;
	/** 本轮真正提交完成记录的**块数** — 速率只基于它,不受文档大小影响。 */
	private blocksCommittedThisRound = 0;
	/** 本轮已写入向量存储的块数 — 块已落盘,但完成记录未必已提交。 */
	private blocksStoredThisRound = 0;
	/** 本轮按完成记录复用的块数(内容未变,未做推理)。 */
	private blocksReusedThisRound = 0;
	/** 本轮失效(删除)路径移除的块数 — 只用于诊断对账,不计入写入。 */
	private blocksRemovedThisRound = 0;
	/** 已完成分块的精确块数。 */
	private exactBlocksThisRound = 0;
	/** 尚未分块文件的预估块数(来自完成记录 `chunkCount`)。 */
	private readonly estimatedBlocks = new Map<string, number>();
	private estimatedBlocksRemaining = 0;
	/** 已收到分块/落盘事件的路径 — 同一篇的重复事件不重复计数。 */
	private readonly chunkedPaths = new Set<string>();
	private readonly storedPaths = new Set<string>();
	/** 启动时已有完成记录的路径 — 用于区分「变更」与「新增」。 */
	private knownPaths = new Set<string>();
	/** 发现阶段结论(按篇):未变 / 新增 / 变更 / 失效。 */
	private skippedFiles = 0;
	private addedFiles = 0;
	private changedFiles = 0;
	private removedFiles = 0;
	private taskIdValue = 0;
	private phaseValue: IndexPhase = 'ready';
	private scanCompleted = false;
	private running = false;
	private activeCount = 0;
	private pausedValue = false;
	private stopping = false;
	private destroyed = false;
	private loop: Promise<void> | null = null;
	/** 批量通道失败后本轮禁用批量 —— 否则同一批会被反复取到并再次失败(死循环)。 */
	private batchDisabled = false;
	/** 是否已完成一次启动(线程已就绪);未启动时事件只入队不消费。 */
	private started = false;
	/** 本轮已尝试的崩溃重启次数 — 上界防止「崩-重启-再崩」无限循环。 */
	private restartsThisRound = 0;

	constructor(options: IndexThreadCoordinatorOptions) {
		this.client = options.client;
		this.vault = options.vault;
		this.startOptions = options.start;
	}

	/** 启动一轮:枚举 → 逐文件核对 → 收敛。 */
	async start(): Promise<IndexTaskCounters> {
		if (this.destroyed) throw new Error('协调器已销毁');
		this.taskIdValue += 1;
		this.scanCompleted = false;
		this.phaseValue = 'scanning';
		this.stopping = false;
		this.running = true;
		this.restartsThisRound = 0;
		this.batchDisabled = false;
		this.retryPass = false;
		this.deferred.clear();
		this.writtenThisRound = 0;
		this.blocksCommittedThisRound = 0;
		this.blocksStoredThisRound = 0;
		this.blocksReusedThisRound = 0;
		this.blocksRemovedThisRound = 0;
		this.exactBlocksThisRound = 0;
		this.estimatedBlocks.clear();
		this.estimatedBlocksRemaining = 0;
		this.chunkedPaths.clear();
		this.storedPaths.clear();
		this.deleted.clear();
		this.knownPaths = new Set();
		this.skippedFiles = 0;
		this.addedFiles = 0;
		this.changedFiles = 0;
		this.removedFiles = 0;
		this.skippedThisRound = 0;
		this.restoring = false;
		this.restoredTotal = 0;
		this.examinedCount = 0;
		this.receiptPaths = new Set();
		this.inventoryCount = 0;
		this.recordsTotal = 0;
		// 关键路径(诊断):分块计数口径必须一眼可见 —— 线程初始化没拿到词表时会退化成字符上界。
		devLogger.info(
			'index',
			`分块计数:${this.startOptions.vocabContent ? '词表精确' : '字符上界(未收到词表)'}`,
		);
		await this.client.start(this.startOptions);
		// 关键路径:线程真的起来之后才算已启动,否则启动失败会把后续事件派给不存在的线程。
		this.started = true;
		const files = this.vault.listMarkdownFiles();
		this.inventoryCount = files.length;
		const currentPaths = new Set(files);
		// 修复:分母仅包含当前库仍存在的完成记录，旧路径不能阻止恢复收敛。不要靠「有没有写入」
		// 推断 —— 恢复与新增写入是交织的,先遇到新文件不代表没有旧记录要核对。
		if (this.client.listCommitted === undefined) {
			devLogger.warn('index', '线程客户端不支持 listCommitted,本轮不显示恢复进度');
		} else {
			try {
				const records = await this.client.listCommitted();
				this.recordsTotal = records.length;
				this.receiptPaths = new Set(
					records.filter((record) => record.state === 'present' && currentPaths.has(record.path)).map((record) => record.path),
				);
				this.restoredTotal = this.receiptPaths.size;
				this.knownPaths = new Set(this.receiptPaths);
				for (const record of records) {
					if (record.state !== 'present') continue;
					if (currentPaths.has(record.path)) continue;
					// 关键路径(块级记账):分母只统计本轮真正要重新写入或删除的文件。
					// 未变文件不做推理,计入分母会把「已写 K / 共 M」稀释成假象。
					this.seedEstimate(record.path, record.chunkCount ?? 0);
					// 关键路径:完成记录存在但文件已不在库中 —— 必须排队删除。
					// 否则失效文件永远留在记录里,分母预估也永远收敛不了。
					this.queue.set(record.path, { op: 'delete' });
				}
				devLogger.info('index', `恢复检查:完成记录 ${records.length} 条,其中当前库相关 present ${this.restoredTotal} 条`);
			} catch (error) {
				devLogger.warn('index', '读取完成记录总数失败,本轮不显示恢复进度', error);
				this.restoredTotal = 0;
			}
		}
		this.restoring = this.restoredTotal > 0;
		devLogger.info('index', `恢复阶段:${this.restoring ? `开启（待核对 ${this.restoredTotal} 篇）` : '跳过（无完成记录）'}`);

		// 关键路径:按篇推进 —— 批量提交时不等整批结算,进度按篇递增。
		// 关键路径:无条件挂载回调 —— 客户端只需在事件到达时读取该字段,
		// 不要求实现方预先声明;否则未声明的实现会静默丢失全部块级事件。
		this.client.onFileCommitted = (event) => {
			this.markSuccess(event.path, event.skipped !== true, event.chunkCount);
		};
		// 关键路径(块级记账):变更确认即用旧记录块数占住分母,分块完成后再换成精确值;
		// 块落盘与完成记录提交分开上报,才能解释「UI 有块提交、库内记录未变」这类对账差异。
		this.client.onFileChanged = (event) => this.seedEstimate(event.path, event.chunkCount);
		this.client.onFileChunked = (event) => this.markChunked(event.path, event.chunkCount);
		this.client.onFileBlocksStored = (event) => this.markBlocksStored(event.path, event.chunkCount);
		let skippedAbandoned = 0;
		for (const filePath of files) {
			if (this.stopping || this.destroyed) break;
			// 关键路径:已放弃的路径不再入队,否则每轮都会重试到上限再放弃,永远收敛不了。
			if (this.abandoned.has(filePath)) {
				skippedAbandoned += 1;
				continue;
			}
			this.queue.set(filePath, { op: 'upsert' });
		}
		if (skippedAbandoned > 0) {
			devLogger.warn('index', `本轮跳过 ${skippedAbandoned} 个已放弃的路径(多次重试仍失败)`);
		}
		this.scanCompleted = true;
		this.phaseValue = 'processing';
		await this.drain();
		// 关键路径:先把其余文件处理完,再回来重试延后的那些 —— 机器繁忙时它们不一定真坏。
		// 最多重试 MAX_DEFERRED_PASSES 轮(单文件共 3 次),最后一轮仍失败即放弃。
		for (let pass = 1; pass <= IndexThreadCoordinator.MAX_DEFERRED_PASSES; pass += 1) {
			if (this.stopping || this.pausedValue || this.deferred.size === 0) break;
			const isLastPass = pass === IndexThreadCoordinator.MAX_DEFERRED_PASSES;
			this.retryPass = isLastPass;
			for (const [deferredPath, op] of [...this.deferred]) {
				// 关键路径:重试保持原操作 —— 删除失败若改成重写,会把已删文件重新嵌入。
				this.queue.set(deferredPath, { op });
			}
			this.deferred.clear();
			await this.drain();
		}
		this.retryPass = false;
		// 关键路径(诊断):重启后是否复用完成记录,一眼看清 —— 跳过数应接近已索引篇数。
		devLogger.info(
			'index',
			`索引轮完成:写入 ${this.writtenThisRound} 篇 / 跳过 ${this.skippedThisRound} 篇(完成记录复用) / 失败 ${this.failing.size}`
			+ ` | 块:落盘 ${this.blocksStoredThisRound} / 提交 ${this.blocksCommittedThisRound} / 复用 ${this.blocksReusedThisRound} / 移除 ${this.blocksRemovedThisRound}`
			+ ` | 发现:变更 ${this.changedFiles} / 新增 ${this.addedFiles} / 失效 ${this.removedFiles}`
			// 关键路径(对账):库内篇数应与「完成记录 − 本轮失效」收敛相等,差值不为 0 才是问题。
			+ ` | 对账:库内 ${this.inventoryCount} 篇 / 完成记录 ${this.recordsTotal} 条 / 差值 ${this.recordsTotal - this.removedFiles - this.inventoryCount}`,
		);
		// 关键路径(诊断):恢复态若没收敛,列出还没被核对的记录路径,
		// 避免再靠「差几篇」这种表面数字去猜原因。
		if (this.restoring) {
			const pending = [...this.receiptPaths];
			devLogger.warn(
				'index',
				`恢复未收敛:已核对 ${this.examinedCount}/${this.restoredTotal},未核对路径样本:${pending.slice(0, 10).join(' | ') || '(空)'}`,
			);
		}
		if (this.failing.size > 0) {
			const sample = this.failureSamples.map((item) => `${item.path}: ${item.message}`).join('; ');
			devLogger.warn('index', `本轮有 ${this.failing.size} 个文件连续重试 ${IndexThreadCoordinator.MAX_DEFERRED_PASSES + 1} 次仍失败,标记为放弃:${sample}`);
		}
		// 关键路径:暂停与撤销优先于「全部成功」—— 不能因为已处理的部分成功就报告 ready。
		this.refreshPhase();
		this.running = false;
		return this.counters();
	}

	/**
	 * 记录失败样本,同一路径只留一条。
	 *
	 * 关键路径:延后重试会让同一文件命中失败分支两次(首轮延后、重试轮最终失败),
	 * 不去重的话状态里会显示重复条目,也白白占掉样本上限。
	 */
	private recordFailureSample(filePath: string, message: string): void {
		if (this.failureSamples.some((sample) => sample.path === filePath)) return;
		if (this.failureSamples.length >= MAX_FAILURE_SAMPLES) return;
		this.failureSamples.push({ path: filePath, message });
	}

	/**
	 * 按当前状态刷新阶段 — 增量收敛后同样要更新,否则状态会永远停在「处理中」。
	 */
	private refreshPhase(): void {
		if (this.stopping) this.phaseValue = 'stopping';
		else if (this.pausedValue) this.phaseValue = 'paused';
		else if (this.failing.size > 0) this.phaseValue = 'partial-failure';
		else if (this.activeCount > 0 || this.queue.size > 0 || this.deferred.size > 0) this.phaseValue = 'processing';
		else this.phaseValue = 'ready';
		// 关键路径:已放弃的历史失败不再核对，终态只收起提示，不伪造本轮核对数。
		if (this.scanCompleted && !this.pausedValue && !this.stopping
			&& this.activeCount === 0 && this.queue.size === 0 && this.deferred.size === 0) {
			this.restoring = false;
		}
	}

	/** 计数快照 — 与主线程协调器同口径。 */
	counters(): IndexTaskCounters {
		// 关键路径:在途整批已从 queue 出队但尚未完成,必须计入 total;否则批期间
		// total 归零,进度条进入「未知进度」转圈,与实际情况不符。
		const total = this.verified.size + this.failing.size + this.deferred.size + this.queue.size + this.activeCount;
		const pendingFiles = this.queue.size + this.activeCount + this.deferred.size;
		return {
			taskId: this.taskIdValue,
			phase: this.phaseValue,
			scanComplete: this.scanCompleted,
			total,
			committed: this.verified.size,
			pendingFiles,
			committedThisRound: this.writtenThisRound,
			committedBlocksThisRound: this.blocksCommittedThisRound,
			storedBlocksThisRound: this.blocksStoredThisRound,
			reusedBlocksThisRound: this.blocksReusedThisRound,
			totalBlocksThisRound: this.exactBlocksThisRound + this.estimatedBlocksRemaining,
			blocksEstimated: this.estimatedBlocks.size > 0,
			skippedFiles: this.skippedFiles,
			addedFiles: this.addedFiles,
			changedFiles: this.changedFiles,
			removedFiles: this.removedFiles,
			queued: this.queue.size,
			active: this.activeCount,
			pendingTransactions: 0,
			failures: this.failing.size,
			restoring: this.restoring,
			restoredFiles: this.examinedCount,
			restoredTotal: this.restoredTotal,
		};
	}

	/** 记录路径事件;销毁或停止调度后不再接收。 */
	notify(filePath: string, op: 'upsert' | 'delete'): void {
		if (this.destroyed || this.stopping) return;
		if (op === 'delete') {
			this.verified.delete(filePath);
		} else {
			// 关键路径(2026-11-10 真机):同一路径在增量里被重写时,上一轮留下的核验/分块/
			// 落盘标记必须清掉。否则 markSuccess 把它当成重复事件直接返回 —— 库里的块在变,
			// 界面的已写块数却冻在上一轮,两边永远对不上账。
			this.verified.delete(filePath);
			this.chunkedPaths.delete(filePath);
			this.storedPaths.delete(filePath);
			this.deleted.delete(filePath);
			this.settleEstimate(filePath);
		}
		this.queue.set(filePath, { op });
		this.phaseValue = this.pausedValue ? 'paused' : 'processing';
	}

	/** 收敛队列;暂停、销毁或尚未启动时提前返回。 */
	async drain(): Promise<void> {
		if (!this.started) return;
		if (this.loop !== null) return this.loop;
		this.loop = this.runLoop();
		try {
			await this.loop;
		} finally {
			this.loop = null;
			this.refreshPhase();
		}
	}

	/** 失败样本 — 供诊断输出使用。 */
	failureDetails(): ReadonlyArray<{ path: string; message: string }> {
		return this.failureSamples;
	}

	/** 仅成功或最终失败才完成核对；延后、撤销和未处理路径仍须等待。 */
	private markExamined(filePath: string): void {
		if (!this.receiptPaths.delete(filePath)) return;
		this.examinedCount += 1;
		this.restoring = this.receiptPaths.size > 0;
	}

	/** 记录成功:清除失败标记、原操作与样本 —— 样本只描述「当前仍失败」的文件。 */
	private markSuccess(filePath: string, written = true, blocks = 0): void {
		this.markExamined(filePath);
		this.deleted.delete(filePath);
		// 关键路径:批量路径会先收到「按篇事件」、整批结束时又拿到结果,
		// 幂等返回避免同一篇被计两次(计数虚高、速率失真)。
		if (this.verified.has(filePath)) return;
		this.verified.add(filePath);
		// 关键路径:速率只认真正提交的块数,跳过(内容未变)只计入复用。
		if (written) {
			this.writtenThisRound += 1;
			this.blocksCommittedThisRound += Math.max(0, Math.floor(blocks));
			if (this.knownPaths.has(filePath)) this.changedFiles += 1;
			else this.addedFiles += 1;
		} else {
			this.skippedThisRound += 1;
			this.blocksReusedThisRound += Math.max(0, Math.floor(blocks));
			this.skippedFiles += 1;
		}
		this.settleEstimate(filePath);
		this.clearFailure(filePath);
	}

	/**
	 * 记录失效(删除)完成 — 失效块属于移除,不计入写入。
	 *
	 * 关键路径:失效文件先用完成记录 `chunkCount` 计入分母预估,
	 * 删除完成后结算掉该预估,避免分母永远等不到写入。
	 */
	private markDeleted(filePath: string, removedBlocks: number): void {
		this.markExamined(filePath);
		if (this.deleted.has(filePath)) return;
		this.deleted.add(filePath);
		this.removedFiles += 1;
		this.blocksRemovedThisRound += Math.max(0, Math.floor(removedBlocks));
		this.settleEstimate(filePath);
		this.clearFailure(filePath);
	}

	/**
	 * 记录分块完成 — 用实际块数替换按完成记录做的预估。
	 *
	 * 关键路径:全新文件没有完成记录,只能等分块后才进入分母;
	 * 变更文件此时把预估换成实际,界面据 `blocksEstimated` 标明是预估还是实际。
	 */
	private markChunked(filePath: string, blocks: number): void {
		if (this.chunkedPaths.has(filePath)) return;
		this.chunkedPaths.add(filePath);
		this.exactBlocksThisRound += Math.max(0, Math.floor(blocks));
		this.settleEstimate(filePath);
	}

	/**
	 * 用完成记录的旧块数为某路径记一笔预估 — 同一路径只记一次。
	 *
	 * 关键路径:预估只服务「尚未分块」的变更/失效文件;已有精确块数或已预估的不重复累加,
	 * 否则分母会被同一篇反复抬高,最终 K 永远追不上 M。
	 */
	private seedEstimate(filePath: string, blocks: number): void {
		if (this.chunkedPaths.has(filePath)) return;
		if (this.estimatedBlocks.has(filePath)) return;
		const estimated = Math.max(0, Math.floor(blocks));
		if (estimated === 0) return;
		this.estimatedBlocks.set(filePath, estimated);
		this.estimatedBlocksRemaining += estimated;
	}

	/** 记录块已写入向量存储(完成记录未必已提交)。 */
	private markBlocksStored(filePath: string, blocks: number): void {
		if (this.storedPaths.has(filePath)) return;
		this.storedPaths.add(filePath);
		this.blocksStoredThisRound += Math.max(0, Math.floor(blocks));
	}

	/** 结算某路径的预估块数 — 预估只在分块前有效,一次只扣一次。 */
	private settleEstimate(filePath: string): void {
		const estimated = this.estimatedBlocks.get(filePath);
		if (estimated === undefined) return;
		this.estimatedBlocks.delete(filePath);
		this.estimatedBlocksRemaining = Math.max(0, this.estimatedBlocksRemaining - estimated);
	}

	/** 清除失败标记与样本。 */
	private clearFailure(filePath: string): void {
		this.failing.delete(filePath);
		this.failedOps.delete(filePath);
		const sampleIndex = this.failureSamples.findIndex((item) => item.path === filePath);
		if (sampleIndex >= 0) this.failureSamples.splice(sampleIndex, 1);
	}

	/** 当前是否可标记 ready。 */
	isReady(): boolean {
		return this.scanCompleted && this.queue.size === 0 && this.activeCount === 0 && this.failing.size === 0;
	}

	/** 暂停:停止调度新文件,在途文件跑完。 */
	pause(): void {
		this.pausedValue = true;
		this.phaseValue = 'paused';
	}

	/**
	 * 撤销在途处理:停止调度后续文件。
	 *
	 * 关键路径:线程内的单文件请求不可中途打断(取消语义由协议层负责);
	 * 这里只保证不再开始新文件,当前文件要么提交成功、要么失败后被记录。
	 */
	abortActive(reason?: string): void {
		this.stopping = true;
		this.phaseValue = 'stopping';
		// 关键路径:先撤销在途调用,再停止调度 —— 只停调度会让「已暂停」与「仍在校验」并存。
		this.client.abortActive?.(reason ?? 'aborted');
	}

	/** 恢复调度。 */
	resume(): void {
		this.pausedValue = false;
		this.stopping = false;
		if (this.running) this.phaseValue = 'processing';
	}

	/** 销毁:关闭线程,释放写权。 */
	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.queue.clear();
		void this.client.close('协调器销毁');
	}

	/**
	 * 崩溃恢复 — 仅对「线程已退出」类错误重启一次。
	 *
	 * @param error 捕获到的错误
	 * @returns 是否已完成重启并应重试当前文件
	 */
	private async recoverFromCrash(error: unknown): Promise<boolean> {
		if (this.client.restart === undefined) return false;
		if (this.restartsThisRound >= MAX_CRASH_RESTARTS) return false;
		const message = error instanceof Error ? error.message : String(error);
		if (!isCrashMessage(message)) return false;
		this.restartsThisRound += 1;
		try {
			await this.client.restart();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 取当前连续待写入队列的整批文件。
	 *
	 * 只取 upsert 项;遇到删除即停止,保证顺序与逐条处理一致。
	 * 文件数不再设固定上限,消息大小由现有协议载荷预算在发送前约束。
	 */
	/**
	 * 单批上限 — 进度反馈粒度。
	 *
	 * 关键路径(2026-11-06):此前取「队列里全部连续 upsert」作为一批,全新 96 篇库就是
	 * 一整批。批出队后 `counters().total` 归零(在途没计入)、`markSuccess` 要等整批做完,
	 * 于是状态栏长时间停在「正在建立索引 + 未知进度转圈」,用户无法判断是否在推进。
	 * 有界批让完成计数按批递增,状态可感知。
	 */
	/**
	 * 单批文件数。
	 *
	 * 关键路径(2026-11-07):批内多篇是「先全部准备、再一起提交」,进度事件只能
	 * 在批末集中触发,用户看到的是「一次跳 N 篇」。分片之后单文件提交只重写自己那
	 * 一片(约占整库 1/N),写放大已经很小 —— 因此取 1,按篇提交换取逐篇进度。
	 * 若将来重新追求写入合并,把该常量调大即可,批量通道代码仍在。
	 */
	private static readonly MAX_BATCH_FILES = 1;

	private takeBatch(): Array<{ path: string; entry: ThreadQueueEntry }> {
		const batch: Array<{ path: string; entry: ThreadQueueEntry }> = [];
		if (this.batchDisabled) return batch;
		for (const [filePath, entry] of this.queue) {
			if (entry.op !== 'upsert' || batch.length >= IndexThreadCoordinator.MAX_BATCH_FILES) break;
			batch.push({ path: filePath, entry });
		}
		return batch;
	}

	/** 逐文件消费队列。 */
	private async runLoop(): Promise<void> {
		for (;;) {
			if (this.destroyed) return;
			if (this.pausedValue || this.stopping) return;
			// 关键路径:有批量能力时取当前连续 upsert 整批,把 N 次整库重写压成 1 次;
			// 删除操作不进批(语义不同),保持逐条。线程侧保证先完成全批块落盘,再写完成记录。
			const batch = this.client.indexFiles === undefined ? [] : this.takeBatch();
			if (batch.length > 1) {
				// 先出队再处理:留在队列里会被下一轮重复取出(死循环)。
				for (const item of batch) this.queue.delete(item.path);
				this.activeCount = batch.length;
				try {
					const contents: Array<{ path: string; content: string }> = [];
					for (const item of batch) contents.push({ path: item.path, content: await this.vault.readFile(item.path) });
					const results = await this.client.indexFiles!(contents);
					const done = new Map(results.map((item) => [item.path, item]));
					for (const item of batch) {
						const written = done.get(item.path);
						if (written !== undefined) {
							this.markSuccess(item.path, written.skipped !== true, written.chunkCount);
						} else {
							this.queue.set(item.path, item.entry);
						}
					}
				} catch {
					// 关键路径:整批失败时本轮改走逐篇,避免一个坏文件拖垮同批其余文件,
					// 也避免「同批反复重取 → 反复失败」的死循环。
					this.batchDisabled = true;
					for (const item of batch) this.queue.set(item.path, item.entry);
				} finally {
					this.activeCount = 0;
				}
				continue;
			}
			const next = this.queue.entries().next();
			if (next.done === true) return;
			const [filePath, entry] = next.value;
			this.queue.delete(filePath);
			this.activeCount = 1;
			try {
				if (entry.op === 'delete') {
					const removed = await this.client.deleteFile(filePath);
					this.markDeleted(filePath, removed.removed);
					continue;
				}
				const content = await this.vault.readFile(filePath);
				const result = await this.client.indexFile(filePath, content);
				this.markSuccess(filePath, result.skipped !== true, result.chunkCount);
				continue;
			} catch (error) {
				// 关键路径:只有「用户撤销」才算停止信号 —— 重新排队,等 resume 继续。
				// 若把任意「请求已取消/超时」都当停止,一个文件的超时就会让整轮索引提前收工,
				// 其余文件永远停在待处理。
				const message = error instanceof Error ? error.message : String(error);
				if (isAbortMessage(message) && this.stopping) {
					this.queue.set(filePath, entry);
					return;
				}
				// 关键路径(T5):线程崩溃不等于文件内容有问题 —— 先尝试一次重启并重试当前文件;
				// 重启上界用尽后仍失败才算该文件失败,避免把「线程死了」记成「文件索引失败」。
				const recovered = await this.recoverFromCrash(error);
				if (recovered) {
					this.queue.set(filePath, entry);
				} else if (!this.retryPass) {
					// 关键路径:首轮失败先「延后」—— 继续处理其余文件,整轮结束后再回来重试,
					// 期间不计入失败数。机器繁忙时单篇超时很常见,立刻判失败会让进度看起来卡死。
					this.deferred.set(filePath, entry.op);
					this.recordFailureSample(filePath, message);
				} else {
					// 延后重试轮仍失败 → 最终失败,保留在失败集合里,不能当成已处理。
					this.failedOps.set(filePath, entry.op);
					if (!this.failing.has(filePath)) {
						// 关键路径:每个文件只记一次,避免重试把日志刷满;样本用于定位具体文件。
						this.recordFailureSample(filePath, message);
						devLogger.warn('index', `线程索引失败(已延后重试):${filePath}:${message}`);
					}
					this.failing.add(filePath);
					// 关键路径:放弃是终态,后续轮次不再重试,避免「每次都重试到上限」的无穷循环。
					this.abandoned.add(filePath);
					this.markExamined(filePath);
				}
			} finally {
				this.activeCount = 0;
			}
		}
	}
}
