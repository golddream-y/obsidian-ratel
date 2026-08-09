/**
 * @file src/ui/chat/session/session-switch-confirm.ts
 * @description 生成中切换/新建会话确认 — 避免默默 abort
 * @module ui/chat/session/session-switch-confirm
 * @depends obsidian, i18n
 */

import { Modal, type App } from 'obsidian';
import { tNow } from '../../../i18n';

/**
 * 正在生成时询问是否切换（会停止当前生成）。
 *
 * @param app - Obsidian App
 * @returns true = 确认停止并切换；false = 留下继续生成
 */
export async function showSessionSwitchConfirm(app: App): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new SessionSwitchConfirmModal(app, resolve);
		modal.open();
	});
}

class SessionSwitchConfirmModal extends Modal {
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
		titleEl.setText(tNow('chat.session.switchWhileRunningTitle'));
		contentEl.createEl('p', { text: tNow('chat.session.switchWhileRunningBody') });
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: tNow('chat.session.switchAbortConfirm') }).onclick = () => {
			this.settle(true);
			this.close();
		};
		const stay = btnRow.createEl('button', { text: tNow('chat.session.switchAbortCancel') });
		stay.classList.add('mod-cta');
		stay.onclick = () => {
			this.settle(false);
			this.close();
		};
	}

	onClose(): void {
		this.settle(false);
		this.contentEl.empty();
	}
}
