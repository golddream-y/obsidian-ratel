/**
 * @file src/tools/delete-note.ts
 * @description delete_note 工具 — 将笔记移到回收站
 * @module tools/delete-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';
import { applyNoteAgentsGate, type NoteAgentsToolDeps } from './note-agents';

/**
 * 创建 delete_note 工具实例 — 删除指定笔记。
 *
 * @param vault - VaultPort 外观,提供文件系统访问
 * @param definition - 工具定义(name/description/parameters),由 composer 从 prompt section 组装
 * @returns ToolRegistry 注册项(definition + execute + readOnly)
 * @example
 *   const tool = createDeleteNoteTool(vault, toolDef);
 *   tools.register(tool);
 */
export function createDeleteNoteTool(
	vault: VaultPort,
	definition: ToolDefinition,
	getAgents?: () => NoteAgentsToolDeps | undefined,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args) {
			const path = requireString(args, 'path', 'path');
			const agents = getAgents?.();
			if (agents) {
				const gate = await applyNoteAgentsGate({
					op: 'write',
					notePath: path,
					seen: agents.seen,
					readAgentsFile: agents.readAgentsFile,
				});
				if (!gate.proceed) {
					return gate.attachment;
				}
			}
			await vault.trashFile(path);
			return { path, trashed: true };
		},
	};
}
