/**
 * @file src/ui/motion/enter/fade-play-policy.ts
 * @description 消息气泡 FadeIn 播放策略 — hydrate / 会话切换不播，仅新消息入场
 * @module ui/motion/enter/fade-play-policy
 */

/**
 * 计算单条消息是否应播放 FadeIn。
 *
 * @param id - 消息 id
 * @param enteredIds - 已入场（或 hydrate 种子）的 id 集合
 * @param motionOn - 动效总闸
 * @returns 是否向 FadeIn 传 play=true
 */
export function computeFadePlay(
	id: string,
	enteredIds: ReadonlySet<string>,
	motionOn: boolean,
): boolean {
	if (!motionOn) return false;
	return !enteredIds.has(id);
}

/**
 * 会话切换或 hydrate 时种子 enteredIds，首帧全部不播 FadeIn。
 *
 * @param messageIds - 当前消息流 id 列表
 */
export function reseedEnteredIds(messageIds: string[]): Set<string> {
	return new Set(messageIds);
}
