/**
 * @file src/tools/search-by-property.ts
 * @description search_by_property — 按 frontmatter 属性过滤笔记
 * @module tools/search-by-property
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
 * 构造 `search_by_property` 工具。
 *
 * 关键路径:只读 `vault.findByProperty`(metadataCache frontmatter),
 * 省略 value 时仅判断键存在。
 *
 * @param vault - VaultPort
 * @param definition - LLM schema
 */
export function createSearchByPropertyTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const key = requireString(args, 'key', 'key');
			const value = args.value;
			const limit = optionalLimit(args);
			return vault.findByProperty(
				key,
				value,
				limit !== undefined ? { limit } : undefined,
			);
		},
	};
}
