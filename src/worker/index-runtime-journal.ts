/**
 * @file src/worker/index-runtime-journal.ts
 * @description 索引线程内的写所有权与文件日志装配 — 让日志与完成记录也在 Worker 内落盘
 * @module src/worker/index-runtime-journal
 *
 * 关键路径:
 * - Worker 不自己发明写权:epoch 由宿主在 init 时授予,撤销后本线程内所有写入口立即失败。
 * - 提交登记(`beginCommit`)只做在途计数,用于交接前判断是否还有未结算提交。
 * - 日志、原子存储与存储都在本线程构造,主线程不再承担每条完成记录的 fsync。
 */

import { AtomicIndexStorage } from '../adapters/atomic-index-storage';
import { IndexFileJournal, type JournalWriteOwner } from '../core/index-file-journal';
import type { FileReplaceStore } from '../adapters/vector-vectra';

/** 写权错误码。 */
export type WorkerOwnerErrorCode = 'epoch-revoked';

/** 写权错误。 */
export class WorkerOwnerError extends Error {
	constructor(readonly code: WorkerOwnerErrorCode, message: string) {
		super(message);
		this.name = 'WorkerOwnerError';
	}
}

/** Worker 侧写所有权 — epoch 来自宿主授权,撤销后拒绝一切写。 */
export class WorkerJournalOwner implements JournalWriteOwner {
	private revokedReason: string | null = null;
	private inflight = 0;

	constructor(readonly epoch: number) {}

	/** 是否已撤销。 */
	get revoked(): boolean {
		return this.revokedReason !== null;
	}

	/** 未结算的提交数;交接前必须为 0。 */
	get inflightCommits(): number {
		return this.inflight;
	}

	/**
	 * 撤销写权。
	 * @param reason 撤销原因
	 */
	revoke(reason: string): void {
		this.revokedReason ??= reason;
	}

	/** 断言仍持有写权;撤销后立即失败,不静默降级。 */
	assertWritable(): void {
		if (this.revokedReason !== null) {
			throw new WorkerOwnerError('epoch-revoked', `写所有权已撤销: ${this.revokedReason}`);
		}
	}

	/**
	 * 登记一次在途提交。
	 * @returns 结算凭据;重复结算不重复减计数
	 */
	beginCommit(): { settle(): void } {
		this.assertWritable();
		this.inflight += 1;
		let settled = false;
		return {
			settle: () => {
				if (settled) return;
				settled = true;
				this.inflight = Math.max(0, this.inflight - 1);
			},
		};
	}
}

/** 日志装配参数。 */
export interface WorkerJournalOptions {
	/** 代际根绝对路径。 */
	generationRoot: string;
	/** 代际 ID。 */
	generationId: string;
	/** 配置指纹。 */
	configFingerprint: string;
	/** 存储(T2 替换契约)。 */
	store: FileReplaceStore;
	/** 写所有权。 */
	owner: JournalWriteOwner;
	/** 期望向量维度。 */
	expectedDimension?: number;
	/** 与存储共用的原子存储;缺省按代际根新建。 */
	storage?: AtomicIndexStorage;
}

/**
 * 在 Worker 内构造文件日志。
 * @param options 代际、配置与存储
 */
export function createWorkerJournal(options: WorkerJournalOptions): IndexFileJournal {
	const storage: AtomicIndexStorage = options.storage ?? new AtomicIndexStorage({ generationRoot: options.generationRoot });
	return new IndexFileJournal({
		generationRoot: options.generationRoot,
		generationId: options.generationId,
		configFingerprint: options.configFingerprint,
		owner: options.owner,
		store: options.store,
		storage: storage,
		expectedDimension: options.expectedDimension,
	});
}
