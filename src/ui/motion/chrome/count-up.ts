/**
 * @file src/ui/motion/chrome/count-up.ts
 * @description StatusLine 上下文 % CountUp 缓动与线性插值
 * @module ui/motion/chrome/count-up
 */

/**
 * ease-out cubic — 与 react-bits CountUp 默认曲线一致：`1 - (1-t)^3`。
 *
 * @param t - 归一化进度 0–1
 * @returns 缓动后的进度 0–1
 */
export function easeOutCount(t: number): number {
	return 1 - (1 - t) ** 3;
}

/**
 * 在 from 与 to 之间按 t 线性插值。
 *
 * @param from - 起始值
 * @param to - 目标值
 * @param t - 插值系数 0–1
 * @returns 插值结果
 */
export function lerpCount(from: number, to: number, t: number): number {
	return from + (to - from) * t;
}
