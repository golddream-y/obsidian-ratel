/**
 * @file src/tools/append-note.ts
 * @description append_note 工具 — 追加内容到笔记末尾
 * @module tools/append-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

/**
 * 创建 append_note 工具实例 — 追加内容到已有笔记末尾。
 *
 * @param vault - VaultPort 外观,提供文件系统访问
 * @param definition - 工具定义(name/description/parameters),由 composer 从 prompt section 组装
 * @returns ToolRegistry 注册项(definition + execute + readOnly)
 * @example
 *   const tool = createAppendNoteTool(vault, toolDef);
 *   tools.register(tool);
 */
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
