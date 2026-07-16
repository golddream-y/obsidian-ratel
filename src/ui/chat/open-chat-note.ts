/**
 * @file src/ui/chat/open-chat-note.ts
 * @description Chat 侧打开 vault 笔记的薄封装 — 供 cite chip / 正文 `[n]` 共用
 * @module ui/chat/open-chat-note
 * @depends obsidian Notice + App.workspace
 */

import { Notice, type App } from 'obsidian';
import { tNow } from '../../i18n';
import { validateVaultPath } from '../../utils/path-safety';

/**
 * 在 Obsidian 工作区打开 vault 相对路径笔记。
 *
 * 设计要点:
 * - SearchResults / TextSegment **禁止**直接 `import 'obsidian'`,由 ChatView 注入本函数
 * - 非法路径 / 打开失败 → Notice,不向上抛未捕获异常
 *
 * @param app - Obsidian App
 * @param path - vault 相对路径
 */
export async function openChatNote(app: App, path: string): Promise<void> {
	let normalized: string;
	try {
		normalized = validateVaultPath(path);
	} catch {
		new Notice(tNow('chat.cite.openFailed', { path }));
		return;
	}
	if (!normalized) {
		new Notice(tNow('chat.cite.openFailed', { path }));
		return;
	}
	try {
		// 关键路径:openLinkText 接受 vault 相对路径;第三参 false = 不新建 leaf 强制
		await app.workspace.openLinkText(normalized, '', false);
	} catch {
		new Notice(tNow('chat.cite.openFailed', { path: normalized }));
	}
}

/**
 * 按引用编号在 searchResults 中查找路径。
 *
 * @param results - Message.searchResults
 * @param index - 从 1 起的引用序号
 * @returns 匹配路径;无匹配返回 null
 */
export function pathForCiteIndex(
	results: Array<{ index: number; path: string }> | undefined,
	index: number,
): string | null {
	if (!results?.length) return null;
	const hit = results.find((r) => r.index === index);
	return hit?.path ?? null;
}
