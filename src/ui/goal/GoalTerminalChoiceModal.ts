/**
 * @file src/ui/goal/GoalTerminalChoiceModal.ts
 * @description 终态三选一/二选一 Modal — spec 4.9
 * @module ui/goal/GoalTerminalChoiceModal
 * @depends obsidian, core/goal-store, i18n
 */

import { Modal, Notice, type App } from 'obsidian';
import type { AgentGoal, GoalStore } from '../../core/goal-store';
import { tNow } from '../../i18n';

/** 用户终态处置选择 */
export type GoalTerminalChoice = 'keep' | 'archive' | 'writeNote';

export interface GoalTerminalChoiceResult {
	choice: GoalTerminalChoice;
	/** 选择 keep/archive 后可发完成 Notice */
	showCompletedNotice?: boolean;
}

/**
 * 完成/放弃后询问留列表、归档或先写笔记(spec 4.9)。
 *
 * @param app - Obsidian App
 * @param kind - completed 三选一;cancelled 二选一
 * @param goal - 终态目标
 */
export function showGoalTerminalChoiceModal(
	app: App,
	kind: 'completed' | 'cancelled',
	goal: AgentGoal,
): Promise<GoalTerminalChoiceResult> {
	return new Promise((resolve) => {
		const modal = new GoalTerminalChoiceModal(app, kind, goal, resolve);
		modal.open();
	});
}

class GoalTerminalChoiceModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private kind: 'completed' | 'cancelled',
		private goal: AgentGoal,
		private onResolve: (result: GoalTerminalChoiceResult) => void,
	) {
		super(app);
	}

	private settle(result: GoalTerminalChoiceResult): void {
		if (this.settled) return;
		this.settled = true;
		this.onResolve(result);
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(
			tNow(
				this.kind === 'completed'
					? 'goal.modal.terminal.completedTitle'
					: 'goal.modal.terminal.cancelledTitle',
			),
		);
		contentEl.createEl('p', {
			text: tNow('goal.modal.terminal.body', { objective: this.goal.objective }),
		});

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });

		// 关键路径:默认「留在列表」为首个按钮,但不设 mod-cta 避免误触归档
		const keepBtn = btnRow.createEl('button', {
			text: tNow('goal.modal.terminal.keep'),
		});
		keepBtn.onclick = () => {
			this.settle({
				choice: 'keep',
				showCompletedNotice: this.kind === 'completed',
			});
			this.close();
		};

		if (this.kind === 'completed') {
			btnRow.createEl('button', { text: tNow('goal.modal.terminal.writeNote') }).onclick = () => {
				this.settle({ choice: 'writeNote' });
				this.close();
			};
		}

		btnRow.createEl('button', { text: tNow('goal.modal.terminal.archive') }).onclick = () => {
			this.settle({
				choice: 'archive',
				showCompletedNotice: this.kind === 'completed',
			});
			this.close();
		};
	}

	onClose(): void {
		if (!this.settled) {
			this.settle({
				choice: 'keep',
				showCompletedNotice: this.kind === 'completed',
			});
		}
		this.contentEl.empty();
	}
}

/**
 * 执行终态选择副作用 — 归档或写笔记提示。
 *
 * @param store - GoalStore
 * @param goal - 终态目标
 * @param result - 用户选择
 */
export async function applyGoalTerminalChoice(
	store: GoalStore,
	goal: AgentGoal,
	result: GoalTerminalChoiceResult,
): Promise<void> {
	if (result.choice === 'archive') {
		await store.archive(goal.id);
	}
}

/**
 * 完成 Notice — 无 emoji,带用量(spec 4.11)。
 *
 * @param goal - 已完成目标
 */
export function showGoalCompletedNotice(goal: AgentGoal): void {
	new Notice(
		tNow('goal.notice.completed', {
			objective: goal.objective,
			input: goal.usage.inputTokens,
			output: goal.usage.outputTokens,
		}),
		6000,
	);
}
