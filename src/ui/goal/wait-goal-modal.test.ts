/**
 * @file src/ui/goal/wait-goal-modal.test.ts
 * @description waitGoalModalGap 让出当前事件循环
 * @module ui/goal/wait-goal-modal.test
 */

import { describe, it, expect } from 'vitest';
import { waitGoalModalGap } from './wait-goal-modal';

describe('waitGoalModalGap', () => {
	it('waitGoalModalGap - 默认间隔 - 在当前同步栈之后才 resolve', async () => {
		let later = false;
		const p = waitGoalModalGap(1).then(() => {
			later = true;
		});
		expect(later).toBe(false);
		await p;
		expect(later).toBe(true);
	});
});
