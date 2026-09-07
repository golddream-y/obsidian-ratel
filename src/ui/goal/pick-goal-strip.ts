/**
 * @file src/ui/goal/pick-goal-strip.ts
 * @description 聊天 StatusStrip 目标指示 — 未完成目标跨会话常显,区分进行中 / 暂停
 * @module ui/goal/pick-goal-strip
 * @depends core/goal-store
 */

import type { AgentGoal } from '../../core/goal-store';

/** Strip 展示形态 */
export type GoalStripKind =
	| 'hidden'
	| 'blocked'
	| 'running'
	| 'active-here'
	| 'active-elsewhere'
	| 'paused'
	| 'pending';

/** pickGoalStrip 结果 */
export interface GoalStripPick {
	kind: GoalStripKind;
	goal: AgentGoal | null;
	pendingCount?: number;
}

/**
 * 选一条未完成目标喂给 StatusStrip。
 * 新会话不绑 active 时仍显示「进行中」;paused 显示「已暂停」。
 *
 * 优先级: blocked → active(本会话跑/闲 / 他会话) → paused → pending
 *
 * @param input.sessionId - 当前聊天会话
 * @param input.goals - 目标快照
 * @param input.isRunning - 本会话是否正在生成
 */
export function pickGoalStrip(input: {
	sessionId: string;
	goals: AgentGoal[];
	isRunning: boolean;
}): GoalStripPick {
	const blocked = input.goals.find((g) => g.status === 'blocked');
	if (blocked) return { kind: 'blocked', goal: blocked };

	const active = input.goals.find((g) => g.status === 'active');
	if (active) {
		if (active.activeSessionId === input.sessionId) {
			if (input.isRunning) return { kind: 'running', goal: active };
			return { kind: 'active-here', goal: active };
		}
		return { kind: 'active-elsewhere', goal: active };
	}

	const paused = input.goals
		.filter((g) => g.status === 'paused')
		.slice()
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	if (paused[0]) return { kind: 'paused', goal: paused[0] };

	const pending = input.goals.filter((g) => g.status === 'pending');
	if (pending.length === 1) return { kind: 'pending', goal: pending[0]! };
	if (pending.length >= 2) {
		return { kind: 'pending', goal: pending[0]!, pendingCount: pending.length };
	}

	return { kind: 'hidden', goal: null };
}

/** StatusStrip / 输入壳动效开关 */
export interface GoalChrome {
	beam: boolean;
	orb: boolean;
	quiet: boolean;
}

/**
 * StatusStrip / 输入壳动效开关 — spec v1.5 面 2/3。
 *
 * @param kind - pickGoalStrip 产出的 strip 形态
 * @returns beam / orb / quiet 三开关,与 spec v1.5 表逐格一致
 */
export function goalChromeFromStrip(kind: GoalStripKind): GoalChrome {
	switch (kind) {
		case 'running':
			return { beam: true, orb: true, quiet: false };
		case 'active-here':
		case 'active-elsewhere':
			return { beam: true, orb: false, quiet: true };
		case 'paused':
		case 'pending':
			return { beam: false, orb: false, quiet: true };
		case 'blocked':
		case 'hidden':
			return { beam: false, orb: false, quiet: false };
	}
}
