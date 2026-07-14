/**
 * @file src/adapters/obsidian-workspace.ts
 * @description Obsidian Workspace 薄包装 — 活动文件与编辑器选区
 * @module adapters/obsidian-workspace
 * @depends obsidian, ports/workspace
 */

import { App, MarkdownView, TFile } from 'obsidian';
import type { WorkspacePort } from '../ports/workspace';

/**
 * Obsidian `app.workspace` 适配器。
 *
 * 设计要点:
 * - 仅暴露 getActiveFile / selection,工具不直接 import obsidian。
 * - 非 Markdown 活动文件返回 null,避免 Agent 对 canvas/pdf 误读。
 */
export class ObsidianWorkspace implements WorkspacePort {
	constructor(private readonly app: App) {}

	/**
	 * @returns 活动 md 文件路径;否则 null
	 */
	getActiveFilePath(): string | null {
		const file = this.app.workspace.getActiveFile();
		if (!file || !(file instanceof TFile)) return null;
		if (file.extension !== 'md') return null;
		return file.path;
	}

	/**
	 * @returns 非空选区文本;否则 null
	 */
	getActiveSelection(): string | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return null;
		const sel = view.editor.getSelection();
		return sel.length > 0 ? sel : null;
	}
}
