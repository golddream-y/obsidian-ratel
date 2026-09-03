/**
 * @file src/ui/mascot/eyes.test.ts
 * @description 吉祥物眼环几何与插值测试
 * @module ui/mascot/eyes.test
 */
import { describe, it, expect } from 'vitest';
import { MASCOT_FACES } from './types';
import { getEyeRings, lerpRings, applyGaze, EYE_SAMPLES, type EyeRing } from './eyes';
import { drawMascotFrame, ringToPath, pickEyeFill } from './paint';

function meanX(ring: EyeRing): number {
	return ring.reduce((s, p) => s + p.x, 0) / ring.length;
}

describe('getEyeRings', () => {
	it('每张脸 - 左右环长度均为采样点数', () => {
		for (const face of MASCOT_FACES) {
			const { left, right } = getEyeRings(face);
			expect(left.length).toBe(EYE_SAMPLES);
			expect(right.length).toBe(EYE_SAMPLES);
		}
	});
});

describe('lerpRings', () => {
	const a = getEyeRings('idle').left;
	const b = getEyeRings('thinking').left;

	it('t=0 - 等于起点', () => {
		const r = lerpRings(a, b, 0);
		for (let i = 0; i < EYE_SAMPLES; i++) {
			expect(r[i].x).toBeCloseTo(a[i].x, 8);
			expect(r[i].y).toBeCloseTo(a[i].y, 8);
		}
	});

	it('t=1 - 等于终点', () => {
		const r = lerpRings(a, b, 1);
		for (let i = 0; i < EYE_SAMPLES; i++) {
			expect(r[i].x).toBeCloseTo(b[i].x, 8);
			expect(r[i].y).toBeCloseTo(b[i].y, 8);
		}
	});
});

describe('applyGaze', () => {
	const ring = getEyeRings('idle').left;

	it('视线 0 - 坐标不变', () => {
		const out = applyGaze(ring, 0, 0);
		for (let i = 0; i < EYE_SAMPLES; i++) {
			expect(out[i].x).toBeCloseTo(ring[i].x, 8);
			expect(out[i].y).toBeCloseTo(ring[i].y, 8);
		}
	});

	it('gazeX=1 - 平均 x 增大', () => {
		const out = applyGaze(ring, 1, 0);
		expect(meanX(out)).toBeGreaterThan(meanX(ring));
	});
});

describe('paint', () => {
	it('drawMascotFrame - mock ctx 不抛错', () => {
		const calls: string[] = [];
		const ctx = {
			save: () => calls.push('save'),
			restore: () => calls.push('restore'),
			beginPath: () => calls.push('beginPath'),
			closePath: () => calls.push('closePath'),
			fill: () => calls.push('fill'),
			moveTo: () => {},
			lineTo: () => {},
			arc: () => {},
			ellipse: () => {},
			quadraticCurveTo: () => {},
			translate: () => {},
			rotate: () => {},
			scale: () => {},
			createRadialGradient: () => ({ addColorStop: () => {} }),
			fillStyle: '',
		} as unknown as CanvasRenderingContext2D;

		const { left, right } = getEyeRings('idle');
		drawMascotFrame(ctx, {
			size: 48,
			accent: '#3366ff',
			eyeFill: '#ffffff',
			leftRing: left,
			rightRing: right,
		});
		expect(calls).toContain('closePath');
	});

	it('ringToPath - 闭合路径', () => {
		const ring = getEyeRings('idle').left;
		const path = ringToPath(ring, 48);
		expect(path.closed).toBe(true);
	});

	it('浅色身体 - 整眼用深色 - 不是眼白加点', () => {
		expect(pickEyeFill('#e8e4dc')).toBe('#1a1816');
	});
	it('深色身体 - 整眼用浅奶油色', () => {
		expect(pickEyeFill('#2a1f4a')).toBe('#f4f0ea');
	});
});
