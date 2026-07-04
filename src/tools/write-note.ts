/**
 * @file src/tools/write-note.ts
 * @description write_note 工具 — 创建或覆盖笔记
 * @module tools/write-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

export function createWriteNoteTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			if (typeof args.content !== 'string') {
				throw new Error('content 必须是字符串');
			}
			const content = args.content;
			const existed = await vault.fileExists(path);
			await vault.writeFile(path, content);
			return { path, created: !existed };
		},
	};
}
