/**
 * @file tests/ui/motion/count-up.test.ts
 * @description CountUp 缓动与插值纯函数
 */
import { describe, it, expect } from 'vitest';
import { easeOutCount, lerpCount } from '../../../src/ui/motion/chrome/count-up';

describe('count-up', () => {
	it('lerpCount - t=0 - from', () => {
		expect(lerpCount(10, 50, 0)).toBe(10);
	});

	it('lerpCount - t=1 - to', () => {
		expect(lerpCount(10, 50, 1)).toBe(50);
	});

	it('easeOutCount - 0 与 1 - 端点', () => {
		expect(easeOutCount(0)).toBe(0);
		expect(easeOutCount(1)).toBe(1);
	});
});
