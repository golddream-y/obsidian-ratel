/**
 * @file src/ui/goal/GoalManageModal.test.ts
 * @description 目标管理 Modal 单例判定
 * @module ui/goal/GoalManageModal.test
 */

import { describe, it, expect } from 'vitest';
import { shouldCreateGoalManageModal } from './GoalManageModal';

describe('shouldCreateGoalManageModal', () => {
	it('shouldCreateGoalManageModal - 无实例 - 允许新建', () => {
		expect(shouldCreateGoalManageModal(null)).toBe(true);
	});

	it('shouldCreateGoalManageModal - 已有实例 - 不再新建', () => {
		expect(shouldCreateGoalManageModal({} as never)).toBe(false);
	});

	it('shouldCreateGoalManageModal - onClosed 清引用后 - 允许再次新建', () => {
		let current: object | null = {};
		expect(shouldCreateGoalManageModal(current as never)).toBe(false);
		current = null;
		expect(shouldCreateGoalManageModal(current)).toBe(true);
	});
});
