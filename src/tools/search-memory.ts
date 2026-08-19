/**
 * @file src/tools/search-memory.ts
 * @description `search_memory` 工具 — 在用户已建立的主题记忆上做向量 + BM25 混合搜索
 * @module tools/search-memory
 * @depends core/tool-registry, core/memory-store, ports/embedding, ports/llm, i18n
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { MemoryStore, MemorySearchResult } from '../core/memory-store';
import type { EmbeddingPort } from '../ports/embedding';
import { tNow } from '../i18n';

// 默认返回结果数,与 JSON schema 中的 default 保持一致。
const DEFAULT_TOP_K = 5;

/**
 * 构造 `search_memory` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 内部流程:embeddingPort.embed([query])[0] → memoryStore.searchIndex → 截断到 maxReturnBytes。
 * - EmbeddingPort.embed 接收批量数组,这里只编一条查询,取 [0] 出来。
 * - 返回字节上限按 UTF-8 字节估算,超出则按结果顺序截断(保留 index 编号连续)。
 * - `definition` 由调用方通过 Composer 生成后注入。
 *
 * @param memoryStore - MemoryStore 实例,提供记忆索引搜索能力。
 * @param embeddingPort - EmbeddingPort 实例,把查询文本编码为向量。
 * @param definition - LLM 侧 schema,由 `composeToolDefinitions` 生成。
 * @param maxReturnBytes - 单次返回字节上限的 getter — 每次执行现读 settings.memoryDynamicLimitKB * 1024,设置热更新立即生效。
 * @returns 符合 `Tool` 接口的工具定义。
 *
 * @example
 *   const tool = createSearchMemoryTool(memoryStore, embeddingPort, def, () => 30 * 1024);
 *   registry.register(tool);
 */
export function createSearchMemoryTool(
	memoryStore: MemoryStore,
	embeddingPort: EmbeddingPort,
	definition: ToolDefinition,
	/** 单次返回字节上限 getter — settings.memoryDynamicLimitKB * 1024(S-SR-LAYERING 接线);传 getter 而非数值,设置热更新不用重建工具 */
	maxReturnBytes: () => number,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			// 关键路径:参数校验 — query 必须是非空字符串。
			if (typeof args.query !== 'string' || args.query.length === 0) {
				throw new Error(tNow('error.tool.invalidQuery', { label: 'query' }));
			}
			const query = args.query;
			const topK = typeof args.topK === 'number' ? args.topK : DEFAULT_TOP_K;

			// 关键路径:EmbeddingPort.embed 接收 string[],这里只编一条查询,取结果数组第 0 项。
			const vectors = await embeddingPort.embed([query]);
			const queryVector = vectors[0];
			if (!queryVector) {
				// 修复:embedding 返回空数组时抛错,避免下游 searchIndex 收到 undefined。
				throw new Error(tNow('error.embedding.emptyVector'));
			}

			const results = await memoryStore.searchIndex(query, queryVector, topK);

			// 关键路径:maxReturnBytes 预算 — 按顺序累加,超出阈值则停止,保留 index 编号连续。
			return truncateResults(results, maxReturnBytes());
		},
	};
}

/**
 * 按顺序截断结果数组,使总字节不超过 maxBytes。
 *
 * 关键路径:
 * - 用 Buffer.byteLength 估算 UTF-8 字节(中文每字 3 字节)。
 * - 超出阈值时停止追加后续结果,已加入的结果保留(不回退)。
 * - 若单条结果就超阈值(罕见),仍返回该条(截断为空也比空数组有用)。
 *
 * @param results - 原始结果数组。
 * @param maxBytes - 单次返回字节上限(settings.memoryDynamicLimitKB * 1024)。
 * @returns 截断后的结果数组(可能少于原长度)。
 */
function truncateResults(results: MemorySearchResult[], maxBytes: number): MemorySearchResult[] {
	let totalBytes = 0;
	const truncated: MemorySearchResult[] = [];
	for (const r of results) {
		const entryBytes = Buffer.byteLength(r.text, 'utf-8') + Buffer.byteLength(r.docId, 'utf-8');
		// 关键路径:首条结果无论如何都加入,避免极端情况下返回空数组。
		if (truncated.length > 0 && totalBytes + entryBytes > maxBytes) {
			break;
		}
		truncated.push(r);
		totalBytes += entryBytes;
	}
	return truncated;
}
