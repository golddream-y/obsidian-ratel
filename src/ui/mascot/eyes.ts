/**
 * @file src/ui/mascot/eyes.ts
 * @description 吉祥物眼环几何：每脸左右 8 点闭合多边形
 * @module ui/mascot/eyes
 * @depends ./types
 *
 * 弹簧换脸插值手法参考 MIT blob-eyes 类开源实现；点列与参数为 Ratel 原创。
 */
import type { MascotFace } from './types';

/** 脸框内归一化坐标点 */
export interface EyePoint {
	x: number;
	y: number;
}

/** 单眼 8 点闭合环 */
export type EyeRing = EyePoint[];

const FACE_CLAMP_MIN = 0.04;
const FACE_CLAMP_MAX = 0.96;
const GAZE_TRANSLATE_X = 0.07;
const GAZE_TRANSLATE_Y = 0.05;

interface EyeShape {
	cx: number;
	cy: number;
	rx: number;
	ry: number;
	tilt?: number;
}

const LEFT_CX = 0.34;
const RIGHT_CX = 0.66;
const BASE_CY = 0.44;

/** 各脸档眼形参数 — 自绘椭圆采样，非拷贝外部点列 */
const FACE_SHAPES: Record<MascotFace, { left: EyeShape; right: EyeShape }> = {
	idle: {
		left: { cx: LEFT_CX, cy: BASE_CY, rx: 0.09, ry: 0.11 },
		right: { cx: RIGHT_CX, cy: BASE_CY, rx: 0.09, ry: 0.11 },
	},
	thinking: {
		left: { cx: LEFT_CX, cy: BASE_CY + 0.02, rx: 0.1, ry: 0.05 },
		right: { cx: RIGHT_CX, cy: BASE_CY + 0.02, rx: 0.1, ry: 0.05 },
	},
	error: {
		left: { cx: LEFT_CX - 0.02, cy: BASE_CY, rx: 0.085, ry: 0.09, tilt: -0.35 },
		right: { cx: RIGHT_CX + 0.02, cy: BASE_CY, rx: 0.085, ry: 0.09, tilt: 0.35 },
	},
	stopped: {
		left: { cx: LEFT_CX, cy: BASE_CY + 0.04, rx: 0.085, ry: 0.07, tilt: 0.25 },
		right: { cx: RIGHT_CX, cy: BASE_CY + 0.04, rx: 0.085, ry: 0.07, tilt: -0.25 },
	},
	waiting: {
		left: { cx: LEFT_CX, cy: BASE_CY + 0.02, rx: 0.07, ry: 0.07 },
		right: { cx: RIGHT_CX, cy: BASE_CY + 0.02, rx: 0.07, ry: 0.07 },
	},
	working: {
		left: { cx: LEFT_CX, cy: BASE_CY, rx: 0.095, ry: 0.1 },
		right: { cx: RIGHT_CX, cy: BASE_CY, rx: 0.095, ry: 0.1 },
	},
	speaking: {
		left: { cx: LEFT_CX, cy: BASE_CY - 0.01, rx: 0.11, ry: 0.14 },
		right: { cx: RIGHT_CX, cy: BASE_CY - 0.01, rx: 0.11, ry: 0.14 },
	},
	listening: {
		left: { cx: LEFT_CX + 0.01, cy: BASE_CY + 0.06, rx: 0.1, ry: 0.08 },
		right: { cx: RIGHT_CX - 0.01, cy: BASE_CY + 0.06, rx: 0.1, ry: 0.08 },
	},
};

/**
 * 椭圆 8 点采样，起点在顶部。
 *
 * @param shape - 眼心、半径与倾斜
 * @returns 8 点闭合环
 */
function sampleEyeRing(shape: EyeShape): EyeRing {
	const { cx, cy, rx, ry, tilt = 0 } = shape;
	const cos = Math.cos(tilt);
	const sin = Math.sin(tilt);
	const ring: EyeRing = [];
	for (let i = 0; i < 8; i++) {
		const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
		const lx = rx * Math.cos(angle);
		const ly = ry * Math.sin(angle);
		const x = cx + lx * cos - ly * sin;
		const y = cy + lx * sin + ly * cos;
		ring.push({ x, y });
	}
	return ring;
}

/**
 * 取指定脸档的左右眼环。
 *
 * @param face - 吉祥物脸档
 * @returns 左右眼 8 点环
 */
export function getEyeRings(face: MascotFace): { left: EyeRing; right: EyeRing } {
	const shapes = FACE_SHAPES[face];
	return {
		left: sampleEyeRing(shapes.left),
		right: sampleEyeRing(shapes.right),
	};
}

/**
 * 两眼环线性插值。
 *
 * @param a - 起点环
 * @param b - 终点环
 * @param t - 插值系数 0–1
 * @returns 插值后的环
 */
export function lerpRings(a: EyeRing, b: EyeRing, t: number): EyeRing {
	const clamped = Math.min(1, Math.max(0, t));
	return a.map((p, i) => ({
		x: p.x + (b[i].x - p.x) * clamped,
		y: p.y + (b[i].y - p.y) * clamped,
	}));
}

/**
 * 将单点 clamp 到脸框内。
 *
 * @param p - 归一化点
 * @returns clamp 后的点
 */
function clampPoint(p: EyePoint): EyePoint {
	return {
		x: Math.min(FACE_CLAMP_MAX, Math.max(FACE_CLAMP_MIN, p.x)),
		y: Math.min(FACE_CLAMP_MAX, Math.max(FACE_CLAMP_MIN, p.y)),
	};
}

/**
 * 视线平移眼环，平移后 clamp 在脸框内。
 *
 * @param ring - 原始眼环
 * @param gazeX - 水平视线 -1..1（调用方已限幅）
 * @param gazeY - 垂直视线 -1..1
 * @returns 平移并 clamp 后的眼环
 */
export function applyGaze(ring: EyeRing, gazeX: number, gazeY: number): EyeRing {
	const dx = gazeX * GAZE_TRANSLATE_X;
	const dy = gazeY * GAZE_TRANSLATE_Y;
	return ring.map((p) => clampPoint({ x: p.x + dx, y: p.y + dy }));
}

/**
 * 眨眼：垂直压扁眼环。
 *
 * @param ring - 眼环
 * @param amount - 0 睁开，1 闭眼
 * @returns 压扁后的环
 */
export function squashRing(ring: EyeRing, amount: number): EyeRing {
	const t = Math.min(1, Math.max(0, amount));
	const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
	return ring.map((p) => ({
		x: p.x,
		y: cy + (p.y - cy) * (1 - t * 0.92),
	}));
}
