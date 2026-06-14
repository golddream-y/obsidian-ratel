/**
 * @file src/adapters/obsidian-vault.ts
 * @description Obsidian API 薄包装 — `VaultPort` 在宿主环境的实现
 * @module adapters/obsidian-vault
 * @depends obsidian, ports/vault
 */

import { type App, TFile } from 'obsidian';
import type { VaultPort, VaultMetadata } from '../ports/vault';

/**
 * Obsidian Vault 外观。
 *
 * 设计要点:
 * - 把 `app.vault` / `app.metadataCache` 这类 Obsidian 全局 API 收敛到一个类,方便单测替换(mock)。
 * - 所有对宿主 API 的访问只允许经过此处,主线程其他模块禁止直接 `import 'obsidian'` 之外的裸调用。
 * - 事件订阅返回反注册函数,调用方负责在合适的时机(插件卸载)释放。
 */
export class ObsidianVault implements VaultPort {
	constructor(private app: App) {}

	/**
	 * 读取文件全文。
	 *
	 * @param path - 相对于 vault 根的路径,例如 `notes/foo.md`。
	 * @returns UTF-8 解码后的全文。
	 * @throws 当文件不存在或不是普通文件(`TFile`)时抛出。
	 */
	async readFile(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file || !(file instanceof TFile)) throw new Error(`File not found: ${path}`);
		return this.app.vault.read(file);
	}

	/**
	 * 写入文件 — 文件存在则覆盖,不存在则创建。
	 *
	 * 行为细节:若父目录尚不存在,会自动 `createFolder`。
	 *
	 * @param path - 目标路径。
	 * @param content - 文件内容。
	 * @throws 当 Obsidian 自身写盘失败时抛出。
	 */
	async writeFile(path: string, content: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			// 提取父目录;若不存在则先建好,避免 create 报错。
			const dir = path.substring(0, path.lastIndexOf('/'));
			if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
				await this.app.vault.createFolder(dir);
			}
			await this.app.vault.create(path, content);
		}
	}

	/**
	 * 取出指向 `path` 的反向链接。
	 *
	 * 关键路径:从 `metadataCache.resolvedLinks` 反向索引;O(N) 遍历,
	 * 适合千级文件量级。更大规模可考虑建反向索引(参见 Indexer subagent)。
	 *
	 * @param path - 目标文件路径。
	 * @returns `Map<源文件路径, 链接次数>`,无反向链接时为空 map。
	 */
	getBacklinks(path: string): Map<string, number> {
		const result = new Map<string, number>();
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const [sourcePath, targets] of Object.entries(resolved)) {
			if (path in targets) {
				result.set(sourcePath, targets[path]!);
			}
		}
		return result;
	}

	/**
	 * 获取文件的元数据缓存(frontmatter / tags / links)。
	 *
	 * @param path - 文件路径。
	 * @returns 命中时返回结构化元数据;文件不存在或元数据未就绪时返回 `null`。
	 */
	getMetadata(path: string): VaultMetadata | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return null;
		const cache = this.app.metadataCache.getFileCache(file as TFile);
		if (!cache) return null;
		return {
			frontmatter: cache.frontmatter as Record<string, unknown> | undefined,
			tags: cache.tags?.map((t) => ({ tag: t.tag })),
			links: cache.links?.map((l) => ({ link: l.link })),
		};
	}

	/**
	 * 订阅文件修改事件。
	 *
	 * @param callback - 收到事件时被调用,参数为被修改文件路径。
	 * @returns 反注册函数,调用后解除订阅。
	 */
	onFileModify(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('modify', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	/**
	 * 订阅文件创建事件。
	 *
	 * @param callback - 收到事件时被调用,参数为新建文件路径。
	 * @returns 反注册函数,调用后解除订阅。
	 */
	onFileCreate(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('create', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	/**
	 * 订阅文件删除事件。
	 *
	 * @param callback - 收到事件时被调用,参数为被删除文件路径。
	 * @returns 反注册函数,调用后解除订阅。
	 */
	onFileDelete(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('delete', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	/**
	 * 订阅文件重命名事件。
	 *
	 * @param callback - 收到事件时被调用,参数为新路径 + 旧路径。
	 * @returns 反注册函数,调用后解除订阅。
	 */
	onFileRename(callback: (path: string, oldPath: string) => void): () => void {
		const ref = this.app.vault.on('rename', (file, oldPath) => callback(file.path, oldPath));
		return () => this.app.vault.offref(ref);
	}

	/**
	 * 枚举 vault 内全部 Markdown 文件路径。
	 *
	 * @returns 路径数组;未识别为 Markdown 的文件被过滤掉。
	 */
	listMarkdownFiles(): string[] {
		return this.app.vault.getMarkdownFiles().map((f) => f.path);
	}
}
