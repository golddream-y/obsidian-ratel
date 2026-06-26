/**
 * @file src/user-feedback/user-status.ts
 * @description 使用者持久状态 store — 供 StatusLine/StatusDrawer 订阅,禁止 console / Notice
 * @module user-feedback/user-status
 * @depends svelte/store
 */

import { writable } from 'svelte/store';

/** Chat 侧栏 StatusLine / StatusDrawer 展示的聚合快照 */
export interface UserStatusSnapshot {
	model: 'idle' | 'checking' | 'downloading' | 'initializing' | 'ready' | 'failed';
	modelDetail?: string;

	index: 'idle' | 'init' | 'scanning' | 'queueing' | 'processing' | 'ready' | 'paused' | 'failed';
	indexDetail?: string;
	indexDocCount?: number;

	embedding: 'loading' | 'ready' | 'unavailable';
	worker: 'thread' | 'inline';

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
