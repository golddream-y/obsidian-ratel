/**
 * @file src/ui/goal/goal-status-bar.ts
 * @description 窗口底栏 Goal 状态条 — spec 4.11 面 1
 * @module ui/goal/goal-status-bar
 * @depends core/goal-store, i18n
 */

import type { AgentGoal } from '../../core/goal-store';
import { tNow } from '../../i18n';

/** 底栏文案优先级结果 */
export interface GoalStatusBarText {
	text: string;
	/** 点击打开设置页 Goal 区块(仅待归档) */
	openSettings: boolean;
}

/**
 * 按 spec 4.11 面 1 优先级选出底栏短文案。
 *
 * @param goals - 活跃队列
 * @param staleCount - 待归档条数
 */
export function pickGoalStatusBarText(goals: AgentGoal[], staleCount: number): GoalStatusBarText | null {
	const blocked = goals.filter((g) => g.status === 'blocked').length;
	if (blocked > 0) {
		return {
			text: tNow('goal.statusBar.blocked', { count: blocked }),
			openSettings: false,
		};
	}
	if (goals.some((g) => g.status === 'active')) {
		return { text: tNow('goal.statusBar.active'), openSettings: false };
	}
	const paused = goals.filter((g) => g.status === 'paused').length;
	const pending = goals.filter((g) => g.status === 'pending').length;
	if (paused > 0 || pending > 0) {
		const parts: string[] = [];
		if (paused > 0) parts.push(tNow('goal.statusBar.paused', { count: paused }));
		if (pending > 0) parts.push(tNow('goal.statusBar.pending', { count: pending }));
		return { text: parts.join(' / '), openSettings: false };
	}
	const unfinished = goals.filter((g) => !['completed', 'cancelled'].includes(g.status)).length;
	if (unfinished === 0 && staleCount > 0) {
		return {
			text: tNow('goal.statusBar.stale', { count: staleCount }),
			openSettings: true,
		};
	}
	if (goals.length === 0 && staleCount === 0) {
		return null;
	}
	return null;
}
