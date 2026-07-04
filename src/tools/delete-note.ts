/**
 * @file src/tools/delete-note.ts
 * @description delete_note 工具 — 将笔记移到回收站
 * @module tools/delete-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

export function createDeleteNoteTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			await vault.trashFile(path);
			return { path, trashed: true };
		},
	};
}
