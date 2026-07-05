/**
 * @file src/tools/list-files.ts
 * @description list_files 工具 — 列出目录内容
 * @module tools/list-files
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { optionalString } from './validate-args';
import { isExcludedVaultPath } from '../utils/path-safety';

/**
 * 创建 list_files 工具实例 — 列出 vault 内指定目录下的文件。
 *
 * @param vault - VaultPort 外观,提供文件系统访问
 * @param definition - 工具定义(name/description/parameters),由 composer 从 prompt section 组装
 * @returns ToolRegistry 注册项(definition + execute + readOnly)
 * @example
 *   const tool = createListFilesTool(vault, toolDef);
 *   tools.register(tool);
 */
export function createListFilesTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args) {
			const rawPath = optionalString(args, 'path') ?? '';
			const dir = rawPath === '' || rawPath === '.' ? '' : rawPath;
			const listing = await vault.listFiles(dir);
			return {
				path: dir || '.',
				files: listing.files.filter((f) => !isExcludedVaultPath(f)),
				folders: listing.folders.filter((f) => !isExcludedVaultPath(f)),
			};
		},
	};
}
