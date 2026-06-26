/**
 * @file src/tools/list-files.ts
 * @description list_files 工具 — 列出目录内容
 * @module tools/list-files
 */

import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { optionalString } from './validate-args';

export function createListFilesTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'list_files',
			description: '列出 vault 某目录下的文件与子文件夹(非递归)。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '目录路径,默认根目录' },
				},
			},
		},
		readOnly: true,
		async execute(args) {
			const path = optionalString(args, 'path') ?? '';
			const listing = await vault.listFiles(path);
			return { path, files: listing.files, folders: listing.folders };
		},
	};
}
