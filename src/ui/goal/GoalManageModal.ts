/**
 * @file src/ui/goal/GoalManageModal.ts
 * @description 目标管理 Modal — 与记忆管理并列的列表壳,不混进 MemoryPanel
 * @module ui/goal/GoalManageModal
 * @depends obsidian, ui/settings/goal-setting-page, i18n
 */

import { App, Modal } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { tNow } from '../../i18n';
import { applyRatelAppearance } from '../appearance/apply-ratel-appearance';
import { renderGoalSettingsSection } from '../settings/goal-setting-page';

/**
 * 是否应新建目标管理 Modal — 已有实例则 false。
 *
 * @param current - 插件持有的当前 GoalManageModal 单例引用
 * @returns 无实例时 true
 */
export function shouldCreateGoalManageModal(current: GoalManageModal | null): boolean {
	return current === null;
}

/**
 * 目标列表 Modal。
 *
 * 设计要点:
 * - 列表仍走 renderGoalSettingsSection,设置页不再嵌这段 DOM
 * - 单例由 plugin.openGoalManageModal 持有,避免叠窗
 */
export class GoalManageModal extends Modal {
	/** 关闭时回调,供 plugin 清掉单例引用 */
	onClosed: (() => void) | null = null;

	constructor(
		app: App,
		private plugin: RatelVaultPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('goal.manage.title'));
		this.modalEl.addClass('ratel-goal-manage-modal-shell');
		this.contentEl.empty();
		this.contentEl.addClass('ratel-goal-manage-modal');
		applyRatelAppearance(this.contentEl, {
			uiColorScheme: this.plugin.settings.uiColorScheme,
			uiAccent: this.plugin.settings.uiAccent,
		});
		void renderGoalSettingsSection(this.contentEl, this.plugin);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed?.();
		this.onClosed = null;
	}
}
