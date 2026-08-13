/**
 * @file src/ui/motion/prefs.ts
 * @description 聊天装饰动效总闸门（设置 ∩ reduced-motion）
 * @module ui/motion/prefs
 */

export function prefersMotionReduced(): boolean {
	if (typeof matchMedia === 'undefined') return false;
	return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 是否播放装饰动效（空态/入场/扫光/火花）。忙态 ThinkingOrb 自有闸门，不经此函数。
 *
 * @param settings - 含可选 `chatMotionEnabled` 的设置片段
 * @returns 设置未关闭且系统未请求减少动效时为 true
 */
export function isChatMotionEnabled(settings: { chatMotionEnabled?: boolean }): boolean {
	if (settings.chatMotionEnabled === false) return false;
	return !prefersMotionReduced();
}
