/**
 * @file src/adapters/obsidian-vault.ts
 * @description Obsidian API 薄包装 — `VaultPort` 在宿主环境的实现
 * @module adapters/obsidian-vault
 * @depends obsidian, ports/vault
 */

import { type App, TFile } from 'obsidian';
import type { VaultPort, VaultMetadata } from '../ports/vault';
import { validateVaultPath } from '../utils/path-safety';
import { tNow } from '../i18n';

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

	private resolveFile(path: string): TFile {
		const normalized = validateVaultPath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!file || !(file instanceof TFile)) throw new Error(tNow('error.tool.fileNotFound', { path: normalized }));
		return file;
	}

	/**
	 * 读取文件全文。
	 */
	async readFile(path: string): Promise<string> {
		const file = this.resolveFile(path);
		return this.app.vault.read(file);
	}

	async cachedRead(path: string): Promise<string> {
		const file = this.resolveFile(path);
		return this.app.vault.cachedRead(file);
	}

	/**
	 * 写入文件 — 文件存在则覆盖,不存在则创建。
	 */
	async writeFile(path: string, content: string): Promise<void> {
		const normalized = validateVaultPath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			const dir = normalized.substring(0, normalized.lastIndexOf('/'));
			if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
				await this.app.vault.createFolder(dir);
			}
			await this.app.vault.create(normalized, content);
		}
	}

	async appendFile(path: string, content: string): Promise<void> {
		const normalized = validateVaultPath(path);
		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (file instanceof TFile) {
			await this.app.vault.append(file, content);
		} else {
			await this.app.vault.create(normalized, content);
		}
	}

	async trashFile(path: string): Promise<void> {
		const file = this.resolveFile(path);
		// 关键路径:用 fileManager.trashFile 替代 vault.trash,
		// 自动尊重用户的删除偏好设置(系统回收站 / Obsidian .trash)。
		await this.app.fileManager.trashFile(file);
	}

	async listFiles(dir: string = ''): Promise<{ files: string[]; folders: string[] }> {
		const normalized = dir ? validateVaultPath(dir) : '';
		const result = await this.app.vault.adapter.list(normalized);
		return { files: result.files, folders: result.folders };
	}

	async fileExists(path: string): Promise<boolean> {
		const normalized = validateVaultPath(path);
		return this.app.vault.adapter.exists(normalized);
	}

	async processFile(path: string, fn: (content: string) => string): Promise<string> {
		const file = this.resolveFile(path);
		return this.app.vault.process(file, fn);
	}

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

	getMetadata(path: string): VaultMetadata | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return null;
		// 关键路径:用 instanceof 替代 `as TFile` 强制转换 — getAbstractFileByPath 可能返回 TFolder,
		// getFileCache 只接受 TFile,故先做类型收窄,非 TFile 直接返回 null。
		if (!(file instanceof TFile)) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return null;
		return {
			// 关键路径:cache.frontmatter 类型为 Record<string, any> | undefined,
			// 与 VaultMetadata.frontmatter(Record<string, unknown> | undefined)兼容,无需显式断言。
			frontmatter: cache.frontmatter,
			tags: cache.tags?.map((t) => ({ tag: t.tag })),
			links: cache.links?.map((l) => ({ link: l.link })),
			// 关键路径:大纲走 metadataCache.headings,禁止工具层 cachedRead + 正则扫全文。
			headings: cache.headings?.map((h) => ({
				level: h.level,
				heading: h.heading,
				line: h.position.start.line,
			})),
		};
	}

	onFileModify(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('modify', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	onFileCreate(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('create', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	onFileDelete(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('delete', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	onFileRename(callback: (path: string, oldPath: string) => void): () => void {
		const ref = this.app.vault.on('rename', (file, oldPath) => callback(file.path, oldPath));
		return () => this.app.vault.offref(ref);
	}

	listMarkdownFiles(): string[] {
		return this.app.vault.getMarkdownFiles().map((f) => f.path);
	}

	/**
	 * 获取文件 stat(mtime/ctime/size)。
	 *
	 * 关键路径:smart reindex 用 mtime 作为文件变更的快速跳过信号;
	 * 文件不存在或不是 TFile 时返回 null,由调用方降级处理。
	 */
	stat(path: string): { mtime: number; ctime: number; size: number } | null {
		const abstractFile = this.app.vault.getAbstractFileByPath(path);
		if (!abstractFile || !('stat' in abstractFile)) return null;
		const stat = (abstractFile as { stat: { mtime: number; ctime: number; size: number } }).stat;
		return stat;
	}
}
