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

/** 瞬时滚底时挂上，用 CSS 压过主题/Obsidian 的 scroll-behavior:smooth */
export const SCROLL_SNAP_CLASS = 'ratel-scroll-snap';

/**
 * 临时挂瞬时滚底 class，并立即跳到内容底部。
 *
 * @param el - 可滚动的消息容器
 * @returns 无返回值
 * @example
 * snapScrollToBottom(messagesEl);
 */
export function snapScrollToBottom(el: HTMLElement): void {
	// 修复:商店 checker 禁止 element.style 赋值；用 class 压过可能存在的 smooth。
	el.classList.add(SCROLL_SNAP_CLASS);
	el.scrollTop = el.scrollHeight;
	el.classList.remove(SCROLL_SNAP_CLASS);
}
