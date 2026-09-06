/**
 * @file src/ui/settings/goal-setting-page.ts
 * @description 设置页 Goal 区块 — spec 4.11 面 5
 * @module ui/settings/goal-setting-page
 * @depends obsidian, main, core/goal-store, ui/goal/*
 */

import { Modal, Notice, Setting, type App } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import type { AgentGoal } from '../../core/goal-store';
import { truncateObjective } from '../goal/pick-continue-chip';
import { tNow } from '../../i18n';

/** Goal 设置区块 DOM id — 底栏/ chip 跳转锚点 */
export const GOAL_SETTINGS_SECTION_ID = 'ratel-goal-settings-section';

/**
 * 在声明式设置面板 agent Tab 内渲染 Goal 列表与操作。
 *
 * @param container - 父容器
 * @param plugin - 插件实例
 */
export async function renderGoalSettingsSection(
	container: HTMLElement,
	plugin: RatelVaultPlugin,
): Promise<void> {
	container.empty();
	container.id = GOAL_SETTINGS_SECTION_ID;

	const goals = await plugin.goalStore.list();
	const stale = await plugin.goalStore.listStaleTerminal(plugin.settings.goalArchiveDays);
	const staleIds = new Set(stale.map((g) => g.id));

	container.createEl('h3', { text: tNow('goal.settings.listHeading') });

	if (!goals.length) {
		container.createEl('p', {
			text: tNow('goal.settings.empty'),
			cls: 'setting-item-description',
		});
	} else {
		for (const goal of goals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
			renderGoalRow(container, plugin, goal, staleIds.has(goal.id));
		}
	}

	if (stale.length > 0) {
		container.createEl('h4', { text: tNow('goal.settings.staleHeading', { count: stale.length }) });
		new Setting(container)
			.setName(tNow('goal.settings.archiveAll'))
			.setDesc(tNow('goal.settings.archiveAllDesc', { count: stale.length }))
			.addButton((btn) => {
				btn.setButtonText(tNow('goal.settings.archiveAll'));
				btn.onClick(() => {
					void showArchiveAllConfirm(plugin.app, stale.length, async () => {
						for (const g of stale) {
							await plugin.goalStore.archive(g.id);
						}
						plugin.bumpGoalUi();
						await renderGoalSettingsSection(container, plugin);
					});
				});
			});
	}
}

function renderGoalRow(
	container: HTMLElement,
	plugin: RatelVaultPlugin,
	goal: AgentGoal,
	isStale: boolean,
): void {
	const row = container.createDiv({ cls: 'ratel-goal-row' });
	const title = `[${tNow(`goal.settings.status.${goal.status}`)}] ${truncateObjective(goal.objective, 40)}`;
	const meta = tNow('goal.settings.rowMeta', {
		rounds: `${goal.roundsDone}/${goal.maxRounds}`,
		input: goal.usage.inputTokens,
		output: goal.usage.outputTokens,
		updated: new Date(goal.updatedAt).toLocaleString(),
	});
	const setting = new Setting(row)
		.setName(title + (isStale ? ` (${tNow('goal.settings.staleTag')})` : ''))
		.setDesc(meta);

	if (goal.status === 'blocked' && goal.blockedReason) {
		row.createEl('p', {
			text: tNow('goal.settings.blockedReason', { reason: goal.blockedReason }),
			cls: 'setting-item-description',
		});
	}

	if (goal.status === 'active') {
		setting.addButton((btn) => {
			btn.setButtonText(tNow('goal.settings.pause'));
			btn.onClick(() => void transitionAndRefresh(plugin, goal.id, 'paused', container));
		});
	}
	if (goal.status === 'paused' || goal.status === 'blocked') {
		setting.addButton((btn) => {
			btn.setButtonText(tNow('goal.settings.resume'));
			btn.onClick(() => void activateAndRefresh(plugin, goal, container));
		});
		setting.addButton((btn) => {
			btn.setButtonText(tNow('goal.settings.cancel'));
			btn.onClick(() =>
				void showSingleArchiveConfirm(plugin.app, goal, 'cancelled', async () => {
					await plugin.goalStore.transition(goal.id, 'cancelled');
					plugin.bumpGoalUi();
					await renderGoalSettingsSection(container, plugin);
				}),
			);
		});
	}
	if (goal.status === 'completed' || goal.status === 'cancelled') {
		setting.addButton((btn) => {
			btn.setButtonText(tNow('goal.settings.archive'));
			btn.onClick(() =>
				void showSingleArchiveConfirm(plugin.app, goal, 'archive', async () => {
					await plugin.goalStore.archive(goal.id);
					plugin.bumpGoalUi();
					await renderGoalSettingsSection(container, plugin);
				}),
			);
		});
	}
}

async function transitionAndRefresh(
	plugin: RatelVaultPlugin,
	id: string,
	next: 'paused',
	container: HTMLElement,
): Promise<void> {
	await plugin.goalStore.transition(id, next);
	plugin.bumpGoalUi();
	await renderGoalSettingsSection(container, plugin);
}

async function activateAndRefresh(
	plugin: RatelVaultPlugin,
	goal: AgentGoal,
	container: HTMLElement,
): Promise<void> {
	try {
		const sessionId = plugin.getCurrentChatSessionId() ?? goal.birthSessionId;
		await plugin.goalStore.activate(goal.id, sessionId);
		plugin.bumpGoalUi();
		await renderGoalSettingsSection(container, plugin);
	} catch {
		new Notice(tNow('goal.error.activeElsewhere'));
	}
}

function showSingleArchiveConfirm(
	app: App,
	goal: AgentGoal,
	_onKind: 'archive' | 'cancelled',
	onConfirm: () => void | Promise<void>,
): void {
	const modal = new Modal(app);
	modal.titleEl.setText(tNow('goal.settings.archiveConfirmTitle'));
	modal.contentEl.createEl('p', {
		text: tNow('goal.settings.archiveConfirmBody', { objective: goal.objective }),
	});
	const row = modal.contentEl.createDiv({ cls: 'modal-button-container' });
	row.createEl('button', { text: tNow('goal.modal.confirm.primary') }).onclick = () => {
		void onConfirm();
		modal.close();
	};
	row.createEl('button', { text: tNow('modal.toolConfirm.deny') }).onclick = () => modal.close();
	modal.open();
}

function showArchiveAllConfirm(app: App, count: number, onConfirm: () => void | Promise<void>): void {
	const modal = new Modal(app);
	modal.titleEl.setText(tNow('goal.settings.archiveAllConfirmTitle'));
	modal.contentEl.createEl('p', {
		text: tNow('goal.settings.archiveAllConfirmBody', { count }),
	});
	const row = modal.contentEl.createDiv({ cls: 'modal-button-container' });
	// 关键路径:主按钮不设 mod-cta / 非默认聚焦,避免回车误归档
	const cancelBtn = row.createEl('button', { text: tNow('modal.toolConfirm.deny') });
	cancelBtn.onclick = () => modal.close();
	const okBtn = row.createEl('button', { text: tNow('goal.settings.archiveAll') });
	okBtn.onclick = () => {
		void onConfirm();
		modal.close();
	};
	modal.open();
}
