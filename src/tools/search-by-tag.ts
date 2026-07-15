/**
 * @file src/tools/search-by-tag.ts
 * @description search_by_tag — 按标签前缀查询笔记（含嵌套 tag）
 * @module tools/search-by-tag
 * @depends core/tool-registry, ports/vault
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

/** 可选 limit：未传时交给端口默认（50）。 */
function optionalLimit(args: Record<string, unknown>): number | undefined {
	const v = args.limit;
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 构造 `search_by_tag` 工具。
 *
 * 关键路径:只读 `vault.findByTag`(metadataCache tags + frontmatter),
 * 不扫全文正则。
 *
 * @param vault - VaultPort
 * @param definition - LLM schema
 */
export function createSearchByTagTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const tag = requireString(args, 'tag', 'tag');
			const limit = optionalLimit(args);
			return vault.findByTag(tag, limit !== undefined ? { limit } : undefined);
		},
	};
}
