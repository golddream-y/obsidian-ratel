/**
 * @file src/ui/motion/chrome/animated-list-policy.ts
 * @description 菜单列表项 stagger 延迟策略 — 超 cap 项整组一次入场
 * @module ui/motion/chrome/animated-list-policy
 */

/** 超过此索引的项不再单独 stagger，由调用方给 0ms 整组一次 */
export const ANIMATED_LIST_STAGGER_CAP = 24;

/** 每项 stagger 步进（毫秒） */
export const ANIMATED_LIST_STAGGER_STEP_MS = 40;

/**
 * 计算列表项入场 animation-delay。
 *
 * @param index - 项在列表中的索引（0-based）
 * @param cap - 可选 cap，默认 {@link ANIMATED_LIST_STAGGER_CAP}
 * @returns 延迟毫秒；`index >= cap` 时返回 `null`（调用方应给 0）
 */
export function staggerDelayMs(
	index: number,
	cap = ANIMATED_LIST_STAGGER_CAP,
): number | null {
	if (index >= cap) return null;
	return index * ANIMATED_LIST_STAGGER_STEP_MS;
}
