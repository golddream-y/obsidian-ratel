/**
 * @file src/ui/goal/pick-goal-row-actions.test.ts
 * @description 目标管理列表行按钮矩阵
 * @module ui/goal/pick-goal-row-actions.test
 */

import { describe, it, expect } from 'vitest';
import { pickGoalRowActions } from './pick-goal-row-actions';

describe('pickGoalRowActions', () => {
	it('pickGoalRowActions - active - 仅暂停', () => {
		expect(pickGoalRowActions('active')).toEqual(['pause']);
	});

	it('pickGoalRowActions - pending - 恢复与放弃', () => {
		expect(pickGoalRowActions('pending')).toEqual(['resume', 'cancel']);
	});

	it('pickGoalRowActions - paused 与 blocked - 恢复与放弃', () => {
		expect(pickGoalRowActions('paused')).toEqual(['resume', 'cancel']);
		expect(pickGoalRowActions('blocked')).toEqual(['resume', 'cancel']);
	});

	it('pickGoalRowActions - 终态 - 仅归档', () => {
		expect(pickGoalRowActions('completed')).toEqual(['archive']);
		expect(pickGoalRowActions('cancelled')).toEqual(['archive']);
	});
});
