/**
 * @file src/tools/append-note.ts
 * @description append_note 工具 — 追加内容到笔记末尾
 * @module tools/append-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

export function createAppendNoteTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			if (typeof args.content !== 'string') {
				throw new Error('content 必须是字符串');
			}
			const existed = await vault.fileExists(path);
			await vault.appendFile(path, args.content);
			return { path, created: !existed };
		},
	};
}
