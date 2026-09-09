/**
 * @file src/ui/goal/GoalActionConfirmModal.ts
 * @description resume/cancel/complete 小确认框 — spec 4.11 面 4
 * @module ui/goal/GoalActionConfirmModal
 * @depends obsidian, tools/manage-goal, i18n
 */

import { Modal, type App } from 'obsidian';
import type { AgentGoal } from '../../core/goal-store';
import { tNow } from '../../i18n';

type GoalAction = 'resume' | 'cancel' | 'complete';

const TITLE_KEYS: Record<GoalAction, 'goal.modal.confirm.resumeTitle' | 'goal.modal.confirm.cancelTitle' | 'goal.modal.confirm.completeTitle'> = {
	resume: 'goal.modal.confirm.resumeTitle',
	cancel: 'goal.modal.confirm.cancelTitle',
	complete: 'goal.modal.confirm.completeTitle',
};

const BODY_KEYS: Record<GoalAction, 'goal.modal.confirm.resumeBody' | 'goal.modal.confirm.cancelBody' | 'goal.modal.confirm.completeBody'> = {
	resume: 'goal.modal.confirm.resumeBody',
	cancel: 'goal.modal.confirm.cancelBody',
	complete: 'goal.modal.confirm.completeBody',
};

/**
 * 动作内小确认 — 只读摘要 + 主按钮(spec 4.11)。
 *
 * @param app - Obsidian App
 * @param action - resume / cancel / complete
 * @param goal - 目标摘要
 */
export function showGoalActionConfirmModal(
	app: App,
	action: GoalAction,
	goal: AgentGoal,
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new GoalActionConfirmModal(app, action, goal, resolve);
		modal.open();
	});
}

class GoalActionConfirmModal extends Modal {
	private settled = false;
	private pending: boolean | null = null;

	constructor(
		app: App,
		private action: GoalAction,
		private goal: AgentGoal,
		private onResolve: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(tNow(TITLE_KEYS[this.action]));
		contentEl.createEl('p', {
			text: tNow(BODY_KEYS[this.action], { objective: this.goal.objective }),
		});
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: tNow('goal.modal.confirm.primary'), cls: 'mod-cta' }).onclick =
			() => {
				this.pending = true;
				this.close();
			};
		btnRow.createEl('button', { text: tNow('modal.toolConfirm.deny') }).onclick = () => {
			this.pending = false;
			this.close();
		};
	}

	onClose(): void {
		// 关键路径:关窗后再异步 resolve,避免同一 click 里立刻打开归档弹窗导致点击穿透来回弹
		const ok = this.pending ?? false;
		if (!this.settled) {
			this.settled = true;
			window.setTimeout(() => this.onResolve(ok), 0);
		}
		this.contentEl.empty();
	}
}
