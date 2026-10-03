/**
 * @file src/tools/apply-patch.ts
 * @description apply_patch 工具 — 用 Codex Update File 补丁局部修改已有笔记
 * @module tools/apply-patch
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { tNow } from '../i18n';
import type { StringKey } from '../i18n/types';
import { validateVaultPath } from '../utils/path-safety';
import { injectAgentsForPaths, type NoteAgentsToolDeps } from './note-agents';
import { measureNoteText, type NoteTextStats } from './note-text-stats';
import {
	applyUpdateHunks,
	parseUpdatePatch,
	type PatchReason,
} from './apply-patch-text';

const PATCH_REASON_I18N: Record<PatchReason, StringKey> = {
	parse: 'error.tool.patchParse',
	multi: 'error.tool.patchMulti',
	add: 'error.tool.patchAdd',
	delete: 'error.tool.patchDelete',
	move: 'error.tool.patchMove',
	empty: 'error.tool.patchEmpty',
	mismatch: 'error.tool.patchMismatch',
	ambiguous: 'error.tool.patchAmbiguous',
	eof: 'error.tool.patchEof',
};

/**
 * 创建 apply_patch 工具实例 — 解析补丁、注入目录约束、原子落盘。
 *
 * @param vault - VaultPort 外观
 * @param definition - 工具定义
 * @param getAgents - 可选的 AGENTS.md 注入依赖
 * @returns ToolRegistry 注册项
 */
export function createApplyPatchTool(
	vault: VaultPort,
	definition: ToolDefinition,
	getAgents?: () => NoteAgentsToolDeps | undefined,
): Tool {
	return {
		definition,
		readOnly: false,
		async execute(args): Promise<{ path: string; text: NoteTextStats }> {
			if (typeof args.patch !== 'string') {
				throw new Error(tNow('error.tool.invalidArg', { label: 'patch', type: typeof args.patch }));
			}
			const parsed = parseUpdatePatch(args.patch);
			if (!parsed.ok) {
				throw new Error(tNow(PATCH_REASON_I18N[parsed.reason]));
			}
			const path = validateVaultPath(parsed.path);
			const agents = getAgents?.();
			await injectAgentsForPaths(agents, [path]);

			if (!(await vault.fileExists(path))) {
				throw new Error(tNow('error.tool.fileNotFound', { path }));
			}

			await vault.processFile(path, (content) => {
				const applied = applyUpdateHunks(content, parsed.hunks);
				if (!applied.ok) {
					throw new Error(tNow(PATCH_REASON_I18N[applied.reason]));
				}
				return applied.content;
			});

			const text = measureNoteText(await vault.readFile(path));
			return { path, text };
		},
	};
}
