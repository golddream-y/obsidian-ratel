/**
 * @file src/ui/goal/GoalTerminalChoiceModal.ts
 * @description 关闭目标去留一框 — 留列表 / 归档 / 写笔记 / 取消(spec 4.9)
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
 * 关窗时如何解释「没点处理按钮」。
 *
 * @param pending - 用户点过的选项;null 表示 Esc / 取消 / 点遮罩
 * @param alreadyTerminal - 目标是否已是 completed/cancelled(runner 收口后)
 * @returns 处理结果;null 表示中止,调用方不得 transition
 */
export function choiceFromModalClose(
	pending: GoalTerminalChoiceResult | null,
	alreadyTerminal: boolean,
): GoalTerminalChoiceResult | null {
	if (pending) return pending;
	if (alreadyTerminal) {
		return { choice: 'keep', showCompletedNotice: false };
	}
	return null;
}

/**
 * 完成/放弃后询问留列表、归档或先写笔记(spec 4.9)。
 *
 * @param app - Obsidian App
 * @param kind - completed 含写笔记;cancelled 不含
 * @param goal - 目标摘要
 * @param opts.alreadyTerminal - 已落盘终态时关窗=留列表;未落盘时关窗=中止
 */
export function showGoalTerminalChoiceModal(
	app: App,
	kind: 'completed' | 'cancelled',
	goal: AgentGoal,
	opts?: { alreadyTerminal?: boolean },
): Promise<GoalTerminalChoiceResult | null> {
	return new Promise((resolve) => {
		const modal = new GoalTerminalChoiceModal(app, kind, goal, opts?.alreadyTerminal === true, resolve);
		modal.open();
	});
}

class GoalTerminalChoiceModal extends Modal {
	private settled = false;
	private pending: GoalTerminalChoiceResult | null = null;

	constructor(
		app: App,
		private kind: 'completed' | 'cancelled',
		private goal: AgentGoal,
		private alreadyTerminal: boolean,
		private onResolve: (result: GoalTerminalChoiceResult | null) => void,
	) {
		super(app);
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

		// 关键路径:不设 mod-cta,避免回车误归档
		const keepBtn = btnRow.createEl('button', {
			text: tNow('goal.modal.terminal.keep'),
		});
		keepBtn.onclick = () => {
			this.pending = {
				choice: 'keep',
				showCompletedNotice: this.kind === 'completed',
			};
			this.close();
		};

		if (this.kind === 'completed') {
			btnRow.createEl('button', { text: tNow('goal.modal.terminal.writeNote') }).onclick = () => {
				this.pending = { choice: 'writeNote' };
				this.close();
			};
		}

		btnRow.createEl('button', { text: tNow('goal.modal.terminal.archive') }).onclick = () => {
			this.pending = {
				choice: 'archive',
				showCompletedNotice: this.kind === 'completed',
			};
			this.close();
		};

		// 未落盘时取消=不关目标;已终态时取消与留列表同义,不再单列以免两颗同效按钮
		if (!this.alreadyTerminal) {
			btnRow.createEl('button', { text: tNow('common.cancel') }).onclick = () => {
				this.pending = null;
				this.close();
			};
		}
	}

	onClose(): void {
		const result = choiceFromModalClose(this.pending, this.alreadyTerminal);
		if (!this.settled) {
			this.settled = true;
			window.setTimeout(() => this.onResolve(result), 0);
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
