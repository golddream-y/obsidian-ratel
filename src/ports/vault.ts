/**
 * @file src/ports/vault.ts
 * @description Vault 端口 — 把工具与 Obsidian API 解耦,让工具只依赖接口,便于测试时注入 mock。
 * @module ports/vault
 * @depends (无)
 */

/**
 * 笔记元数据(简版,只暴露工具层需要的字段)。
 * 与 Persistence.NoteMeta 不同:这里是"被解析过的语义化元数据",不是存储层抽象。
 */
export interface VaultMetadata {
	/** YAML frontmatter 键值对(原样保留)。 */
	frontmatter?: Record<string, unknown>;
	/** 解析出的内联 `#tag` 与 frontmatter 中的 tag。 */
	tags?: Array<{ tag: string }>;
	/** WikiLink `[[target]]` 列表。 */
	links?: Array<{ link: string }>;
}

/**
 * Vault 抽象接口。
 *
 * 实现位置:`src/adapters/obsidian-vault.ts`(薄包装 Obsidian `app.vault` API)。
 *
 * 设计要点:
 * - 把所有工具对 vault 的访问收敛到这里,工具(在 `src/tools/`)只 import 端口不 import Obsidian 适配器。
 * - 单元测试可以传入一个 mock 实现,无需起 Obsidian 环境。
 */
export interface VaultPort {
	/**
	 * 读取文件全文。
	 * @param path - vault 相对路径,如 `notes/daily/2026-06-14.md`。
	 */
	readFile(path: string): Promise<string>;

	/**
	 * 写入文件(已存在则覆盖,否则创建)。
	 * @param path - vault 相对路径。
	 * @param content - 完整文件内容。
	 */
	writeFile(path: string, content: string): Promise<void>;

	/**
	 * 取指向该文件的所有反向链接(键=源文件路径,值=链接出现次数)。
	 * 注意:同步返回,因为 Obsidian 的 metadataCache 是同步的。
	 */
	getBacklinks(path: string): Map<string, number>;

	/**
	 * 取文件元数据(frontmatter、tags、links)。
	 * @returns 文件不存在或尚未被 Obsidian 解析时返回 null。
	 */
	getMetadata(path: string): VaultMetadata | null;

	/**
	 * 列出 vault 内所有 Markdown 文件路径。
	 */
	listMarkdownFiles(): string[];
}
