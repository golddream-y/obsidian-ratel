/**
 * @file src/ui/motion/empty/rotate-hint-policy.ts
 * @description 空态副句轮换索引策略
 * @module ui/motion/empty/rotate-hint-policy
 */

/**
 * 计算下一条副句索引；末项后回到 0，空列表恒为 0。
 *
 * @param i - 当前索引
 * @param len - 副句总数
 * @returns 下一条索引
 */
export function nextHintIndex(i: number, len: number): number {
	if (len <= 0) return 0;
	return (i + 1) % len;
}
