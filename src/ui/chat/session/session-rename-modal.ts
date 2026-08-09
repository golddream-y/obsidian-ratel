/**
 * @file src/ui/chat/session/session-rename-modal.ts
 * @description 会话标题编辑 Modal — 手改保存，或交给 AI 重新总结
 * @module ui/chat/session/session-rename-modal
 * @depends obsidian, i18n, ./session-title
 */

import { Modal, type App } from 'obsidian';
import { tNow } from '../../../i18n';
import { FULL_TITLE_MAX, normalizeTitlePair, type SessionTitlePair } from './session-title';

/** 弹窗关闭结果：手改 / 请求 AI 总结 / 取消 */
export type SessionRenameResult =
	| { kind: 'save'; pair: SessionTitlePair }
	| { kind: 'retitle' }
	| null;

/**
 * 弹出简洁标题编辑框。
 *
 * @param app - Obsidian App
 * @param currentTitle - 当前正常标题
 * @returns 保存时返回双轨标题；点 AI 总结返回 retitle；取消为 null
 */
export async function showSessionRenameModal(
	app: App,
	currentTitle: string,
): Promise<SessionRenameResult> {
	return new Promise((resolve) => {
		const modal = new SessionRenameModal(app, currentTitle, resolve);
		modal.open();
	});
}

class SessionRenameModal extends Modal {
	private settled = false;
	private value: string;
	private inputEl: HTMLInputElement | null = null;

	constructor(
		app: App,
		currentTitle: string,
		private onResolve: (result: SessionRenameResult) => void,
	) {
		super(app);
		this.value = currentTitle;
	}

	private settle(result: SessionRenameResult): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve(result);
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		modalEl.addClass('ratel-session-rename-modal');
		titleEl.setText(tNow('chat.session.renameTitle'));

		this.inputEl = contentEl.createEl('input', {
			cls: 'ratel-session-rename-input',
			type: 'text',
			attr: {
				maxlength: String(FULL_TITLE_MAX + 4),
				placeholder: tNow('chat.session.renamePlaceholder', {
					max: String(FULL_TITLE_MAX),
				}),
				'aria-label': tNow('chat.session.renameField'),
			},
		});
		this.inputEl.value = this.value;
		this.inputEl.addEventListener('input', () => {
			this.value = this.inputEl?.value ?? '';
		});
		this.inputEl.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				this.submitSave();
			}
		});

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: tNow('chat.session.renameCancel') }).onclick = () => {
			this.settle(null);
			this.close();
		};
		btnRow.createEl('button', { text: tNow('chat.session.retitle') }).onclick = () => {
			this.settle({ kind: 'retitle' });
			this.close();
		};
		const save = btnRow.createEl('button', { text: tNow('chat.session.renameSave') });
		save.classList.add('mod-cta');
		save.onclick = () => this.submitSave();

		window.setTimeout(() => {
			this.inputEl?.focus();
			this.inputEl?.select();
		}, 0);
	}

	private submitSave(): void {
		const empty = tNow('chat.session.emptyTitle');
		const trimmed = this.value.trim();
		if (!trimmed) {
			this.settle(null);
			this.close();
			return;
		}
		this.settle({
			kind: 'save',
			pair: normalizeTitlePair({ title: trimmed }, empty),
		});
		this.close();
	}

	onClose(): void {
		this.settle(null);
		this.contentEl.empty();
	}
}
