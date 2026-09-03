/**
 * @file src/ui/mascot/paint.ts
 * @description 吉祥物单帧 Canvas 绘制
 * @module ui/mascot/paint
 * @depends ./eyes
 */
import type { EyeRing } from './eyes';

export interface MascotPaintOptions {
	size: number;
	accent: string;
	eyeFill: string;
	leftRing: EyeRing;
	rightRing: EyeRing;
}

export interface RingPath {
	closed: boolean;
	points: Array<{ x: number; y: number }>;
}

/**
 * 将归一化眼环转为像素路径点列。
 *
 * @param ring - 0–1 脸框内眼环
 * @param size - 画布逻辑边长
 * @returns 像素坐标与闭合标记
 */
export function ringToPath(ring: EyeRing, size: number): RingPath {
	return {
		closed: true,
		points: ring.map((p) => ({ x: p.x * size, y: p.y * size })),
	};
}

/**
 * 在 Canvas 上绘制眼环路径。
 *
 * @param ctx - 2D 上下文
 * @param ring - 眼环
 * @param size - 逻辑边长
 */
function strokeRing(ctx: CanvasRenderingContext2D, ring: EyeRing, size: number): void {
	const path = ringToPath(ring, size);
	ctx.beginPath();
	ctx.moveTo(path.points[0].x, path.points[0].y);
	for (let i = 1; i < path.points.length; i++) {
		ctx.lineTo(path.points[i].x, path.points[i].y);
	}
	ctx.closePath();
}

/**
 * 绘制吉祥物一帧：圆身 + 双眼填充。
 *
 * @param ctx - 2D 上下文（调用方负责 setTransform / clear）
 * @param opts - 颜色与眼环
 */
export function drawMascotFrame(ctx: CanvasRenderingContext2D, opts: MascotPaintOptions): void {
	const { size, accent, eyeFill, leftRing, rightRing } = opts;
	const cx = size / 2;
	const cy = size / 2;
	const radius = size / 2 - 1;

	ctx.save();
	ctx.beginPath();
	ctx.arc(cx, cy, radius, 0, Math.PI * 2);
	ctx.closePath();
	ctx.fillStyle = accent;
	ctx.fill();

	ctx.fillStyle = eyeFill;
	strokeRing(ctx, leftRing, size);
	ctx.fill();
	strokeRing(ctx, rightRing, size);
	ctx.fill();
	ctx.restore();
}
