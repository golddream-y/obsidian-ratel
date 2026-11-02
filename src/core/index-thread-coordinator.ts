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
	deleteFile(filePath: string): Promise<{ removed: number }>;
	recover(inputs: ReadonlyArray<{ path: string; hash: string | null }>): Promise<{ pending: number; decisions: number; failures: number }>;
	close(reason?: string): Promise<void>;
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
		await this.client.start(this.startOptions);

		const files = this.vault.listMarkdownFiles();
		for (const filePath of files) {
			if (this.stopping || this.destroyed) break;
			this.queue.set(filePath, { op: 'upsert' });
		}
		this.scanCompleted = true;
		this.phaseValue = 'processing';
		await this.drain();
		// 关键路径:暂停与撤销优先于「全部成功」—— 不能因为已处理的部分成功就报告 ready。
		if (this.stopping) this.phaseValue = 'stopping';
		else if (this.pausedValue) this.phaseValue = 'paused';
		else if (this.failing.size > 0) this.phaseValue = 'partial-failure';
		else this.phaseValue = 'ready';
		this.running = false;
		return this.counters();
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

	/** 收敛队列;暂停或销毁时提前返回。 */
	async drain(): Promise<void> {
		if (this.loop !== null) return this.loop;
		this.loop = this.runLoop();
		try {
			await this.loop;
		} finally {
			this.loop = null;
		}
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
		void reason;
		this.stopping = true;
		this.phaseValue = 'stopping';
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

	/** 逐文件消费队列。 */
	private async runLoop(): Promise<void> {
		for (;;) {
			if (this.destroyed) return;
			if (this.pausedValue || this.stopping) return;
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
				this.verified.add(filePath);
				this.failing.delete(filePath);
			} catch (error) {
				void error;
				// 关键路径:失败保留在集合里,不能当成已处理;同一文件重排队由上层事件驱动。
				this.failing.add(filePath);
			} finally {
				this.activeCount = 0;
			}
		}
	}
}
