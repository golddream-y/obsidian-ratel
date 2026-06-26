/**
 * @file src/tools/write-note.ts
 * @description write_note 工具 — 创建或覆盖笔记
 * @module tools/write-note
 */

import type { Tool } from '../core/tool-registry';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

export function createWriteNoteTool(vault: VaultPort): Tool {
	return {
		definition: {
			name: 'write_note',
			description: '创建新笔记或覆盖已有笔记全文。',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: '目标笔记路径' },
					content: { type: 'string', description: '完整文件内容' },
				},
				required: ['path', 'content'],
			},
		},
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
