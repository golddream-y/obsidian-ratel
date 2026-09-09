/**
 * @file src/ui/goal/pick-goal-row-actions.ts
 * @description 目标管理列表行按钮 — spec v1.7 面 5
 * @module ui/goal/pick-goal-row-actions
 * @depends core/goal-store
 */

import type { GoalStatus } from '../../core/goal-store';

/** 管理列表行内可点的动作 */
export type GoalRowAction = 'pause' | 'resume' | 'cancel' | 'archive';

/**
 * 按状态选出管理列表行按钮(不含创建)。
 *
 * @param status - Goal 状态
 * @returns 从左到右的按钮清单
 */
export function pickGoalRowActions(status: GoalStatus): GoalRowAction[] {
	switch (status) {
		case 'active':
			return ['pause'];
		case 'pending':
		case 'paused':
		case 'blocked':
			return ['resume', 'cancel'];
		case 'completed':
		case 'cancelled':
			return ['archive'];
		default:
			return [];
	}
}
