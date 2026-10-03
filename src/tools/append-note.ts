/**
 * @file src/tools/append-note.ts
 * @description append_note 工具 — 追加内容到笔记末尾
 * @module tools/append-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { rejectOffloadMarker, requireString } from './validate-args';
import { tNow } from '../i18n';
import { injectAgentsForPaths, type NoteAgentsToolDeps } from './note-agents';
import { measureNoteText } from './note-text-stats';

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
export function createAppendNoteTool(
	vault: VaultPort,
	definition: ToolDefinition,
	getAgents?: () => NoteAgentsToolDeps | undefined,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			if (typeof args.content !== 'string') {
				throw new Error(tNow('error.tool.invalidContent'));
			}
			rejectOffloadMarker(args.content);
			const agents = getAgents?.();
			await injectAgentsForPaths(agents, [path]);
			await vault.appendFile(path, args.content);
			const text = measureNoteText(await vault.readFile(path));
			return { path, text };
		},
	};
}
