/**
 * @file src/ui/motion/enter/cite-policy.ts
 * @description 引用 chip / 内联 [n] 入场 stagger 策略
 * @module ui/motion/enter/cite-policy
 */

/** 每个 chip 递增延迟（each 模式） */
export const CITE_EACH_STAGGER_MS = 40;

/**
 * 引用数量较多时整组一次 fade，避免长串 stagger。
 *
 * @param count - 引用条数（chip 或有效 index 数）
 * @returns `each` 逐条 stagger；`group` 整组同时
 */
export function shouldStaggerCite(count: number): 'each' | 'group' {
	return count >= 8 ? 'group' : 'each';
}
