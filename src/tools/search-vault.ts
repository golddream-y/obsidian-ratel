/**
 * @file src/tools/search-vault.ts
 * @description `search_vault` 工具 — 在知识库中做多查询混合搜索 + RRF + 可选 Rerank,返回带 index + reranked 的结果
 * @module tools/search-vault
 * @depends core/tool-registry, core/multi-query-searcher, ports/llm
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { MultiQuerySearcher } from '../core/multi-query-searcher';
import type { VaultMetadata, VaultPort } from '../ports/vault';
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
 * @param vault - Vault 端口,用于补充实时标签与反向链接数量。
 * @returns 符合 `Tool` 接口的工具定义。
 */
export function createSearchVaultTool(
	searcher: MultiQuerySearcher,
	getSearchReady: () => boolean,
	definition: ToolDefinition,
	vault: VaultPort,
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

			// 关键路径:索引结果可能滞后于当前笔记元数据，返回时从 metadataCache 补充实时结构信号。
			return results.map((r, i) => {
				const path = typeof r.metadata.path === 'string' ? r.metadata.path : undefined;
				const metadata = path ? vault.getMetadata(path) : null;
				const tags = collectTags(metadata);
				const backlinkCount = path ? vault.getBacklinks(path).size : 0;

				return {
					...r,
					// 关键路径:加 index 编号(从 1 开始),供 LLM 用 [1][2] 引用。
					// reranked 由 MultiQuerySearcher 填充,这里透传不覆盖。
					index: i + 1,
					metadata: {
						...r.metadata,
						tags,
						backlinkCount,
					},
				};
			});
		},
	};
}

/**
 * 汇集 Obsidian 元数据中的内联与 frontmatter 标签。
 *
 * @param metadata - 当前笔记的缓存元数据。
 * @returns 去重、移除 `#` 前缀后的标签列表。
 */
function collectTags(metadata: VaultMetadata | null): string[] {
	if (!metadata) return [];

	const frontmatter = metadata.frontmatter;
	const rawTags = [
		...(metadata.tags?.map(({ tag }) => tag) ?? []),
		...toStringTags(frontmatter?.tags),
		...toStringTags(frontmatter?.tag),
	];
	const unique = new Map<string, string>();
	for (const tag of rawTags) {
		const normalized = tag.replace(/^#/, '').toLocaleLowerCase();
		if (normalized && !unique.has(normalized)) unique.set(normalized, tag.replace(/^#/, ''));
	}
	return [...unique.values()];
}

/**
 * 将 frontmatter 标签字段规范为字符串数组。
 *
 * @param value - frontmatter 中的 `tag` 或 `tags` 字段。
 * @returns 仅包含字符串值的标签数组。
 */
function toStringTags(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string');
}
