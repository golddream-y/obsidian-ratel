/**
 * @file src/core/goal-guard.ts
 * @description Goal 无进展守卫与三层预算纯函数(S-GOAL spec 4.7)
 * @module core/goal-guard
 */

/** 无进展守卫输入 — 主信号为 predicate 剩余集合或无 predicate 时 grant 写入计数 */
export interface NoProgressInput {
	/** predicate 剩余集合大小;无 predicate 时为 null */
	remainingPrev: number | null;
	remainingNow: number | null;
	/** grant 范围成功写计数(无 predicate 时作主信号) */
	writesPrevRound: number;
	writesThisRound: number;
	/** 仅记入 reason,不参与决策 */
	progressNotePrev: string;
	progressNoteNow: string;
}

/** 无进展守卫结果 */
export interface NoProgressResult {
	blocked: boolean;
	reason?: string;
}

/** 三层预算检查输入 */
export interface BudgetCheckInput {
	stepsUsed: number;
	maxSteps: number;
	roundTokens: number;
	/** 0 表示关闭单回合 token 软上限 */
	roundTokenSoftCap: number;
	roundsDone: number;
	maxRounds: number;
}

export type BudgetAction = 'continue' | 'endRound' | 'askRounds';

/**
 * 无进展守卫 — 连续两轮主信号零变化则 blocked(spec 4.7)。
 *
 * 有 predicate:主信号 = 剩余集合大小不降。
 * 无 predicate:主信号 = 本回合 grant 成功写入计数为零。
 * progressNote 仅附在 reason,不参与决策。
 *
 * @param input - 两轮对比数据
 * @returns blocked 与可选原因(含两轮数值对比)
 */
export function evaluateNoProgress(input: NoProgressInput): NoProgressResult {
	const hasPredicate = input.remainingPrev !== null && input.remainingNow !== null;
	const mainStalled = hasPredicate
		? input.remainingNow >= input.remainingPrev
		: input.writesThisRound === 0 && input.writesPrevRound === 0;

	if (!mainStalled) {
		return { blocked: false };
	}

	const signalDesc = hasPredicate
		? `剩余集合 ${input.remainingPrev} → ${input.remainingNow}`
		: `grant 写入 ${input.writesPrevRound} → ${input.writesThisRound}`;
	const noteHint =
		input.progressNoteNow !== input.progressNotePrev
			? `; progressNote: ${input.progressNotePrev} → ${input.progressNoteNow}`
			: '';

	return {
		blocked: true,
		reason: `连续两轮无进展: ${signalDesc}${noteHint}`,
	};
}

/**
 * 三层预算检查 — 步数 / 回合 token / 跨回合轮数(spec 4.7)。
 *
 * 优先级:maxSteps → roundTokenSoftCap → maxRounds。
 *
 * @param input - 当前用量与上限
 * @returns 触达动作或 continue
 */
export function checkBudgets(input: BudgetCheckInput): { action: BudgetAction } {
	if (input.stepsUsed >= input.maxSteps) {
		return { action: 'endRound' };
	}
	if (input.roundTokenSoftCap > 0 && input.roundTokens >= input.roundTokenSoftCap) {
		return { action: 'endRound' };
	}
	if (input.roundsDone >= input.maxRounds) {
		// 语义:预算耗尽待裁决(加轮/先停/放弃),不是问完成
		return { action: 'askRounds' };
	}
	return { action: 'continue' };
}

/**
 * 跨回合预算是否已耗尽 — 满轮保险丝(架构 §5.1)。
 *
 * 触达后挡住 grant 免确认与计轮续跑;不改变 status,也不等于完成。
 *
 * @param goal - 只需轮次字段
 */
export function isGoalBudgetExhausted(goal: { roundsDone: number; maxRounds: number }): boolean {
	return goal.roundsDone >= goal.maxRounds;
}
