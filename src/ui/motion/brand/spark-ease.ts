/**
 * @file src/ui/motion/brand/spark-ease.ts
 * @description ClickSpark 粒子缓动 — 上游 ease-out: t*(2-t)
 * @module ui/motion/brand/spark-ease
 */

/**
 * ease-out 缓动 — 与 react-bits ClickSpark 默认 easing 一致。
 *
 * @param t - 归一化进度 0–1
 * @returns 缓动后的进度 0–1
 */
export function sparkEaseOut(t: number): number {
	return t * (2 - t);
}
