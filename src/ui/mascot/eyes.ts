/**
 * @file src/ui/mascot/eyes.ts
 * @description 捣蛋鬼眼环几何：椭圆 + 眼皮，按状态换形状
 * @module ui/mascot/eyes
 * @depends ./types
 *
 * 弹簧换脸插值手法参考 MIT blob-eyes 类开源实现；点列与参数为 Ratel 原创。
 */
import type { MascotFace } from './types';

/** 每只眼采样点数 — 多于折线 8 点，闭合曲线才圆 */
export const EYE_SAMPLES = 16;
export interface EyePoint {
	x: number;
	y: number;
}

/** 单眼闭合环 */
export type EyeRing = EyePoint[];

const FACE_CLAMP_MIN = 0.04;
const FACE_CLAMP_MAX = 0.96;
const GAZE_TRANSLATE_X = 0.1;
const GAZE_TRANSLATE_Y = 0.08;

interface EyeShape {
	cx: number;
	cy: number;
	rx: number;
	ry: number;
	tilt?: number;
	/** 0–1，把上半（屏幕上方、更小 y）压向中线 */
	lidTop?: number;
	/** 0–1，把下半压向中线 */
	lidBottom?: number;
}

const LEFT_CX = 0.34;
const RIGHT_CX = 0.66;
const BASE_CY = 0.44;

/** 各脸档眼形参数 — 自绘椭圆采样，非拷贝外部点列 */
const FACE_SHAPES: Record<MascotFace, { left: EyeShape; right: EyeShape }> = {
	idle: {
		left: { cx: LEFT_CX - 0.01, cy: BASE_CY, rx: 0.105, ry: 0.125 },
		right: { cx: RIGHT_CX + 0.01, cy: BASE_CY + 0.008, rx: 0.1, ry: 0.12 },
	},
	waiting: {
		left: { cx: LEFT_CX, cy: BASE_CY + 0.02, rx: 0.048, ry: 0.05 },
		right: { cx: RIGHT_CX, cy: BASE_CY + 0.02, rx: 0.048, ry: 0.05 },
	},
	thinking: {
		left: { cx: LEFT_CX, cy: BASE_CY + 0.03, rx: 0.11, ry: 0.038, lidTop: 0.35, lidBottom: 0.25 },
		right: { cx: RIGHT_CX, cy: BASE_CY + 0.03, rx: 0.1, ry: 0.048, lidTop: 0.2, lidBottom: 0.15 },
	},
	working: {
		left: { cx: LEFT_CX, cy: BASE_CY - 0.01, rx: 0.118, ry: 0.13 },
		right: { cx: RIGHT_CX, cy: BASE_CY - 0.01, rx: 0.118, ry: 0.13 },
	},
	speaking: {
		left: { cx: LEFT_CX, cy: BASE_CY - 0.02, rx: 0.1, ry: 0.155 },
		right: { cx: RIGHT_CX, cy: BASE_CY - 0.02, rx: 0.1, ry: 0.155 },
	},
	listening: {
		left: { cx: LEFT_CX + 0.01, cy: BASE_CY + 0.08, rx: 0.1, ry: 0.07, lidTop: 0.12 },
		right: { cx: RIGHT_CX - 0.01, cy: BASE_CY + 0.08, rx: 0.1, ry: 0.07, lidTop: 0.12 },
	},
	error: {
		left: { cx: LEFT_CX - 0.01, cy: BASE_CY, rx: 0.1, ry: 0.055, tilt: 0.72 },
		right: { cx: RIGHT_CX + 0.01, cy: BASE_CY, rx: 0.1, ry: 0.055, tilt: -0.72 },
	},
	stopped: {
		left: { cx: LEFT_CX, cy: BASE_CY + 0.05, rx: 0.1, ry: 0.08, lidTop: 0.78 },
		right: { cx: RIGHT_CX, cy: BASE_CY + 0.05, rx: 0.1, ry: 0.08, lidTop: 0.78 },
	},
};

/**
 * 椭圆采样闭合环，起点在顶部。
 *
 * @param shape - 眼心、半径与倾斜
 * @returns 闭合环
 */
function sampleEyeRing(shape: EyeShape): EyeRing {
	const { cx, cy, rx, ry, tilt = 0, lidTop = 0, lidBottom = 0 } = shape;
	const cos = Math.cos(tilt);
	const sin = Math.sin(tilt);
	const ring: EyeRing = [];
	for (let i = 0; i < EYE_SAMPLES; i++) {
		const angle = (i / EYE_SAMPLES) * Math.PI * 2 - Math.PI / 2;
		let lx = rx * Math.cos(angle);
		let ly = ry * Math.sin(angle);
		// 屏幕 y 向下：ly < 0 是眼顶。lidTop 把上眼皮压下来，形成缝或月牙。
		if (ly < 0 && lidTop > 0) ly *= 1 - lidTop;
		if (ly > 0 && lidBottom > 0) ly *= 1 - lidBottom;
		const x = cx + lx * cos - ly * sin;
		const y = cy + lx * sin + ly * cos;
		ring.push({ x, y });
	}
	return ring;
}

/**
 * 取指定脸档的左右眼环。
 *
 * @param face - 捣蛋鬼脸档
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
