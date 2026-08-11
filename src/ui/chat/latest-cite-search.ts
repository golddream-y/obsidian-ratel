/**
 * @file src/ui/chat/latest-cite-search.ts
 * @description 会话内最近一次 searchResults — 跟进回合正文 [n] 仍可挂钩
 * @module ui/chat/latest-cite-search
 */

/** 与 Message.searchResults 条目同形 */
export type CiteSearchHit = {
	docId: string;
	score: number;
	path: string;
	index: number;
};

/**
 * 从消息流中取「最近一次」挂载的 searchResults(自后向前)。
 *
 * 跟进问答常不再次 search_vault,但模型仍写 [n];此时需用本结果做 cite 增强,
 * 不能只认当前气泡自己的 searchResults。
 *
 * @param messages - UI 消息列表
 * @returns 最近非空 searchResults;没有则 null
 */
export function latestCiteSearchResults(
	messages: ReadonlyArray<{ searchResults?: CiteSearchHit[] }>,
): CiteSearchHit[] | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const hits = messages[i]?.searchResults;
		if (hits && hits.length > 0) return hits;
	}
	return null;
}
