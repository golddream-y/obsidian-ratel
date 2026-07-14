/**
 * @file src/tools/get-active-note.ts
 * @description get_active_note 工具 — 当前活动笔记路径 / 选区 / frontmatter
 * @module tools/get-active-note
 * @depends core/tool-registry, ports/workspace, ports/vault
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import type { WorkspacePort } from '../ports/workspace';
import { optionalBoolean } from './validate-args';

/**
 * 构造 `get_active_note` 工具。
 *
 * 设计要点:
 * - 无活动文件时返回 `{ path: null, message }`,不抛错,便于 Agent 降级。
 * - frontmatter 走 `vault.getMetadata`,不读全文。
 *
 * @param workspace - 活动文件 / 选区
 * @param vault - 元数据查询
 * @param definition - LLM schema
 */
export function createGetActiveNoteTool(
	workspace: WorkspacePort,
	vault: VaultPort,
	definition: ToolDefinition,
): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const includeSelection = optionalBoolean(args, 'includeSelection', true);
			const includeFrontmatter = optionalBoolean(args, 'includeFrontmatter', true);

			const path = workspace.getActiveFilePath();
			if (!path) {
				return {
					path: null,
					message: '当前没有打开的 Markdown 笔记。请让用户打开目标笔记,或改用 glob / search_vault 定位路径。',
				};
			}

			const slash = path.lastIndexOf('/');
			const basename = slash >= 0 ? path.slice(slash + 1) : path;
			const result: Record<string, unknown> = { path, basename };

			if (includeSelection) {
				result.selection = workspace.getActiveSelection();
			}

			if (includeFrontmatter) {
				const meta = vault.getMetadata(path);
				result.frontmatter = meta?.frontmatter ?? null;
			}

			return result;
		},
	};
}
