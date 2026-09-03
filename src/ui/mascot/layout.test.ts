/**
 * @file src/ui/mascot/layout.test.ts
 * @description 吉祥物坐标比例与视线限幅
 * @module ui/mascot/layout.test
 */
import { describe, it, expect } from 'vitest';
import { MASCOT_SIZE, MASCOT_INSET, ratioToOffset, offsetToRatio, computeGaze, clampMascotRatio } from './layout';

describe('吉祥物布局', () => {
	it('默认比例 1,1 - 贴右下 inset - 不越界', () => {
		const { left, top } = ratioToOffset(1, 1, 320, 400);
		expect(left).toBe(320 - MASCOT_SIZE - MASCOT_INSET);
		expect(top).toBe(400 - MASCOT_SIZE - MASCOT_INSET);
	});
	it('比例 0,0 - 贴左上 inset', () => {
		const { left, top } = ratioToOffset(0, 0, 320, 400);
		expect(left).toBe(MASCOT_INSET);
		expect(top).toBe(MASCOT_INSET);
	});
	it('往返 - offset 再 ratio - 回到原比例', () => {
		const r = { x: 0.3, y: 0.7 };
		const o = ratioToOffset(r.x, r.y, 320, 400);
		const back = offsetToRatio(o.left, o.top, 320, 400);
		expect(back.x).toBeCloseTo(0.3, 5);
		expect(back.y).toBeCloseTo(0.7, 5);
	});
	it('非法比例 - clamp 到 0-1', () => {
		expect(clampMascotRatio(-1, 2)).toEqual({ x: 0, y: 1 });
	});
	it('窗比吉祥物还小 - left/top 不小于 inset', () => {
		const { left, top } = ratioToOffset(1, 1, 20, 20);
		expect(left).toBe(MASCOT_INSET);
		expect(top).toBe(MASCOT_INSET);
	});
	it('视线 - 正右 - x 被限幅', () => {
		const g = computeGaze(1000, 24, 24, 24, false);
		expect(g.x).toBeLessThanOrEqual(0.55);
		expect(g.y).toBeCloseTo(0);
	});
	it('拖动冻结 - 视线归零', () => {
		expect(computeGaze(100, 100, 0, 0, true)).toEqual({ x: 0, y: 0 });
	});
});
