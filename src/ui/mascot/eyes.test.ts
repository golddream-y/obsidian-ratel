/**
 * @file src/ui/mascot/eyes.test.ts
 * @description 捣蛋鬼眼环几何与插值测试
 * @module ui/mascot/eyes.test
 */
import { describe, it, expect } from 'vitest';
import { MASCOT_FACES } from './types';
import { getEyeRings, lerpRings, applyGaze, EYE_SAMPLES, type EyeRing } from './eyes';
import { drawMascotFrame, ringToPath } from './paint';

function meanX(ring: EyeRing): number {
	return ring.reduce((s, p) => s + p.x, 0) / ring.length;
}

function meanY(ring: EyeRing): number {
	return ring.reduce((s, p) => s + p.y, 0) / ring.length;
}

function ringWidth(ring: EyeRing): number {
	const xs = ring.map((p) => p.x);
	return Math.max(...xs) - Math.min(...xs);
}

function ringHeight(ring: EyeRing): number {
	const ys = ring.map((p) => p.y);
	return Math.max(...ys) - Math.min(...ys);
}

/** 左眼内侧是更大的 x */
function leftEyeInnerOuterY(ring: EyeRing): { innerY: number; outerY: number } {
	let inner = ring[0];
	let outer = ring[0];
	for (const p of ring) {
		if (p.x > inner.x) inner = p;
		if (p.x < outer.x) outer = p;
	}
	return { innerY: inner.y, outerY: outer.y };
}

/** 右眼内侧是更小的 x */
function rightEyeInnerOuterY(ring: EyeRing): { innerY: number; outerY: number } {
	let inner = ring[0];
	let outer = ring[0];
	for (const p of ring) {
		if (p.x < inner.x) inner = p;
		if (p.x > outer.x) outer = p;
	}
	return { innerY: inner.y, outerY: outer.y };
}

describe('getEyeRings', () => {
	it('每张脸 - 左右环长度均为采样点数', () => {
		for (const face of MASCOT_FACES) {
			const { left, right } = getEyeRings(face);
			expect(left.length).toBe(EYE_SAMPLES);
			expect(right.length).toBe(EYE_SAMPLES);
		}
	});
	it('思考缝 - 垂直幅度小于闲着圆眼', () => {
		expect(ringHeight(getEyeRings('thinking').left)).toBeLessThan(ringHeight(getEyeRings('idle').left) * 0.55);
	});
	it('等待圆点 - 包围盒小于闲着', () => {
		expect(ringWidth(getEyeRings('waiting').left)).toBeLessThan(ringWidth(getEyeRings('idle').left) * 0.85);
		expect(ringHeight(getEyeRings('waiting').left)).toBeLessThan(ringHeight(getEyeRings('idle').left) * 0.85);
	});
	it('说话 - 高于闲着', () => {
		expect(ringHeight(getEyeRings('speaking').left)).toBeGreaterThan(ringHeight(getEyeRings('idle').left));
	});
	it('倾听 - 平均 y 大于闲着 - 更靠下', () => {
		expect(meanY(getEyeRings('listening').left)).toBeGreaterThan(meanY(getEyeRings('idle').left));
	});
	it('报错 - 左眼内角低于外角 - 内八', () => {
		const { innerY, outerY } = leftEyeInnerOuterY(getEyeRings('error').left);
		expect(innerY).toBeGreaterThan(outerY);
	});
	it('报错 - 右眼内角低于外角 - 内八', () => {
		const { innerY, outerY } = rightEyeInnerOuterY(getEyeRings('error').right);
		expect(innerY).toBeGreaterThan(outerY);
	});
	it('停止月牙 - 上沿更贴中线 - 下沿更鼓', () => {
		const ring = getEyeRings('stopped').left;
		const cy = meanY(ring);
		const topGap = cy - Math.min(...ring.map((p) => p.y));
		const botGap = Math.max(...ring.map((p) => p.y)) - cy;
		expect(ringHeight(ring)).toBeLessThan(ringHeight(getEyeRings('idle').left));
		expect(topGap).toBeLessThan(botGap * 0.85);
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
});
