/**
 * @file src/tools/list-recent-notes.ts
 * @description list_recent_notes 工具 — 按 mtime 列出最近修改的 Markdown 笔记
 * @module tools/list-recent-notes
 * @depends core/tool-registry, ports/vault, utils/path-safety, utils/local-datetime
 */

import type { Tool } from '../core/tool-registry';
import type { ToolDefinition } from '../ports/llm';
import type { VaultPort } from '../ports/vault';
import { optionalNumber } from './validate-args';
import { isExcludedVaultPath } from '../utils/path-safety';
import { formatLocalDateTime } from '../utils/local-datetime';

const HARD_CAP = 50;
const DEFAULT_LIMIT = 10;

/** 排除插件配置、回收站与 .ratel/ 内部目录 */
function shouldSkip(path: string): boolean {
	return (
		isExcludedVaultPath(path) ||
		path === '.ratel' ||
		path.startsWith('.ratel/')
	);
}

/**
 * 构造 `list_recent_notes` 工具。
 *
 * @param vault - 需实现 listMarkdownFiles + stat
 * @param definition - LLM schema
 */
export function createListRecentNotesTool(vault: VaultPort, definition: ToolDefinition): Tool {
	return {
		definition,
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			const rawLimit = optionalNumber(args, 'limit', DEFAULT_LIMIT);
			const limit = Math.min(HARD_CAP, Math.max(1, Math.floor(rawLimit)));

			const files = vault.listMarkdownFiles().filter((p) => !shouldSkip(p));
			const scored: Array<{ path: string; mtime: number }> = [];
			for (const path of files) {
				const st = vault.stat(path);
				if (!st) continue;
				scored.push({ path, mtime: st.mtime });
			}
			scored.sort((a, b) => b.mtime - a.mtime);

			const notes = scored.slice(0, limit).map((item) => ({
				path: item.path,
				mtime: item.mtime,
				mtimeLocal: formatLocalDateTime(new Date(item.mtime)).local,
			}));

			return { notes, count: notes.length };
		},
	};
}
