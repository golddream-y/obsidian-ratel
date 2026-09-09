/**
 * @file src/ui/goal/pick-goal-strip.test.ts
 * @description 目标指示条跨会话常显规则
 * @module ui/goal/pick-goal-strip.test
 */

import { describe, it, expect } from 'vitest';
import { pickGoalStrip, goalChromeFromStrip } from './pick-goal-strip';
import type { AgentGoal } from '../../core/goal-store';

const HERE = 's-new';
const THERE = 's-old';

function makeGoal(
	partial: Partial<AgentGoal> & Pick<AgentGoal, 'id' | 'status' | 'objective'>,
): AgentGoal {
	return {
		version: 1,
		completionCriteria: { text: '标准' },
		progressNote: '',
		roundsDone: 0,
		maxRounds: 10,
		usage: { inputTokens: 0, outputTokens: 0 },
		grant: null,
		birthSessionId: THERE,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...partial,
	};
}

describe('pickGoalStrip', () => {
	it('无未完成目标 - 隐藏', () => {
		const r = pickGoalStrip({ sessionId: HERE, goals: [], isRunning: false });
		expect(r.kind).toBe('hidden');
	});

	it('active 绑在本会话且未跑 - 进行中闲态', () => {
		const r = pickGoalStrip({
			sessionId: HERE,
			goals: [makeGoal({ id: 'g1', status: 'active', objective: '写规格', activeSessionId: HERE })],
			isRunning: false,
		});
		expect(r.kind).toBe('active-here');
		expect(r.goal?.id).toBe('g1');
	});

	it('active 绑在本会话且正在生成 - 进行中跑态', () => {
		const r = pickGoalStrip({
			sessionId: HERE,
			goals: [makeGoal({ id: 'g1', status: 'active', objective: '写规格', activeSessionId: HERE })],
			isRunning: true,
		});
		expect(r.kind).toBe('running');
	});

	it('新会话后 active 仍绑旧会话 - 仍显示进行中', () => {
		const r = pickGoalStrip({
			sessionId: HERE,
			goals: [makeGoal({ id: 'g1', status: 'active', objective: '写规格', activeSessionId: THERE })],
			isRunning: false,
		});
		expect(r.kind).toBe('active-elsewhere');
		expect(r.goal?.objective).toBe('写规格');
	});

	it('paused - 显示暂停', () => {
		const r = pickGoalStrip({
			sessionId: HERE,
			goals: [makeGoal({ id: 'g1', status: 'paused', objective: '写规格' })],
			isRunning: false,
		});
		expect(r.kind).toBe('paused');
	});

	it('多条 paused - 取最近更新', () => {
		const r = pickGoalStrip({
			sessionId: HERE,
			goals: [
				makeGoal({
					id: 'old',
					status: 'paused',
					objective: '旧',
					updatedAt: '2026-01-01T00:00:00.000Z',
				}),
				makeGoal({
					id: 'new',
					status: 'paused',
					objective: '新',
					updatedAt: '2026-02-01T00:00:00.000Z',
				}),
			],
			isRunning: false,
		});
		expect(r.goal?.id).toBe('new');
	});

	it('blocked 优先于 active', () => {
		const r = pickGoalStrip({
			sessionId: HERE,
			goals: [
				makeGoal({ id: 'a', status: 'active', objective: 'A', activeSessionId: HERE }),
				makeGoal({ id: 'b', status: 'blocked', objective: 'B', blockedReason: '缺文件' }),
			],
			isRunning: false,
		});
		expect(r.kind).toBe('blocked');
		expect(r.goal?.id).toBe('b');
	});

	it('无 active 仅 pending - 排队', () => {
		const r = pickGoalStrip({
			sessionId: HERE,
			goals: [makeGoal({ id: 'p', status: 'pending', objective: '排队项' })],
			isRunning: false,
		});
		expect(r.kind).toBe('pending');
		expect(r.pendingCount).toBeUndefined();
	});

	it('多条 pending - 带计数', () => {
		const r = pickGoalStrip({
			sessionId: HERE,
			goals: [
				makeGoal({ id: 'p1', status: 'pending', objective: '一' }),
				makeGoal({ id: 'p2', status: 'pending', objective: '二' }),
			],
			isRunning: false,
		});
		expect(r.kind).toBe('pending');
		expect(r.pendingCount).toBe(2);
	});
});

describe('goalChromeFromStrip', () => {
	it('goalChromeFromStrip - running - 有 beam 无 orb(球给消息流)', () => {
		expect(goalChromeFromStrip('running')).toEqual({ beam: true, orb: false, quiet: true });
	});

	it('goalChromeFromStrip - active-elsewhere - 有 beam 无 orb', () => {
		expect(goalChromeFromStrip('active-elsewhere')).toEqual({
			beam: true,
			orb: false,
			quiet: true,
		});
	});

	it('goalChromeFromStrip - paused - 全关 quiet 开', () => {
		expect(goalChromeFromStrip('paused')).toEqual({ beam: false, orb: false, quiet: true });
	});

	it('goalChromeFromStrip - blocked - 无 beam 无 orb 非 quiet', () => {
		expect(goalChromeFromStrip('blocked')).toEqual({ beam: false, orb: false, quiet: false });
	});
});
