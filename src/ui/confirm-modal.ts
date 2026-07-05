/**
 * @file src/ui/confirm-modal.ts
 * @description 危险操作确认 Modal — reindex / dropIndex 等需要二次确认的场景
 * @module ui/confirm-modal
 * @depends obsidian
 */

import { App, Modal, Notice, Setting } from 'obsidian';

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
	modal.titleEl.setText('重建索引(全量)');

	new Setting(modal.contentEl)
		.setName('确认重建索引?')
		.setDesc('将删除并重建整个索引,耗时较长,期间搜索不可用。');

	new Setting(modal.contentEl)
		.addButton((btn) => {
			btn.setButtonText('取消').onClick(() => modal.close());
		})
		.addButton((btn) => {
			btn.setButtonText('确认重建')
				.setCta()
				.onClick(async () => {
					modal.close();
					try {
						await onConfirm();
					} catch (err) {
						// 关键路径:Modal 已关,异常只能走 Notice 反馈,避免静默吞错
						new Notice(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
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
	modal.titleEl.setText('清空索引(危险操作)');

	new Setting(modal.contentEl)
		.setName('确认清空整个索引?')
		.setDesc('将删除所有向量数据,需重新全量索引才能恢复搜索。此操作不可撤销。');

	let input = '';
	let confirmBtn: HTMLButtonElement | null = null;

	new Setting(modal.contentEl)
		.setName('请输入 "DELETE" 确认')
		.addText((text) => {
			text.setValue('').onChange((v) => {
				input = v;
				// 关键路径:只有输入 DELETE 才解锁确认按钮,防误触
				if (confirmBtn) confirmBtn.disabled = v !== 'DELETE';
			});
		});

	new Setting(modal.contentEl)
		.addButton((btn) => {
			btn.setButtonText('取消').onClick(() => modal.close());
		})
		.addButton((btn) => {
			btn.setButtonText('清空索引')
				.setDestructive()
				.setDisabled(true)
				.onClick(async () => {
					// 关键路径:双保险 — 按钮 disabled 已防住,这里再校验一次
					if (input !== 'DELETE') return;
					modal.close();
					try {
						await onConfirm();
					} catch (err) {
						// 关键路径:Modal 已关,异常只能走 Notice 反馈,避免静默吞错
						new Notice(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
					}
				});
			confirmBtn = btn.buttonEl;
		});

	modal.open();
}
