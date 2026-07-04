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
