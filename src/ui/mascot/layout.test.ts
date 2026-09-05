/**
 * @file src/ui/mascot/layout.test.ts
 * @description 捣蛋鬼坐标比例与视线限幅
 * @module ui/mascot/layout.test
 */
import { describe, it, expect } from 'vitest';
import { MASCOT_SIZE, MASCOT_INSET, MASCOT_CANVAS_PAD, MASCOT_CANVAS_VIEW, ratioToOffset, offsetToRatio, computeGaze, clampMascotRatio, snapMascotToSides } from './layout';

describe('捣蛋鬼布局', () => {
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
	it('窗比捣蛋鬼还小 - left/top 不小于 inset', () => {
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
	it('侧边吸附 - 靠近左边 - 吸到 inset', () => {
		const { left, top } = snapMascotToSides(MASCOT_INSET + 6, 40, 320);
		expect(left).toBe(MASCOT_INSET);
		expect(top).toBe(40);
	});
	it('侧边吸附 - 靠近右边 - 吸到右 inset', () => {
		const right = 320 - MASCOT_SIZE - MASCOT_INSET;
		const { left } = snapMascotToSides(right - 6, 50, 320);
		expect(left).toBe(right);
	});
	it('侧边吸附 - 中间 - 不吸', () => {
		expect(snapMascotToSides(120, 40, 320)).toEqual({ left: 120, top: 40 });
	});
	it('侧边吸附 - 距边超过 8px - 不吸', () => {
		expect(snapMascotToSides(MASCOT_INSET + 10, 40, 320).left).toBe(MASCOT_INSET + 10);
	});
	it('画布留白 - 大于按压缩放溢出 - 避免裁成直线', () => {
		expect(MASCOT_CANVAS_PAD).toBeGreaterThanOrEqual(8);
		expect(MASCOT_CANVAS_VIEW).toBe(MASCOT_SIZE + 2 * MASCOT_CANVAS_PAD);
	});
});
