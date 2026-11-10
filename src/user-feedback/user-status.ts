/**
 * @file src/user-feedback/user-status.ts
 * @description 使用者持久状态 store — 供 StatusLine/StatusDrawer 订阅,禁止 console / Notice
 * @module user-feedback/user-status
 * @depends svelte/store
 */

import { writable } from 'svelte/store';
import type { IndexPhase } from '../core/index-persistence-types';

/**
 * 索引展示阶段 — T4/T5 的协调器阶段,外加 T6 的「迁移中」。
 *
 * 关键路径:`IndexPhase` 是任务阶段的事实源(含 `stalled`/`stopping`);`migrating` 由宿主
 * 装配层提供(旧索引迁移/迁移后逐文件核对),不属于单一任务阶段,故作为展示层扩展。
 */
export type UserIndexPhase = IndexPhase | 'migrating';

/**
 * 索引须知 — 需要如实告知用户但不能改变 `index` 状态语义的补充事实。
 *
 * 关键路径:`unjudgeable` 的记录集与「0 篇可检索」是两件不同的事;缺少 epoch 保护同样是
 * 必须上屏的事实,不允许静默通过。
 *
 * 说明:`reverifying`(重新核对)不是须知 —— 它是 `Queueing` 状态的详情文案
 * (`status.detail.reverifying`),由 `indexDetail` 承载;把它放进须知枚举会留下一个
 * 永远没有生产者的不可达分支,故移除(枚举项删除,i18n 键保留给它原本的用途)。
 */
export const INDEX_NOTICES = [
	'resumed',
	'stalled',
	'stopping',
	'migrating',
	'disk-failure',
	'epoch-missing',
	'records-unknown',
	'config-mismatch',
	/** 索引运行时装配失败(降级)— 索引不可用但插件其余能力照常,可重试装配。 */
	'index-unavailable',
	/** 会话内嵌入配置变更 — 为避免新旧参数混写,索引写入已暂停。 */
	'config-drift',
] as const;

/** 索引须知。 */
export type IndexNotice = (typeof INDEX_NOTICES)[number];

/**
 * 索引迁移/回收的可报告结论 — 诊断落点,不参与 `index` 状态语义。
 *
 * 关键路径(T7/I4):孤儿目录数、取证事务数、迁移状态是否落盘、新建被阻断的原因与代际隔离原因
 * 原本只出现在 `devLogger` 里;这里给它们一个**可查看的落点**(状态抽屉的诊断行),只放结论面,
 * 不含笔记正文、路径清单或密钥。
 */
export interface IndexConclusionDiagnostics {
	/** 迁移结论;未发生迁移时为 undefined。 */
	migration?: {
		/** 迁移阶段(`inspect` / `copy` / `receipts` / `publish` / `done`)。 */
		phase: string;
		/** 可复用的文件数。 */
		reused: number;
		/** 需重算的文件数。 */
		reindex: number;
		/** 迁移进度状态是否已落盘(`published=true` 而它为 false 是独立结论)。 */
		statePersisted: boolean;
	};
	/** 回收结论;未触发「新建前回收」路径时为 undefined。 */
	reconcile?: {
		/** 本次已回收的孤儿代际目录数。 */
		orphanDirectories: number;
		/** 被保留(有未决事务/隔离)的代际数。 */
		retained: number;
		/** 本次保留的取证事务目录总数。 */
		quarantinedTransactions: number;
		/** 是否因无法回收而阻断新建。 */
		blocked: boolean;
		/** 阻断原因;未阻断时为 null。 */
		blockedReason: string | null;
	};
	/** 受影响代际的隔离原因(`generationId:reason`),无隔离时为空数组。 */
	quarantinedGenerations: string[];
}

/** Chat 侧栏 StatusLine / StatusDrawer 展示的聚合快照 */
export interface UserStatusSnapshot {
	model: 'idle' | 'checking' | 'downloading' | 'initializing' | 'ready' | 'failed';
	modelDetail?: string;

	index: 'idle' | 'init' | 'diffing' | 'scanning' | 'queueing' | 'processing' | 'ready' | 'paused' | 'failed';
	indexDetail?: string;
	indexDocCount?: number;
	/** 当前索引阶段(含协调器的 stalled/stopping 与宿主的 migrating)。 */
	indexPhase?: UserIndexPhase;
	/** 索引须知;需要用户知道但不改变 index 状态语义的补充事实。 */
	indexNotice?: IndexNotice;
	/** 索引尚未收敛但已有可检索版本。 */
	indexPartial?: boolean;
	/** 本轮已知文件总数。 */
	indexTotalFiles?: number;
	/** 已提交且可检索的文件数。 */
	indexCommittedFiles?: number;
	/** 当前索引速率(块/秒) — 只由真实提交计数滑动窗口推导;样本不足或纯核对时 undefined。 */
	indexBlocksPerSecond?: number;
	/** 本轮已写入向量存储的块数（块已落盘，完成记录未必已提交）。 */
	indexStoredBlocks?: number;
	/** 本轮已完成记录提交的块数 — 「已写」进度与速率都基于它。 */
	indexCommittedBlocks?: number;
	/** 本轮按完成记录复用的块数（内容未变，未推理）。 */
	indexReusedBlocks?: number;
	/** 嵌入阶段分母：已完成分块的实际块数 + 尚未分块文件的预估块数。 */
	indexTotalBlocks?: number;
	/** 分母是否仍含预估（未分块文件按完成记录 chunkCount 估算）。 */
	indexBlocksEstimated?: boolean;
	/** 发现阶段：内容未变、按完成记录复用的篇数。 */
	indexSkippedFiles?: number;
	/** 发现阶段：本轮新增的篇数。 */
	indexAddedFiles?: number;
	/** 发现阶段：本轮内容变化的篇数。 */
	indexChangedFiles?: number;
	/** 发现阶段：本轮失效（删除）的篇数。 */
	indexRemovedFiles?: number;
	/** 待处理(队列 + 在途 + 未决事务)文件数。 */
	indexPendingFiles?: number;
	/** 是否处于「恢复已索引进度」阶段（重启后核对完成记录期间）。 */
	indexRestoring?: boolean;
	/** 已核对（按完成记录复用）的篇数。 */
	indexRestoredFiles?: number;
	/** 本轮启动时磁盘上的完成记录总数 — 恢复进度的分母。 */
	indexRestoredTotal?: number;
	/** 本轮未清除的失败数(按路径)。 */
	indexFailedFiles?: number;
	/** 迁移/回收的可报告结论 — 诊断落点(T7/I4),只放结论面。 */
	indexDiagnostics?: IndexConclusionDiagnostics;

	embedding: 'loading' | 'ready' | 'unavailable';
	worker: 'thread' | 'inline';
	/**
	 * 本地嵌入实际使用的执行后端。
	 *
	 * 关键路径:用户需要知道推理跑在 GPU 还是 CPU 上 —— 这直接决定索引快慢,
	 * 也决定「为什么换台机器会变慢」。仅本地向量有值,远端服务为 undefined。
	 */
	embeddingBackend?: 'wasm' | 'webgpu';

	/** 降级说明,有人话一行;存在时 StatusDrawer 降级区显示 */
	degraded?: string;
}

/** 上下文使用率快照 — 由 context-manager 在 send 前后更新,StatusLine/StatusDrawer 订阅 */
export interface ContextUsage {
	/** 已用 token 数(含系统提示 + 检索结果 + 历史) */
	usedTokens: number;
	/** 模型上下文窗口上限(由 settings.chatModelMaxTokens 提供) */
	maxTokens: number;
	/** 待发送附件估算 token 数 */
	attachmentTokens: number;
	/** 派生:usedTokens / maxTokens * 100,maxTokens=0 时为 0 */
	percentage: number;
	/** 数据来源,用于 StatusLine 样式区分(可选,旧调用方不传等同 'estimate') */
	source?: 'estimate' | 'streaming' | 'api';
}

/** 待发送的图片附件 */
export interface PendingAttachment {
	id: string;
	fileName: string;
	mimeType: string;
	base64: string;
	estimatedTokens: number;
}

/** 插件启动时的默认快照 — model/index 空闲,embedding 加载中,Worker 默认 inline */
export const DEFAULT_USER_STATUS: UserStatusSnapshot = {
	model: 'idle',
	index: 'idle',
	embedding: 'loading',
	worker: 'inline',
};

/** ContextUsage 默认值 — 0/0,percentage 防除零返回 0 */
export const DEFAULT_CONTEXT_USAGE: ContextUsage = {
	usedTokens: 0,
	maxTokens: 0,
	attachmentTokens: 0,
	percentage: 0,
};

/**
 * 使用者持久状态 — 通过 statusBar$ / contextUsage$ / pendingAttachments$ 驱动 Chat UI。
 *
 * 设计要点:
 * - 仅维护 Svelte writable store,不写 console、不触发 Notice
 * - patch 浅合并,供 FeedbackController 增量更新各子系统字段
 * - reset 在插件卸载时恢复全部初始快照
 *
 * @example
 * const userStatus = new UserStatus();
 * userStatus.patch({ model: 'ready', indexDocCount: 128 });
 * userStatus.patchContextUsage({ usedTokens: 1000, maxTokens: 32000 });
 */
export class UserStatus {
	readonly statusBar$ = writable<UserStatusSnapshot>({ ...DEFAULT_USER_STATUS });
	readonly contextUsage$ = writable<ContextUsage>({ ...DEFAULT_CONTEXT_USAGE });
	readonly pendingAttachments$ = writable<PendingAttachment[]>([]);

	/**
	 * 浅合并更新 statusBar$ 中的部分字段。
	 *
	 * @param partial - 要覆盖的字段子集
	 */
	patch(partial: Partial<UserStatusSnapshot>): void {
		this.statusBar$.update((current) => ({ ...current, ...partial }));
	}

	/**
	 * 更新 contextUsage$ — 自动重算 percentage(防除零)。
	 *
	 * @param partial - 至少含 usedTokens 或 maxTokens 之一
	 */
	patchContextUsage(partial: Partial<Omit<ContextUsage, 'percentage'>>): void {
		this.contextUsage$.update((current) => {
			const next = { ...current, ...partial };
			next.percentage = next.maxTokens > 0 ? Math.round((next.usedTokens / next.maxTokens) * 100) : 0;
			return next;
		});
	}

	/**
	 * 追加一个待发送附件,返回生成的 id。
	 *
	 * @param attachment - 不含 id 的附件对象
	 * @returns 附件 id(用于 removeAttachment)
	 */
	addAttachment(attachment: Omit<PendingAttachment, 'id'>): string {
		const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.pendingAttachments$.update((list) => [...list, { ...attachment, id }]);
		return id;
	}

	/**
	 * 按 id 移除待发送附件。
	 *
	 * @param id - addAttachment 返回的 id
	 */
	removeAttachment(id: string): void {
		this.pendingAttachments$.update((list) => list.filter((a) => a.id !== id));
	}

	/** 清空全部待发送附件(发送成功后调用)。 */
	clearAttachments(): void {
		this.pendingAttachments$.set([]);
	}

	/**
	 * 将全部 store 恢复为默认值 — 插件卸载或 /new 命令时调用。
	 */
	reset(): void {
		this.statusBar$.set({ ...DEFAULT_USER_STATUS });
		this.contextUsage$.set({ ...DEFAULT_CONTEXT_USAGE });
		this.pendingAttachments$.set([]);
	}
}
