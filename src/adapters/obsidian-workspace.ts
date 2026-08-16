/**
 * @file src/adapters/obsidian-workspace.ts
 * @description Obsidian Workspace 薄包装 — 活动文件、编辑器选区、打开笔记与设置页定位
 * @module adapters/obsidian-workspace
 * @depends obsidian, ports/workspace, ./settings(仅类型)
 */

import { App, MarkdownView, TFile } from 'obsidian';
import type { RatelVaultSettingTab } from '../settings';
import type { WorkspacePort } from '../ports/workspace';
import { devLogger } from '../logging/dev-logger';

/**
 * Obsidian `app.workspace` 适配器。
 *
 * 设计要点:
 * - 仅暴露 getActiveFile / selection / openNote / openPluginSettings,工具不直接 import obsidian。
 * - 非 Markdown 活动文件返回 null,避免 Agent 对 canvas/pdf 误读。
 * - 设置 tab 定位依赖 SettingTab 实例;main.ts 在 addSettingTab 后才持有实例,
 *   因此用 getter 注入而非直接存引用,保证每次读到最新值。
 */
export class ObsidianWorkspace implements WorkspacePort {
	constructor(
		private readonly app: App,
		// 关键路径:设置 tab 定位需要 SettingTab 实例;main.ts 在 addSettingTab 后注入 getter
		private readonly getSettingTab: () => RatelVaultSettingTab | null = () => null,
	) {}

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

	/**
	 * 复用当前 tab 打开笔记(与点击双链行为一致),锚点由 Obsidian 原生解析并滚动。
	 *
	 * 关键路径:openLinkText 类型签名是 Promise<void>,返回值无法区分成败;
	 * 调用方(open_note 工具)已在调用前用 vault.fileExists 验证文件存在,
	 * 因此以「不抛错即成功」为语义,失败(API 异常)时 catch 返回 false。
	 *
	 * @param linktext - wikilink 语法(path / path#标题 / path#^blockId)
	 * @returns 打开请求成功发出返回 true;API 抛错返回 false
	 */
	async openNote(linktext: string): Promise<boolean> {
		try {
			await this.app.workspace.openLinkText(linktext, '', false);
			return true;
		} catch (err) {
			// 修复: 空 catch 吞错难排查 — debug 级留痕(默认静默),便于定位 API 异常
			devLogger.debug('main', 'openLinkText 打开失败', err);
			return false;
		}
	}

	/**
	 * 打开 Obsidian 设置 → Ratel 插件页,并让 SettingTab 切到目标 tab。
	 *
	 * @param tab - SettingsUiTab 之一(chat/index/agent/appearance/advanced);非法值由 focusTab 拒绝
	 * @returns 定位成功返回 true;SettingTab 尚未创建返回 false
	 */
	async openPluginSettings(tab?: string): Promise<boolean> {
		// 关键路径:App.setting 未收录进官方 obsidian.d.ts(运行时存在),unknown 中转访问;
		// 先 open() 再 openTabById('ratel-vault'),与 model-info-modal 打开设置同路径
		const setting = (
			this.app as unknown as {
				setting?: { open(): void; openTabById(id: string): void };
			}
		).setting;
		// 修复: setting 为运行时属性,极端时序(宿主未就绪)下可能缺失 — 防护后再调用
		if (!setting) return false;
		setting.open();
		setting.openTabById('ratel-vault');
		const settingTab = this.getSettingTab();
		if (!settingTab) return false;
		return settingTab.focusTab(tab);
	}
}
