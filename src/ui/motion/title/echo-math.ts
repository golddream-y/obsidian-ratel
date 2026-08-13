/**
 * @file src/ui/motion/title/echo-math.ts
 * @description Echo Text 残影层偏移 — 对齐 react-bits Echo Text 的 lag/offset/fade
 * @module ui/motion/title/echo-math
 * @origin https://reactbits.dev/text-animations/echo-text
 */

export type EchoDirection = 'right' | 'left' | 'up' | 'down' | 'diagonal';
export type EchoEase = 'linear' | 'ease-out' | 'ease-in-out' | 'snappy';

/** 入场拖尾从哪一侧收拢 */
export function echoDirectionDelta(direction: EchoDirection): { x: number; y: number } {
	switch (direction) {
		case 'left':
			return { x: -1, y: 0 };
		case 'up':
			return { x: 0, y: -1 };
		case 'down':
			return { x: 0, y: 1 };
		case 'diagonal':
			return { x: 1, y: 1 };
		default:
			return { x: 1, y: 0 };
	}
}

/**
 * Echo 入场缓动。
 *
 * @param kind - 曲线名
 * @param t - 归一化进度 0–1
 */
export function echoEase(kind: EchoEase, t: number): number {
	const x = Math.min(1, Math.max(0, t));
	if (kind === 'linear') return x;
	if (kind === 'ease-in-out') {
		return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
	}
	if (kind === 'snappy') return 1 - (1 - x) ** 4;
	return x * (2 - x);
}

export interface EchoLayerStyle {
	x: number;
	y: number;
	opacity: number;
	blur: number;
}

/**
 * 计算第 i 层残影（0 = 最靠近正面）在入场进度下的位移与透明度。
 *
 * @param layerIndex - 残影序号，0 最近、echoes-1 最深
 * @param echoes - 残影层数
 * @param progress - 入场进度 0–1（未缓动）
 * @param offset - 最深层像素位移
 * @param lag - 深层滞后（0–1）
 * @param fade - 层间透明度衰减
 * @param blur - 最深层最大模糊 px
 * @param direction - 拖尾方向
 * @param ease - 入场曲线
 */
export function echoLayerStyle(
	layerIndex: number,
	echoes: number,
	progress: number,
	offset: number,
	lag: number,
	fade: number,
	blur: number,
	direction: EchoDirection,
	ease: EchoEase,
): EchoLayerStyle {
	const count = Math.max(1, echoes);
	const depth = (layerIndex + 1) / count;
	const delay = depth * Math.min(0.95, Math.max(0, lag));
	const local = echoEase(ease, (progress - delay) / Math.max(0.001, 1 - delay));
	const remain = 1 - local;
	const dir = echoDirectionDelta(direction);
	return {
		x: dir.x * offset * remain * depth,
		y: dir.y * offset * remain * depth,
		opacity: fade ** (layerIndex + 1),
		blur: blur * depth * Math.max(remain, 0.15),
	};
}
