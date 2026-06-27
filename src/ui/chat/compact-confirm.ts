/**
 * @file src/ui/compact-confirm.ts
 * @description 压缩上下文确认弹窗 — 直接基于 Obsidian Modal,settle-then-close 模式
 * @module ui/compact-confirm
 * @depends obsidian
 */

import { Modal, type App } from 'obsidian';

/**
 * 弹出压缩上下文确认框 — 用户选"压缩"返回 true,否则 false。
 *
 * 关键路径:复用 confirm-modal.ts 的 settle-then-close 模式:
 * 按钮 onclick 先 settle() 再 close(),避免 onClose() 在 settle 之前抢先 resolve('deny')。
 *
 * @param app - Obsidian App 实例
 * @returns true 表示用户确认压缩;false 表示取消
 */
export async function showCompactConfirm(app: App): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const modal = new CompactConfirmModal(app, resolve);
		modal.open();
	});
}

/**
 * 压缩确认 Modal — settle-then-close 模式实现。
 *
 * 设计要点:
 * - settled 标志位防止重复 resolve
 * - onClose 兜底 settle(false),处理 ESC / 点遮罩关闭场景
 */
class CompactConfirmModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private onResolve: (ok: boolean) => void,
	) {
		super(app);
	}

	private settle(ok: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve(ok);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText('压缩上下文');
		contentEl.createEl('p', {
			text: '将清空历史消息,仅保留最近 2 条。此操作不可撤销,是否继续?',
		});
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: '压缩' }).onclick = () => {
			// 关键路径:先 settle 再 close,避免 onClose 抢先 resolve(false)
			this.settle(true);
			this.close();
		};
		btnRow.createEl('button', { text: '取消' }).onclick = () => {
			this.settle(false);
			this.close();
		};
	}

	onClose(): void {
		// 关键路径:ESC / 点遮罩关闭视为取消,兜底 settle(false)
		this.settle(false);
		this.contentEl.empty();
	}
}
