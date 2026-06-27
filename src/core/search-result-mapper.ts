/**
 * @file src/core/search-result-mapper.ts
 * @description 把 search_vault 工具的原始结果扁平化为 search.result 事件 payload
 * @module core/search-result-mapper
 */

/** 扁平化后的单条搜索结果(UI 友好,无嵌套 metadata) */
export interface SearchResultItem {
	docId: string;
	score: number;
	path: string;
	index: number;
}

/** search_vault 原始结果的条目形状(含嵌套 metadata) */
interface RawSearchResult {
	docId: string;
	score: number;
	metadata: { path?: string };
	index: number;
	reranked?: boolean;
}

/**
 * 把 search_vault 工具的原始结果扁平化为 AgentEvent.search.result 的 payload。
 *
 * 从 metadata.path 提取 path,避免 UI 层再嵌套解析 metadata。
 * 从结果推断是否经过 Rerank;无 reranked 字段时降级 false。
 *
 * @param rawResults - search_vault 工具返回的原始结果(期望数组)
 * @returns `{ results, reranked }`;若输入非数组或过滤后为空,返回 null
 */
export function mapSearchResults(
	rawResults: unknown,
): { results: SearchResultItem[]; reranked: boolean } | null {
	if (!Array.isArray(rawResults)) return null;

	const raw = rawResults as RawSearchResult[];
	const results = raw
		.filter((r) => r && r.metadata && typeof r.metadata.path === 'string')
		.map((r) => ({
			docId: r.docId,
			score: r.score,
			path: r.metadata.path as string,
			index: r.index,
		}));

	if (results.length === 0) return null;

	const reranked = raw.some((r) => r.reranked === true);
	return { results, reranked };
}
