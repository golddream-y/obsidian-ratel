/**
 * @file src/ui/mascot/spring.test.ts
 * @description 弹簧步进趋近目标
 * @module ui/mascot/spring.test
 */
import { describe, it, expect } from 'vitest';
import { createSpring, stepSpring, snapSpring } from './spring';

describe('stepSpring', () => {
	it('目标跳变后若干步 - 位置靠近目标 - 不原地不动', () => {
		const s = createSpring(0);
		s.t = 1;
		for (let i = 0; i < 40; i++) stepSpring(s, 18, 1, 1 / 60);
		expect(s.x).toBeGreaterThan(0.8);
		expect(Math.abs(s.x - 1)).toBeLessThan(0.05);
	});
});

describe('snapSpring', () => {
	it('贴目标 - 速度归零', () => {
		const s = createSpring(0);
		s.v = 9;
		snapSpring(s, 0.4);
		expect(s.x).toBe(0.4);
		expect(s.v).toBe(0);
		expect(s.t).toBe(0.4);
	});
});
