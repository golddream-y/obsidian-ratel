/**
 * @file src/ports/workspace.ts
 * @description Workspace 端口 — 活动文件 / 选区感知与 UI 操作入口(openNote / openPluginSettings),与 VaultPort 文件 IO 解耦
 * @module ports/workspace
 */

/**
 * 工作区抽象 — 除 Agent 环境感知需要的活动上下文外,还提供 UI 操作入口:
 * openNote / openPluginSettings(供 open_note / open_settings 工具消费)。
 *
 * 实现位置:`src/adapters/obsidian-workspace.ts`(薄包装 `app.workspace`)。
 *
 * 设计要点:
 * - 不塞进 VaultPort:活动文件与打开笔记/设置均属于 UI 工作区行为,不是 vault 磁盘契约。
 * - 工具层只依赖本端口,便于单测 mock。
 */
export interface WorkspacePort {
	/**
	 * 当前活动 Markdown 文件的 vault 相对路径。
	 * @returns 无活动文件或非 md 时返回 null
	 */
	getActiveFilePath(): string | null;

	/**
	 * 活动 Markdown 编辑器的选中文本。
	 * @returns 无选区或非 MarkdownView 时返回 null
	 */
	getActiveSelection(): string | null;

	/** 在 Obsidian 中打开笔记并滚动定位到锚点;linktext 语法同 wikilink(path / path#标题 / path#^blockId) */
	openNote(linktext: string): Promise<boolean>;

	/** 打开 Ratel 设置面板并定位到指定 tab;省略 tab 打开默认 tab。宿主未创建 SettingTab 时返回 false */
	openPluginSettings(tab?: string): Promise<boolean>;
}
