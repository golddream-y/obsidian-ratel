/**
 * @file src/tools/search-vault.ts
 * @description `search_vault` 工具 — 在知识库中做多查询混合搜索 + 统一可见性门 + RRF + 可选 Rerank,返回带 index + reranked 的结果
 * @module tools/search-vault
 * @depends core/tool-registry, core/multi-query-searcher, ports/llm
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { SearchResultWithFreshness, SearchVisibilityDiagnostics } from '../core/multi-query-searcher';
import type { VaultMetadata, VaultPort } from '../ports/vault';
import { tNow } from '../i18n';

// 默认返回结果数,与 JSON schema 中的 default 保持一致。
const DEFAULT_TOP_K = 5;

// 精确块定位字段 — 只有当前核实版本(新鲜度 verified)才允许承诺。
const PRECISE_LOCATION_KEYS = ['chunkIndex', 'startOffset'] as const;

/** 工具真正消费的搜索器切片 — 便于单测注入替身,且不复制可见性判定规则。 */
export interface SearchVaultSearcherPort {
	/** 多查询检索;内部已完成可见性过滤。 */
	search(query: string, topK: number): Promise<SearchResultWithFreshness[]>;
	/** 最近一次检索的可见性诊断;未装配门时可省略。 */
	visibilityDiagnostics?(): SearchVisibilityDiagnostics | undefined;
}

/**
 * 构造 `search_vault` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 内部调用 MultiQuerySearcher.search,对 LLM 透明(改写 + 多查询 + 可见性门 + RRF + Rerank 均在内部)。
 * - 只返回 docId + score + metadata + index + reranked,不返回 chunk 原文,让模型自主用 read_note 读取。
 * - **引用定位精度**:只有新鲜度为 `verified` 的结果才携带块偏移(`chunkIndex` / `startOffset`);
 *   未核实(关闭自动索引、尚未核对)的结果保留 path 与引用编号,但不承诺精确块定位。
 * - `definition` 由调用方通过 Composer 生成后注入。
 *
 * @param searcher - MultiQuerySearcher 实例,编排多查询 + 可见性门 + RRF + Rerank。
 * @param getSearchReady - 检索就绪检查;未就绪时抛 INDEX_NOT_READY。
 * @param definition - LLM 侧 schema,由 `composeToolDefinitions` 生成。
 * @param vault - Vault 端口,用于补充实时标签与反向链接数量。
 * @returns 符合 `Tool` 接口的工具定义。
 */
export function createSearchVaultTool(
	searcher: SearchVaultSearcherPort,
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

			// 关键路径:MultiQuerySearcher 内部编排改写 + 多查询 + 可见性门 + RRF + 可选 Rerank。
			// 对 LLM 透明:LLM 仍用 search_vault({query, topK}) 调用。
			const results = await searcher.search(query, topK);

			if (results.length === 0) {
				const diagnostics = searcher.visibilityDiagnostics?.();
				if (diagnostics?.recordsKind === 'unjudgeable') {
					// 关键路径:没有可信记录 ≠ 空索引。静默返回空集会把「状态未知」伪装成
					// 「0 篇可检索」,这里按失败关闭并给出稳定错误码,由调用方与用户界面如实呈现。
					const err = new Error(tNow('error.search.indexUnknown'));
					(err as Error & { code?: string }).code = 'INDEX_UNVERIFIED';
					throw err;
				}
			}

			// 关键路径:索引结果可能滞后于当前笔记元数据，返回时从 metadataCache 补充实时结构信号。
			return results.map((r, i) => {
				const path = typeof r.metadata.path === 'string' ? r.metadata.path : undefined;
				const metadata = path ? vault.getMetadata(path) : null;
				const tags = collectTags(metadata);
				const backlinkCount = path ? vault.getBacklinks(path).size : 0;
				// 关键路径:只有当前核实版本(verified)才承诺精确块定位;未核实结果保留 path 与
				// 引用编号,但剥离块偏移 —— 引用打开当前笔记不代表旧块偏移仍准确。
				// 未装配可见性门时结果不带 freshness,保持既有「精确定位」行为(向后兼容)。
				const preciseLocation = r.freshness === undefined || r.freshness === 'verified';

				return {
					...r,
					// 关键路径:加 index 编号(从 1 开始),供 LLM 用 [1][2] 引用。
					// reranked 由 MultiQuerySearcher 填充,这里透传不覆盖。
					index: i + 1,
					metadata: {
						...(preciseLocation ? r.metadata : withoutPreciseLocation(r.metadata)),
						tags,
						backlinkCount,
					},
				};
			});
		},
	};
}

/**
 * 移除精确块定位字段(块序号与起始偏移)。
 *
 * 关键路径:未核实结果不得承诺「旧块偏移仍准确」,但路径、标题路径与引用编号保留。
 *
 * @param metadata - 原始块元数据。
 * @returns 浅拷贝后的元数据(不含 `chunkIndex` / `startOffset`)。
 */
function withoutPreciseLocation(metadata: Record<string, unknown>): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...metadata };
	for (const key of PRECISE_LOCATION_KEYS) delete copy[key];
	return copy;
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
