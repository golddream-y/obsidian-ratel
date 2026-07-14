/**
 * @file src/tools/get-note-outline.ts
 * @description get_note_outline 工具 — 用 metadataCache.headings 取大纲,禁止全文正则
 * @module tools/get-note-outline
 * @depends core/tool-registry, ports/vault
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';

/**
 * 构造 `get_note_outline` 工具。
 *
 * 关键路径:只读 `vault.getMetadata().headings`(Obsidian cache),
 * 不 `cachedRead` + 正则扫全文。
 *
 * @param vault - VaultPort
 * @param definition - LLM schema
 */
export function createGetNoteOutlineTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const path = requireString(args, 'path', 'path');
			const meta = vault.getMetadata(path);
			if (!meta) {
				return {
					path,
					headings: [],
					message: '元数据缓存不可用。可改用 read_note 读全文后自行提取标题。',
				};
			}

			const headings = (meta.headings ?? []).map((h) => ({
				level: h.level,
				text: h.heading,
				...(h.line !== undefined ? { line: h.line } : {}),
			}));

			return {
				path,
				headings,
				message:
					headings.length === 0
						? '未找到标题。若笔记确有 # 标题,可等 Obsidian 索引后重试,或用 read_note。'
						: undefined,
			};
		},
	};
}
