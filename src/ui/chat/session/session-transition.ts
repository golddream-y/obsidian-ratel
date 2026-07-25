/**
 * @file src/ui/chat/session/session-transition.ts
 * @description 会话切换动效时长常量与 loading 补齐
 * @module ui/chat/session/session-transition
 */

/** 消息区退出动画时长(ms) */
export const SESSION_EXIT_MS = 150;
/** 消息区进入动画时长(ms) */
export const SESSION_ENTER_MS = 220;
/** loading 遮罩最少展示时长,避免闪一下 */
export const SESSION_LOADING_MIN_MS = 160;

/**
 * 计算还需等待多久才能结束 loading(保证不低于 minMs)。
 *
 * @param elapsedMs - 已经历的读盘/hydrate 毫秒
 * @param minMs - 下限展示
 * @returns 还需 sleep 的毫秒(≥0)
 */
export function loadingPadMs(elapsedMs: number, minMs: number = SESSION_LOADING_MIN_MS): number {
	return Math.max(0, minMs - Math.max(0, elapsedMs));
}

/**
 * 是否应跳过位移动画(仍可显示静态 loading)。
 */
export function prefersReducedMotion(): boolean {
	if (typeof window === 'undefined' || !window.matchMedia) return false;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
