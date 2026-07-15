/**
 * @file src/tools/get-links.ts
 * @description get_links — 单篇出链/反链/未解析链接（知识缺口）
 * @module tools/get-links
 * @depends core/tool-registry, ports/vault
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

/**
 * 构造 `get_links` 工具。
 *
 * 关键路径:只读 `vault.getLinks(path)`(Obsidian resolvedLinks / backlinks / unresolved),
 * 不扫全文正则。
 *
 * @param vault - VaultPort
 * @param definition - LLM schema
 */
export function createGetLinksTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const path = requireString(args, 'path', 'path');
			const links = vault.getLinks(path);
			return { path, ...links };
		},
	};
}
