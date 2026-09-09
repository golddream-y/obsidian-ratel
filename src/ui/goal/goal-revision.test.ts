/**
 * @file src/ui/goal/goal-revision.test.ts
 * @description Goal UI revision store — bump 后订阅方能收到新值
 * @module ui/goal/goal-revision.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { bumpGoalRevision, goalRevision } from './goal-revision';

describe('goalRevision', () => {
	beforeEach(() => {
		goalRevision.set(0);
	});

	it('bumpGoalRevision - 调用后 - store 递增', () => {
		expect(get(goalRevision)).toBe(0);
		bumpGoalRevision();
		expect(get(goalRevision)).toBe(1);
		bumpGoalRevision();
		expect(get(goalRevision)).toBe(2);
	});
});
