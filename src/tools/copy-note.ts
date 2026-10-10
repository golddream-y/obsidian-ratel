/**
 * @file src/tools/copy-note.ts
 * @description copy_note 工具 — 按字节复制，原文件保留
 * @module tools/copy-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';
import { tNow } from '../i18n';
/**
 * 创建 copy_note 工具实例。
 *
 * 要留下原文件、另存一份时使用。不改其他笔记里的链接。
 */
export function createCopyNoteTool(
	vault: VaultPort,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args) {
			const from = requireString(args, 'from', 'from');
			const to = requireString(args, 'to', 'to');
			if (from === to) throw new Error(tNow('error.tool.samePath'));
			await vault.copyFile(from, to);
			return { from, to };
		},
	};
}
