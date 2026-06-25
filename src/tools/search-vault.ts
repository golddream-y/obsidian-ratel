/**
 * @file src/tools/search-vault.ts
 * @description `search_vault` 工具 — 在知识库中做多查询混合搜索 + RRF + 可选 Rerank,返回带 index + reranked 的结果
 * @module tools/search-vault
 * @depends core/tool-registry, core/multi-query-searcher
 */

import type { Tool } from '../core/tool-registry';
import type { MultiQuerySearcher } from '../core/multi-query-searcher';

// 默认返回结果数,与 JSON schema 中的 default 保持一致。
const DEFAULT_TOP_K = 5;

/**
 * 构造 `search_vault` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 内部调用 MultiQuerySearcher.search,对 LLM 透明(改写 + 多查询 + RRF + Rerank 均在内部)。
 * - 只返回 docId + score + metadata + index + reranked,不返回 chunk 原文,让模型自主用 read_note 读取。
 *
 * @param searcher - MultiQuerySearcher 实例,编排多查询 + RRF + Rerank。
 * @param getSearchReady - 检索就绪检查;未就绪时抛 INDEX_NOT_READY。
 * @returns 符合 `Tool` 接口的工具定义。
 */
export function createSearchVaultTool(
	searcher: MultiQuerySearcher,
	getSearchReady: () => boolean,
): Tool {
	return {
		definition: {
			name: 'search_vault',
			description: 'Search the vault for notes relevant to a query. Uses multi-query hybrid search (vector + BM25) with RRF fusion and optional reranking. Returns ranked results with index numbers for citation. Use read_note to fetch full content of promising results.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query (e.g. "project tech stack")',
					},
					topK: {
						type: 'number',
						description: `Maximum number of results to return (default: ${DEFAULT_TOP_K})`,
						default: DEFAULT_TOP_K,
					},
				},
				required: ['query'],
			},
		},
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (!getSearchReady()) {
				const err = new Error('索引或 Embedding 尚未就绪,请稍候或在设置 → 诊断测试中检查');
				(err as Error & { code?: string }).code = 'INDEX_NOT_READY';
				throw err;
			}
			if (typeof args.query !== 'string' || args.query.length === 0) {
				throw new Error('search_vault 参数 query 必须是有效字符串');
			}
			const query = args.query;
			const topK = typeof args.topK === 'number' ? args.topK : DEFAULT_TOP_K;

			// 关键路径:MultiQuerySearcher 内部编排改写 + 多查询 + RRF + 可选 Rerank。
			// 对 LLM 透明:LLM 仍用 search_vault({query, topK}) 调用。
			const results = await searcher.search(query, topK);

			// 关键路径:加 index 编号(从 1 开始),供 LLM 用 [1][2] 引用。
			// reranked 由 MultiQuerySearcher 填充,这里透传不覆盖。
			return results.map((r, i) => ({
				...r,
				index: i + 1,
			}));
		},
	};
}
