/**
 * @file src/ui/chat/sticky-scroll.ts
 * @description 提供消息流贴底判定与忽略平滑样式的瞬时滚底能力
 * @module ui/chat/sticky-scroll
 */

/**
 * 判断滚动容器是否仍位于底部附近。
 *
 * @param scrollTop - 当前纵向滚动位置
 * @param scrollHeight - 容器全部内容高度
 * @param clientHeight - 容器可视区域高度
 * @param thresholdPx - 判定为贴底的最大剩余距离
 * @returns 距底部不超过阈值时返回 true
 * @example
 * isNearBottom(820, 1000, 100);
 */
export function isNearBottom(
	scrollTop: number,
	scrollHeight: number,
	clientHeight: number,
	thresholdPx = 80,
): boolean {
	return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

/**
 * 临时禁用元素行内平滑滚动，并立即跳到内容底部。
 *
 * @param el - 可滚动的消息容器
 * @returns 无返回值
 * @example
 * snapScrollToBottom(messagesEl);
 */
export function snapScrollToBottom(el: HTMLElement): void {
	const previousBehavior = el.style.scrollBehavior;
	// 修复:Obsidian 或旧样式可能启用 smooth，先覆盖为 auto 才能保证 sticky 滚底无动画。
	el.style.scrollBehavior = 'auto';
	el.scrollTop = el.scrollHeight;
	el.style.scrollBehavior = previousBehavior;
}
