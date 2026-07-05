/**
 * @file src/tools/write-note.ts
 * @description write_note 工具 — 创建或覆盖笔记
 * @module tools/write-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

/**
 * 创建 write_note 工具实例 — 创建或覆盖笔记(带 frontmatter 模板)。
 *
 * @param vault - VaultPort 外观,提供文件系统访问
 * @param definition - 工具定义(name/description/parameters),由 composer 从 prompt section 组装
 * @returns ToolRegistry 注册项(definition + execute + readOnly)
 * @example
 *   const tool = createWriteNoteTool(vault, toolDef);
 *   tools.register(tool);
 */
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
