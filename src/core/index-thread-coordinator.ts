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
	indexFile(filePath: string, content: string): Promise<{ chunkCount: number }>;
	/** 批量写入;缺失时退化为逐个 `indexFile`。 */
	indexFiles?(files: ReadonlyArray<{ path: string; content: string }>): Promise<Array<{ path: string; chunkCount: number; skipped?: boolean }>>;
	deleteFile(filePath: string): Promise<{ removed: number }>;
	recover(inputs: ReadonlyArray<{ path: string; hash: string | null }>): Promise<{ pending: number; decisions: number; failures: number }>;
	close(reason?: string): Promise<void>;
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

/** 单批最多文件数。 */
const MAX_BATCH_FILES = 8;

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
	/** 失败文件的原操作 —— 重试必须按原操作重排队,删除失败不能变成重写。 */
	private readonly failedOps = new Map<string, ThreadQueueEntry['op']>();
	/** 失败样本(路径 + 原因),最多保留 5 条 —— 状态只报数量时仍能定位是哪个文件、为什么。 */
	private readonly failureSamples: Array<{ path: string; message: string }> = [];
	private readonly verified = new Set<string>();
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
		await this.client.start(this.startOptions);
		// 关键路径:线程真的起来之后才算已启动,否则启动失败会把后续事件派给不存在的线程。
		this.started = true;

		const files = this.vault.listMarkdownFiles();
		for (const filePath of files) {
			if (this.stopping || this.destroyed) break;
			this.queue.set(filePath, { op: 'upsert' });
		}
		this.scanCompleted = true;
		this.phaseValue = 'processing';
		await this.drain();
		// 关键路径:失败重试一轮 —— 同步盘/远程存储常在扫描期间改写文件,
		// 一次瞬时读失败不该让文件一直停留在失败集合里。
		if (!this.stopping && this.failing.size > 0) {
			// 关键路径:重试保持原操作 —— 删除失败若改成重写,会把已删文件重新嵌入,留下陈旧向量。
			for (const failedPath of [...this.failing]) {
				this.queue.set(failedPath, { op: this.failedOps.get(failedPath) ?? 'upsert' });
			}
			await this.drain();
			// 关键路径:只有重试后仍失败才告警 —— 按样本数判定会把「重试已恢复」误报成失败。
			if (this.failing.size > 0) {
				const sample = this.failureSamples.map((item) => `${item.path}: ${item.message}`).join('; ');
				devLogger.warn('index', `本轮仍有 ${this.failing.size} 个文件失败(已重试一次):${sample}`);
			}
		}
		// 关键路径:暂停与撤销优先于「全部成功」—— 不能因为已处理的部分成功就报告 ready。
		this.refreshPhase();
		this.running = false;
		return this.counters();
	}

	/**
	 * 按当前状态刷新阶段 — 增量收敛后同样要更新,否则状态会永远停在「处理中」。
	 */
	private refreshPhase(): void {
		if (this.stopping) this.phaseValue = 'stopping';
		else if (this.pausedValue) this.phaseValue = 'paused';
		else if (this.failing.size > 0) this.phaseValue = 'partial-failure';
		else if (this.activeCount > 0 || this.queue.size > 0) this.phaseValue = 'processing';
		else this.phaseValue = 'ready';
	}

	/** 计数快照 — 与主线程协调器同口径。 */
	counters(): IndexTaskCounters {
		const total = this.verified.size + this.failing.size + this.queue.size;
		const pendingFiles = this.queue.size + this.activeCount;
		return {
			taskId: this.taskIdValue,
			phase: this.phaseValue,
			scanComplete: this.scanCompleted,
			total,
			committed: this.verified.size,
			pendingFiles,
			committedThisRound: this.verified.size,
			queued: this.queue.size,
			active: this.activeCount,
			pendingTransactions: 0,
			failures: this.failing.size,
		};
	}

	/** 记录路径事件;销毁或停止调度后不再接收。 */
	notify(filePath: string, op: 'upsert' | 'delete'): void {
		if (this.destroyed || this.stopping) return;
		if (op === 'delete') this.verified.delete(filePath);
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

	/** 记录成功:清除失败标记、原操作与样本 —— 样本只描述「当前仍失败」的文件。 */
	private markSuccess(filePath: string): void {
		this.verified.add(filePath);
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
	 * 取一批待写入的文件(最多 {@link MAX_BATCH_FILES})。
	 *
	 * 只取 upsert 项;遇到删除即停止,保证顺序与逐条处理一致。
	 */
	private takeBatch(): Array<{ path: string; entry: ThreadQueueEntry }> {
		const batch: Array<{ path: string; entry: ThreadQueueEntry }> = [];
		if (this.batchDisabled) return batch;
		for (const [filePath, entry] of this.queue) {
			if (entry.op !== 'upsert') break;
			batch.push({ path: filePath, entry });
			if (batch.length >= MAX_BATCH_FILES) break;
		}
		return batch;
	}

	/** 逐文件消费队列。 */
	private async runLoop(): Promise<void> {
		for (;;) {
			if (this.destroyed) return;
			if (this.pausedValue || this.stopping) return;
			// 关键路径:有批量能力时一次取多篇,把 N 次整库重写压成 1 次;
			// 删除操作不进批(语义不同),保持逐条。
			// 关键路径(2026-11-04 回退):批量提交把「完成记录先写、块后落盘」的顺序倒置,
			// 中途崩溃会留下「有记录无块」的路径,下次 prepare 判定磁盘与记录都不匹配而拒绝。
			// 在把两阶段(先落盘、再写记录)做完之前,不启用批量通道。
			const batch: Array<{ path: string; entry: ThreadQueueEntry }> = [];
			if (batch.length > 1) {
				// 先出队再处理:留在队列里会被下一轮重复取出(死循环)。
				for (const item of batch) this.queue.delete(item.path);
				this.activeCount = batch.length;
				try {
					const contents: Array<{ path: string; content: string }> = [];
					for (const item of batch) contents.push({ path: item.path, content: await this.vault.readFile(item.path) });
					const results = await this.client.indexFiles!(contents);
					const done = new Set(results.map((item) => item.path));
					for (const item of batch) {
						if (done.has(item.path)) {
							this.markSuccess(item.path);
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
					await this.client.deleteFile(filePath);
				} else {
					const content = await this.vault.readFile(filePath);
					await this.client.indexFile(filePath, content);
				}
				this.markSuccess(filePath);
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
				} else {
					// 失败保留在集合里,不能当成已处理;同一文件重排队由上层事件驱动。
					this.failedOps.set(filePath, entry.op);
					if (!this.failing.has(filePath)) {
						// 关键路径:每个文件只记一次,避免重试把日志刷满;样本用于定位具体文件。
						if (this.failureSamples.length < MAX_FAILURE_SAMPLES) {
							this.failureSamples.push({ path: filePath, message });
						}
						devLogger.warn('index', `线程索引失败:${filePath}:${message}`);
					}
					this.failing.add(filePath);
				}
			} finally {
				this.activeCount = 0;
			}
		}
	}
}
