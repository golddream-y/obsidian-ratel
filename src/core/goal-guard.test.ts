/**
 * @file src/core/goal-guard.test.ts
 * @description goal-guard 单元测试 — 无进展守卫与三层预算检查
 * @module core/goal-guard.test
 * @depends core/goal-guard
 */

import { describe, it, expect } from 'vitest';
import { evaluateNoProgress, checkBudgets, isGoalBudgetExhausted } from './goal-guard';

describe('evaluateNoProgress', () => {
	it('有 predicate - 剩余集合连续两轮不降 - blocked', () => {
		const result = evaluateNoProgress({
			remainingPrev: 5,
			remainingNow: 5,
			writesPrevRound: 0,
			writesThisRound: 0,
			progressNotePrev: '已处理 A',
			progressNoteNow: '已处理 A–E',
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('5');
	});

	it('无 predicate - 写入计数连续两轮为零 - blocked', () => {
		const result = evaluateNoProgress({
			remainingPrev: null,
			remainingNow: null,
			writesPrevRound: 0,
			writesThisRound: 0,
			progressNotePrev: '游标 A',
			progressNoteNow: '游标 B',
		});
		expect(result.blocked).toBe(true);
	});

	it('有 predicate - 剩余下降 - 不 blocked', () => {
		const result = evaluateNoProgress({
			remainingPrev: 5,
			remainingNow: 3,
			writesPrevRound: 0,
			writesThisRound: 0,
			progressNotePrev: '',
			progressNoteNow: '',
		});
		expect(result.blocked).toBe(false);
	});

	it('progressNote 变化但主信号零 - 仍 blocked', () => {
		const result = evaluateNoProgress({
			remainingPrev: null,
			remainingNow: null,
			writesPrevRound: 0,
			writesThisRound: 0,
			progressNotePrev: '旧游标',
			progressNoteNow: '全新表述的游标',
		});
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain('全新表述的游标');
	});
});

describe('checkBudgets', () => {
	it('stepsUsed 达 maxSteps - endRound', () => {
		expect(
			checkBudgets({
				stepsUsed: 50,
				maxSteps: 50,
				roundTokens: 0,
				roundTokenSoftCap: 0,
				roundsDone: 0,
				maxRounds: 10,
			}),
		).toEqual({ action: 'endRound' });
	});

	it('roundTokenSoftCap 开启且达上限 - endRound', () => {
		expect(
			checkBudgets({
				stepsUsed: 1,
				maxSteps: 50,
				roundTokens: 8000,
				roundTokenSoftCap: 8000,
				roundsDone: 0,
				maxRounds: 10,
			}),
		).toEqual({ action: 'endRound' });
	});

	it('roundsDone 达 maxRounds - askRounds', () => {
		expect(
			checkBudgets({
				stepsUsed: 1,
				maxSteps: 50,
				roundTokens: 100,
				roundTokenSoftCap: 0,
				roundsDone: 10,
				maxRounds: 10,
			}),
		).toEqual({ action: 'askRounds' });
	});

	it('均未触达 - continue', () => {
		expect(
			checkBudgets({
				stepsUsed: 5,
				maxSteps: 50,
				roundTokens: 100,
				roundTokenSoftCap: 0,
				roundsDone: 2,
				maxRounds: 10,
			}),
		).toEqual({ action: 'continue' });
	});
});

describe('isGoalBudgetExhausted', () => {
	it('isGoalBudgetExhausted - roundsDone 未达上限 - false', () => {
		expect(isGoalBudgetExhausted({ roundsDone: 9, maxRounds: 10 })).toBe(false);
	});

	it('isGoalBudgetExhausted - roundsDone 等于 maxRounds - true', () => {
		expect(isGoalBudgetExhausted({ roundsDone: 10, maxRounds: 10 })).toBe(true);
	});

	it('isGoalBudgetExhausted - roundsDone 超过 maxRounds - true', () => {
		expect(isGoalBudgetExhausted({ roundsDone: 12, maxRounds: 10 })).toBe(true);
	});
});
