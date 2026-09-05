/**
 * @file src/ui/mascot/gesture.test.ts
 * @description 捣蛋鬼单击 vs 拖动位移阈值
 * @module ui/mascot/gesture.test
 */
import { describe, it, expect } from 'vitest';
import { isMascotTap, MASCOT_TAP_SLOP } from './gesture';

describe('isMascotTap', () => {
	it('位移为零 - 单击 - 为 true', () => {
		expect(isMascotTap(0, 0)).toBe(true);
	});
	it('位移小于阈值 - 单击 - 为 true', () => {
		expect(isMascotTap(3, 4)).toBe(true);
	});
	it('位移刚过阈值 - 拖动 - 为 false', () => {
		expect(isMascotTap(MASCOT_TAP_SLOP, 0)).toBe(false);
		expect(isMascotTap(5, 5)).toBe(false);
	});
});
