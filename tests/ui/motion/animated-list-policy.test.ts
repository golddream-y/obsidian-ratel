/**
 * @file tests/ui/motion/animated-list-policy.test.ts
 * @description 菜单列表 stagger 延迟策略
 */
import { describe, it, expect } from 'vitest';
import {
	ANIMATED_LIST_STAGGER_CAP,
	staggerDelayMs,
} from '../../../src/ui/motion/chrome/animated-list-policy';

describe('animated-list-policy', () => {
	it('staggerDelayMs - 第 0 项 - 0', () => {
		expect(staggerDelayMs(0)).toBe(0);
	});

	it('staggerDelayMs - 第 3 项 - 120', () => {
		expect(staggerDelayMs(3)).toBe(120);
	});

	it('staggerDelayMs - 超过 cap - null', () => {
		expect(staggerDelayMs(ANIMATED_LIST_STAGGER_CAP)).toBeNull();
	});
});
