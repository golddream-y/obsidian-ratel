/**
 * @file src/tools/edit-note.ts
 * @description edit_note 工具 — 精确替换笔记中的文本
 * @module tools/edit-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';
import { tNow } from '../i18n';

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let pos = 0;
	while (true) {
		const idx = haystack.indexOf(needle, pos);
		if (idx === -1) break;
		count++;
		pos = idx + needle.length;
	}
	return count;
}

/**
 * 创建 edit_note 工具实例 — 编辑笔记指定行(唯一匹配替换)。
 *
 * @param vault - VaultPort 外观,提供文件系统访问
 * @param definition - 工具定义(name/description/parameters),由 composer 从 prompt section 组装
 * @returns ToolRegistry 注册项(definition + execute + readOnly)
 * @example
 *   const tool = createEditNoteTool(vault, toolDef);
 *   tools.register(tool);
 */
export function createEditNoteTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			if (typeof args.old_string !== 'string') {
				throw new Error(tNow('error.tool.invalidArg', { label: 'old_string', type: typeof args.old_string }));
			}
			if (typeof args.new_string !== 'string') {
				throw new Error(tNow('error.tool.invalidArg', { label: 'new_string', type: typeof args.new_string }));
			}
			const oldString = args.old_string;
			const newString = args.new_string;

			if (!(await vault.fileExists(path))) {
				throw new Error(tNow('error.tool.fileNotFound', { path }));
			}

			const content = await vault.readFile(path);
			const n = countOccurrences(content, oldString);
			if (n === 0) {
				throw new Error(tNow('error.tool.oldStringNotFound'));
			}
			if (n > 1) {
				throw new Error(tNow('error.tool.oldStringMultipleMatches', { count: n }));
			}

			await vault.processFile(path, (c) => c.replace(oldString, newString));
			return { path, replaced: true };
		},
	};
}
