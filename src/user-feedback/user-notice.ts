/**
 * @file src/user-feedback/user-notice.ts
 * @description 使用者专用 Notice — 禁止 console
 * @module user-feedback/user-notice
 */

import { Notice } from 'obsidian';

/**
 * Obsidian Notice 封装 — 供 FeedbackController 在全局里程碑向用户展示 toast。
 *
 * 设计要点:
 * - 仅依赖 obsidian Notice,不写 console
 * - toast / toastError 为一次性提示,toastProgress 为 duration=0 的可更新进度条
 *
 * @example
 * const userNotice = new UserNotice();
 * userNotice.toast('索引完成');
 * const progress = userNotice.toastProgress('下载中 0%');
 * progress.update('下载中 50%');
 * progress.hide();
 */
export class UserNotice {
	/**
	 * 展示普通 toast 提示。
	 *
	 * @param message - 面向用户的简短文案
	 * @param durationMs - 自动消失时长,默认 4000ms
	 */
	toast(message: string, durationMs = 4000): void {
		new Notice(message, durationMs);
	}

	/**
	 * 展示错误 toast,默认停留更久以便用户阅读。
	 *
	 * @param message - 面向用户的可行动错误文案
	 * @param durationMs - 自动消失时长,默认 8000ms
	 */
	toastError(message: string, durationMs = 8000): void {
		new Notice(message, durationMs);
	}

	/**
	 * 展示可更新的长任务进度 Notice(duration=0,需手动 hide)。
	 *
	 * @param initialMessage - 初始进度文案
	 * @returns update 更新文案; hide 关闭 Notice
	 */
	toastProgress(initialMessage: string): { update(message: string): void; hide(): void } {
		const n = new Notice(initialMessage, 0);
		return {
			update: (message: string) => n.setMessage(message),
			hide: () => n.hide(),
		};
	}
}
