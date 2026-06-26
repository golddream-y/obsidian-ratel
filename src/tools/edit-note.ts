/**
 * @file src/tools/edit-note.ts
 * @description edit_note 工具 — 精确替换笔记中的文本
 * @module tools/edit-note
 */

import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

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

export function createEditNoteTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'edit_note',
			description:
				'在笔记中精确替换一段文本。old_string 必须与文件内容完全一致(含缩进),且在文件中唯一;否则返回错误。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '目标笔记路径' },
					old_string: { type: 'string', description: '要被替换的原文(唯一匹配)' },
					new_string: { type: 'string', description: '替换后的文本' },
				},
				required: ['path', 'old_string', 'new_string'],
			},
		},
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			if (typeof args.old_string !== 'string') {
				throw new Error('old_string 必须是字符串');
			}
			if (typeof args.new_string !== 'string') {
				throw new Error('new_string 必须是字符串');
			}
			const oldString = args.old_string;
			const newString = args.new_string;

			if (!(await vault.fileExists(path))) {
				throw new Error(`文件不存在: ${path}`);
			}

			const content = await vault.readFile(path);
			const n = countOccurrences(content, oldString);
			if (n === 0) {
				throw new Error('未找到要替换的文本,请确认 old_string 精确匹配(含空白缩进)');
			}
			if (n > 1) {
				throw new Error(
					`old_string 在文件中出现多次(共 ${n} 次),请提供更多上下文(前后各 3-5 行)以唯一确定`,
				);
			}

			await vault.processFile(path, (c) => c.replace(oldString, newString));
			return { path, replaced: true };
		},
	};
}
