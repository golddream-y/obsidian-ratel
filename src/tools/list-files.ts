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
