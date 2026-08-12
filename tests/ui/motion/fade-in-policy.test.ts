/**
 * @file tests/ui/motion/fade-in-policy.test.ts
 * @description FadeIn / cite 入场策略单测
 */
import { describe, it, expect } from 'vitest';
import { shouldStaggerCite } from '../../../src/ui/motion/enter/cite-policy';

describe('fade-in policy', () => {
	it('shouldStaggerCite - 少于 8 - each', () => {
		expect(shouldStaggerCite(3)).toBe('each');
	});
	it('shouldStaggerCite - 不少于 8 - group', () => {
		expect(shouldStaggerCite(8)).toBe('group');
	});
});
