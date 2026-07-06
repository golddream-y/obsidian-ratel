/**
 * @file src/ui/confirm-modal.ts
 * @description 工具执行确认对话框
 * @module ui/confirm-modal
 * @depends obsidian, ../../ports/llm, ../../core/tool-permissions, ../../i18n
 */

import { Modal, type App } from 'obsidian';
import type { ToolCall } from '../../ports/llm';
import { summarizeToolCall, type ToolConfirmResult } from '../../core/tool-permissions';
// 关键路径:Modal 在工具调用时创建,tNow 同步读即可
import { tNow } from '../../i18n';

export function showToolConfirmModal(app: App, toolCall: ToolCall): Promise<ToolConfirmResult> {
	return new Promise((resolve) => {
		const modal = new ToolConfirmModal(app, toolCall, resolve);
		modal.open();
	});
}

class ToolConfirmModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private toolCall: ToolCall,
		private onResolve: (result: ToolConfirmResult) => void,
	) {
		super(app);
	}

	private settle(result: ToolConfirmResult): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve(result);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(tNow('modal.toolConfirm.title', { name: this.toolCall.name }));
		contentEl.createEl('p', { text: summarizeToolCall(this.toolCall) });
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: tNow('modal.toolConfirm.allow') }).onclick = () => {
			this.settle('allow');
			this.close();
		};
		btnRow.createEl('button', { text: tNow('modal.toolConfirm.allowSession') }).onclick = () => {
			this.settle('session');
			this.close();
		};
		btnRow.createEl('button', { text: tNow('modal.toolConfirm.deny') }).onclick = () => {
			this.settle('deny');
			this.close();
		};
	}

	onClose(): void {
		// 关键路径:ESC / 点遮罩关闭时视为拒绝,避免 agentLoop 永久 await。
		this.settle('deny');
		this.contentEl.empty();
	}
}
