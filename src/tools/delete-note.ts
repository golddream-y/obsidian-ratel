/**
 * @file src/tools/delete-note.ts
 * @description delete_note 工具 — 将笔记移到回收站
 * @module tools/delete-note
 */

import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

export function createDeleteNoteTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'delete_note',
			description: '将笔记移到回收站(可恢复)。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '要删除的文件路径' },
				},
				required: ['path'],
			},
		},
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			await vault.trashFile(path);
			return { path, trashed: true };
		},
	};
}
