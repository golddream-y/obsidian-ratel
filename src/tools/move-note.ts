/**
 * @file src/tools/move-note.ts
 * @description move_note 工具 — 移动或改名，不重写正文
 * @module tools/move-note
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { requireString } from './validate-args';
import { tNow } from '../i18n';
import { injectAgentsForPaths, type NoteAgentsToolDeps } from './note-agents';

/**
 * 创建 move_note 工具实例。
 *
 * 文件已在库里、只是换路径时使用。链接更新由 VaultPort.renameFile 交给 FileManager。
 */
export function createMoveNoteTool(
	vault: VaultPort,
	definition: ToolDefinition,
	getAgents?: () => NoteAgentsToolDeps | undefined,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args) {
			const from = requireString(args, 'from', 'from');
			const to = requireString(args, 'to', 'to');
			if (from === to) throw new Error(tNow('error.tool.samePath'));
			const agents = getAgents?.();
			await injectAgentsForPaths(agents, [from, to]);
			await vault.renameFile(from, to);
			return { from, to };
		},
	};
}
