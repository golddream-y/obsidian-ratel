/**
 * @file src/tools/glob.ts
 * @description glob 工具 — 按文件名模式匹配笔记
 * @module tools/glob
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { globToRegex } from '../utils/glob-to-regex';
import { isExcludedVaultPath, isUnderDirectory } from '../utils/path-safety';
import { optionalString, requireString } from './validate-args';

/**
 * 创建 glob 工具实例 — 文件名匹配(glob 模式),返回匹配的文件路径列表。
 *
 * @param vault - VaultPort 外观,提供文件系统访问
 * @param definition - 工具定义(name/description/parameters),由 composer 从 prompt section 组装
 * @returns ToolRegistry 注册项(definition + execute + readOnly)
 * @example
 *   const tool = createGlobTool(vault, toolDef);
 *   tools.register(tool);
 */
export function createGlobTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args) {
			const pattern = requireString(args, 'pattern', 'pattern');
			const basePath = optionalString(args, 'path') ?? '';
			const re = globToRegex(pattern);
			return vault
				.listMarkdownFiles()
				.filter((f) => !isExcludedVaultPath(f))
				.filter((f) => isUnderDirectory(f, basePath))
				.filter((f) => re.test(f));
		},
	};
}
