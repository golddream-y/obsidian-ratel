/**
 * @file src/user-feedback/user-status.ts
 * @description 使用者持久状态 store — 供 StatusBar 订阅,禁止 console / Notice
 * @module user-feedback/user-status
 * @depends svelte/store
 */

import { writable } from 'svelte/store';

/** Chat 侧栏 StatusBar 展示的聚合快照 */
export interface UserStatusSnapshot {
	model: 'idle' | 'checking' | 'downloading' | 'initializing' | 'ready' | 'failed';
	modelDetail?: string;

	index: 'idle' | 'init' | 'scanning' | 'queueing' | 'processing' | 'ready' | 'paused' | 'failed';
	indexDetail?: string;
	indexDocCount?: number;

	embedding: 'loading' | 'ready' | 'unavailable';
	worker: 'thread' | 'inline';

	/** 降级说明,有人话一行;存在时状态条展开 */
	degraded?: string;
}

/** 插件启动时的默认快照 — model/index 空闲,embedding 加载中,Worker 默认 inline */
export const DEFAULT_USER_STATUS: UserStatusSnapshot = {
	model: 'idle',
	index: 'idle',
	embedding: 'loading',
	worker: 'inline',
};

/**
 * 使用者持久状态 — 通过 statusBar$ 驱动 Chat 侧栏 StatusBar。
 *
 * 设计要点:
 * - 仅维护 Svelte writable store,不写 console、不触发 Notice
 * - patch 浅合并,供 FeedbackController 增量更新各子系统字段
 * - reset 在插件卸载时恢复初始快照
 *
 * @example
 * const userStatus = new UserStatus();
 * userStatus.patch({ model: 'ready', indexDocCount: 128 });
 */
export class UserStatus {
	readonly statusBar$ = writable<UserStatusSnapshot>({ ...DEFAULT_USER_STATUS });

	/**
	 * 浅合并更新 statusBar$ 中的部分字段。
	 *
	 * @param partial - 要覆盖的字段子集
	 */
	patch(partial: Partial<UserStatusSnapshot>): void {
		this.statusBar$.update((current) => ({ ...current, ...partial }));
	}

	/**
	 * 将 statusBar$ 恢复为 DEFAULT_USER_STATUS。
	 */
	reset(): void {
		this.statusBar$.set({ ...DEFAULT_USER_STATUS });
	}
}
