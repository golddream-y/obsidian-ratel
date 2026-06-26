/**
 * @file src/tools/glob.ts
 * @description glob 工具 — 按文件名模式匹配笔记
 * @module tools/glob
 */

import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { globToRegex } from '../utils/glob-to-regex';
import { isExcludedVaultPath, isUnderDirectory } from '../utils/path-safety';
import { optionalString, requireString } from './validate-args';

export function createGlobTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'glob',
			description: '按文件名 glob 模式查找 Markdown 笔记,如 "daily/*.md" 或 "**/*.project.md"。',
			parameters: {
				type: 'object',
				properties: {
					pattern: { type: 'string', description: 'glob 模式' },
					path: { type: 'string', description: '限定搜索目录' },
				},
				required: ['pattern'],
			},
		},
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
