/**
 * @file src/ui/confirm-modal.ts
 * @description 危险操作确认 Modal — reindex / dropIndex 等需要二次确认的场景
 * @module ui/confirm-modal
 * @depends obsidian, ../../i18n
 */

import { App, Modal, Notice, Setting } from 'obsidian';
// 关键路径:Modal 在用户操作时创建,tNow 同步读即可
import { tNow } from '../i18n';

/**
 * 显示重建索引确认 Modal。
 *
 * 关键路径:reindex 会清空并重建整个索引,耗时较长,必须用户二次确认。
 *
 * @param app - Obsidian App 实例
 * @param onConfirm - 用户确认后回调(同步或异步)
 */
export function showReindexConfirm(app: App, onConfirm: () => void | Promise<void>): void {
	const modal = new Modal(app);
	modal.titleEl.setText(tNow('modal.rebuildIndex.title'));

	new Setting(modal.contentEl)
		.setName(tNow('modal.rebuildIndex.confirmQuestion'))
		.setDesc(tNow('modal.rebuildIndex.confirmDesc'));

	new Setting(modal.contentEl)
		.addButton((btn) => {
			btn.setButtonText(tNow('modal.rebuildIndex.cancel')).onClick(() => modal.close());
		})
		.addButton((btn) => {
			btn.setButtonText(tNow('modal.rebuildIndex.confirm'))
				.setCta()
				.onClick(async () => {
					modal.close();
					try {
						await onConfirm();
					} catch (err) {
						// 关键路径:Modal 已关,异常只能走 Notice 反馈,避免静默吞错
						new Notice(
							tNow('notice.operationFailed', {
								message: err instanceof Error ? err.message : String(err),
							}),
						);
					}
				});
		});

	modal.open();
}

/**
 * 显示清空索引确认 Modal — 要求用户输入 "DELETE" 才能确认。
 *
 * 关键路径:dropIndex 是不可逆操作,需强校验(输入 DELETE)防止误触。
 *
 * @param app - Obsidian App 实例
 * @param onConfirm - 用户确认后回调(同步或异步)
 */
export function showDropIndexConfirm(app: App, onConfirm: () => void | Promise<void>): void {
	const modal = new Modal(app);
	modal.titleEl.setText(tNow('modal.dropIndex.title'));

	new Setting(modal.contentEl)
		.setName(tNow('modal.dropIndex.confirmQuestion'))
		.setDesc(tNow('modal.dropIndex.confirmDesc'));

	let input = '';
	let confirmBtn: HTMLButtonElement | null = null;

	new Setting(modal.contentEl)
		.setName(tNow('modal.dropIndex.inputPrompt'))
		.addText((text) => {
			text.setValue('').onChange((v) => {
				input = v;
				// 关键路径:只有输入 confirmWord 才解锁确认按钮,防误触
				if (confirmBtn) confirmBtn.disabled = v !== tNow('modal.dropIndex.confirmWord');
			});
		});

	new Setting(modal.contentEl)
		.addButton((btn) => {
			btn.setButtonText(tNow('modal.dropIndex.cancel')).onClick(() => modal.close());
		})
		.addButton((btn) => {
			btn.setButtonText(tNow('modal.dropIndex.confirm'))
				.setDestructive()
				.setDisabled(true)
				.onClick(async () => {
					// 关键路径:双保险 — 按钮 disabled 已防住,这里再校验一次
					if (input !== tNow('modal.dropIndex.confirmWord')) return;
					modal.close();
					try {
						await onConfirm();
					} catch (err) {
						// 关键路径:Modal 已关,异常只能走 Notice 反馈,避免静默吞错
						new Notice(
							tNow('notice.operationFailed', {
								message: err instanceof Error ? err.message : String(err),
							}),
						);
					}
				});
			confirmBtn = btn.buttonEl;
		});

	modal.open();
}
