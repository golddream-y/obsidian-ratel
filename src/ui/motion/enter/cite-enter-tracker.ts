/**
 * @file src/ui/motion/enter/cite-enter-tracker.ts
 * @description 消息级 cite 入场 play-once（流式 innerHTML 重建 DOM 时防重播）
 * @module ui/motion/enter/cite-enter-tracker
 */

const seenByMessage = new Map<string, Set<number>>();

/**
 * 若该消息下该 cite 序号尚未播过入场，标记并返回 true。
 *
 * @param messageId - 消息 id
 * @param index - cite 序号
 * @returns 首次应播时为 true
 */
export function markCiteEnterIfNew(messageId: string, index: number): boolean {
	let set = seenByMessage.get(messageId);
	if (!set) {
		set = new Set();
		seenByMessage.set(messageId, set);
	}
	if (set.has(index)) return false;
	set.add(index);
	return true;
}
