/**
 * @file src/tools/get-vault-structure.ts
 * @description get_vault_structure — 库目录、标签统计与孤儿笔记概览
 * @module tools/get-vault-structure
 * @depends core/tool-registry, ports/vault
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';

/**
 * 构造 `get_vault_structure` 工具。
 *
 * 关键路径:只读 `vault.getVaultStructure`(metadataCache 目录/tag/orphan),
 * 不写索引、不扫全文。
 *
 * @param vault - VaultPort
 * @param definition - LLM schema
 */
export function createGetVaultStructureTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const include = Array.isArray(args.include)
				? (args.include as Array<'folders' | 'tags' | 'orphans'>)
				: undefined;
			return vault.getVaultStructure(include);
		},
	};
}
