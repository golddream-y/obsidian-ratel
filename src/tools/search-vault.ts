/**
 * @file src/tools/search-vault.ts
 * @description `search_vault` 工具 — 在知识库中做多查询混合搜索 + RRF + 可选 Rerank,返回带 index + reranked 的结果
 * @module tools/search-vault
 * @depends core/tool-registry, core/multi-query-searcher, ports/llm
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { MultiQuerySearcher } from '../core/multi-query-searcher';
import { tNow } from '../i18n';

// 默认返回结果数,与 JSON schema 中的 default 保持一致。
const DEFAULT_TOP_K = 5;

/**
 * 构造 `search_vault` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 内部调用 MultiQuerySearcher.search,对 LLM 透明(改写 + 多查询 + RRF + Rerank 均在内部)。
 * - 只返回 docId + score + metadata + index + reranked,不返回 chunk 原文,让模型自主用 read_note 读取。
 * - `definition` 由调用方通过 Composer 生成后注入。
 *
 * @param searcher - MultiQuerySearcher 实例,编排多查询 + RRF + Rerank。
 * @param getSearchReady - 检索就绪检查;未就绪时抛 INDEX_NOT_READY。
 * @param definition - LLM 侧 schema,由 `composeToolDefinitions` 生成。
 * @returns 符合 `Tool` 接口的工具定义。
 */
export function createSearchVaultTool(
	searcher: MultiQuerySearcher,
	getSearchReady: () => boolean,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (!getSearchReady()) {
				const err = new Error(tNow('error.search.notReady'));
				(err as Error & { code?: string }).code = 'INDEX_NOT_READY';
				throw err;
			}
			if (typeof args.query !== 'string' || args.query.length === 0) {
				throw new Error(tNow('error.tool.invalidQuery', { label: 'query' }));
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
