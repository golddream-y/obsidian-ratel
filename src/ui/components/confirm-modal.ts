/**
 * @file src/ui/confirm-modal.ts
 * @description 工具执行确认对话框
 * @module ui/confirm-modal
 */

import { Modal, type App } from 'obsidian';
import type { ToolCall } from '../../ports/llm';
import { summarizeToolCall, type ToolConfirmResult } from '../../core/tool-permissions';

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
		titleEl.setText(`确认工具调用: ${this.toolCall.name}`);
		contentEl.createEl('p', { text: summarizeToolCall(this.toolCall) });
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: '允许' }).onclick = () => {
			this.settle('allow');
			this.close();
		};
		btnRow.createEl('button', { text: '允许(本次会话不再询问)' }).onclick = () => {
			this.settle('session');
			this.close();
		};
		btnRow.createEl('button', { text: '拒绝' }).onclick = () => {
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
