/**
 * @file src/ports/workspace.ts
 * @description Workspace 端口 — 活动文件 / 选区,与 VaultPort 文件 IO 解耦
 * @module ports/workspace
 */

/**
 * 工作区抽象 — 只暴露 Agent 环境感知需要的活动上下文。
 *
 * 实现位置:`src/adapters/obsidian-workspace.ts`(薄包装 `app.workspace`)。
 *
 * 设计要点:
 * - 不塞进 VaultPort:活动文件属于 UI 工作区状态,不是 vault 磁盘契约。
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
}
