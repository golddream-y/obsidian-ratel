/**
 * @file src/ui/goal/pick-continue-chip.ts
 * @description 继续 chip 唯一目标规则 — spec 4.11 面 3 纯函数
 * @module ui/goal/pick-continue-chip
 * @depends core/goal-store, ui/goal/pick-goal-strip
 */

import type { AgentGoal } from '../../core/goal-store';
import type { GoalStripKind } from './pick-goal-strip';

/** 继续 chip 展示形态 */
export type ContinueChipKind =
	| 'hidden'
	| 'continue'
	| 'takeover'
	| 'single-pending'
	| 'multi-pending';

/** pickContinueChip 结果 */
export interface ContinueChipPick {
	kind: ContinueChipKind;
	goalId?: string;
	objective?: string;
	pendingCount?: number;
}

/** 截断 objective — chip / Strip 共用 */
export function truncateObjective(text: string, maxLen = 28): string {
	const t = text.trim();
	if (t.length <= maxLen) return t;
	return `${t.slice(0, maxLen - 1)}…`;
}

/**
 * 按 spec 4.11 面 3 选出唯一继续 chip。
 * 本会话已绑定且未在跑时不展示(Strip 已承担闲等态)。
 *
 * @param input - 会话、目标列表与输入/运行态
 * @returns chip 形态;hidden 表示不展示
 */
export function pickContinueChip(input: {
	sessionId: string;
	goals: AgentGoal[];
	inputNonempty: boolean;
	isRunning: boolean;
}): ContinueChipPick {
	if (input.inputNonempty || input.isRunning) {
		return { kind: 'hidden' };
	}

	const active = input.goals.find((g) => g.status === 'active');
	if (active) {
		if (active.activeSessionId === input.sessionId) {
			// 本会话闲等:StatusStrip 已写「进行中,等待输入」,再叠「继续推进」重复
			return { kind: 'hidden' };
		}
		return {
			kind: 'takeover',
			goalId: active.id,
			objective: active.objective,
		};
	}

	const pending = input.goals.filter((g) => g.status === 'pending');
	if (pending.length === 1) {
		return {
			kind: 'single-pending',
			goalId: pending[0]!.id,
			objective: pending[0]!.objective,
		};
	}
	if (pending.length >= 2) {
		return { kind: 'multi-pending', pendingCount: pending.length };
	}

	return { kind: 'hidden' };
}

/**
 * 条已经在展示同一条未完成目标时不再叠 chip,避免「条 + 继续」双状态。
 * 接管 / 多条遗留 pending 仍要 chip(条点不开那两个动作)。
 *
 * @param chip - pickContinueChip 结果
 * @param stripKind - pickGoalStrip 的 kind
 */
export function shouldShowContinueChip(chip: ContinueChipPick, stripKind: GoalStripKind): boolean {
	if (chip.kind === 'hidden') return false;
	if (chip.kind === 'takeover' || chip.kind === 'multi-pending') return true;
	if (stripKind !== 'hidden') return false;
	return true;
}
