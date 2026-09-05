/**
 * @file src/ui/mascot/paint.ts
 * @description 捣蛋鬼单帧 Canvas：软blob身体 + 平滑眼环
 * @module ui/mascot/paint
 * @depends ./eyes, ./sim
 */
import type { EyeRing } from './eyes';
import type { MascotBodyPose } from './sim';

export interface MascotPaintOptions {
	size: number;
	accent: string;
	eyeFill: string;
	leftRing: EyeRing;
	rightRing: EyeRing;
	body?: MascotBodyPose;
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
 */
export function ringToPath(ring: EyeRing, size: number): RingPath {
	return {
		closed: true,
		points: ring.map((p) => ({ x: p.x * size, y: p.y * size })),
	};
}

/**
 * 闭合二次曲线，8/16 点折线会发硬。
 */
function fillSmoothRing(ctx: CanvasRenderingContext2D, ring: EyeRing, size: number): void {
	const pts = ringToPath(ring, size).points;
	const n = pts.length;
	if (n < 3) return;
	const mid = (i: number, j: number) => ({
		x: (pts[i].x + pts[j].x) / 2,
		y: (pts[i].y + pts[j].y) / 2,
	});
	const first = mid(n - 1, 0);
	ctx.beginPath();
	ctx.moveTo(first.x, first.y);
	for (let i = 0; i < n; i++) {
		const nxt = (i + 1) % n;
		const m = mid(i, nxt);
		ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
	}
	ctx.closePath();
	ctx.fill();
}

function fillBlobBody(ctx: CanvasRenderingContext2D, rx: number, ry: number): void {
	const n = 24;
	const pts: Array<{ x: number; y: number }> = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2 - Math.PI / 2;
		const wobble = 1 + 0.05 * Math.cos(2 * a) + 0.032 * Math.sin(3 * a);
		let x = Math.cos(a) * rx * wobble;
		let y = Math.sin(a) * ry * wobble;
		if (y > 0) y *= 1.06;
		pts.push({ x, y });
	}
	const mid = (i: number, j: number) => ({
		x: (pts[i].x + pts[j].x) / 2,
		y: (pts[i].y + pts[j].y) / 2,
	});
	const first = mid(n - 1, 0);
	ctx.beginPath();
	ctx.moveTo(first.x, first.y);
	for (let i = 0; i < n; i++) {
		const nxt = (i + 1) % n;
		const m = mid(i, nxt);
		ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
	}
	ctx.closePath();
}

function parseRgbTriplet(color: string): [number, number, number] | null {
	const hex = color.replace('#', '').trim();
	if (hex.length === 6 || hex.length === 3) {
		const full = hex.length === 3 ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] : hex;
		if (/^[0-9a-fA-F]{6}$/.test(full)) {
			const n = parseInt(full, 16);
			return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
		}
	}
	const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function mixRgb(rgb: [number, number, number], amt: number): string {
	const t = amt < 0 ? 0 : 255;
	const a = Math.abs(amt);
	const r = Math.round(rgb[0] + (t - rgb[0]) * a);
	const g = Math.round(rgb[1] + (t - rgb[1]) * a);
	const b = Math.round(rgb[2] + (t - rgb[2]) * a);
	return `rgb(${r},${g},${b})`;
}

/**
 * 绘制一帧：blob 身体 + 平滑双眼（无瞳孔）。
 */
export function drawMascotFrame(ctx: CanvasRenderingContext2D, opts: MascotPaintOptions): void {
	const { size, accent, eyeFill, leftRing, rightRing } = opts;
	const body = opts.body ?? { scaleX: 1, scaleY: 1, rotate: 0, offsetY: 0 };
	const cx = size / 2;
	const cy = size / 2;
	const rx = size / 2 - 2.2;
	const ry = size / 2 - 2.6;

	ctx.save();
	ctx.translate(cx, cy + body.offsetY);
	ctx.rotate((body.rotate * Math.PI) / 180);
	ctx.scale(body.scaleX, body.scaleY);

	ctx.beginPath();
	fillBlobBody(ctx, rx, ry);
	const rgb = parseRgbTriplet(accent);
	if (typeof ctx.createRadialGradient === 'function' && rgb) {
		const grad = ctx.createRadialGradient(-rx * 0.28, -ry * 0.32, 2, 0, 0, rx);
		grad.addColorStop(0, mixRgb(rgb, 0.28));
		grad.addColorStop(0.52, accent);
		grad.addColorStop(1, mixRgb(rgb, -0.16));
		ctx.fillStyle = grad;
	} else {
		ctx.fillStyle = accent;
	}
	ctx.fill();

	ctx.translate(-cx, -cy);
	ctx.fillStyle = eyeFill;
	fillSmoothRing(ctx, leftRing, size);
	fillSmoothRing(ctx, rightRing, size);
	ctx.restore();
}
