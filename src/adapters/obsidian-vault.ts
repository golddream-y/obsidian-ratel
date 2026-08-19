/**
 * @file src/adapters/obsidian-vault.ts
 * @description Obsidian API 薄包装 — `VaultPort` 在宿主环境的实现
 * @module adapters/obsidian-vault
 * @depends obsidian, ports/vault
 */

import { type App, FileSystemAdapter, TFile, TFolder } from 'obsidian';
import type { NoteLinks, VaultPort, VaultMetadata, VaultStructureResult } from '../ports/vault';
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

	/**
	 * 把整个文件夹移入回收站(S-SKILL-UX 供 SkillManageModal 删库内技能目录)。
	 *
	 * @param path - vault 相对文件夹路径(如 `.ratel/skills/<name>`)
	 * @throws 路径不存在或不是文件夹时抛 i18n 错误
	 */
	async trashFolder(path: string): Promise<void> {
		const normalized = validateVaultPath(path);
		const folder = this.app.vault.getAbstractFileByPath(normalized);
		if (!folder || !(folder instanceof TFolder)) {
			throw new Error(tNow('error.tool.fileNotFound', { path: normalized }));
		}
		// 关键路径:fileManager.trashFile 同时接受 TFile|TFolder,自动走系统回收站/.trash。
		await this.app.fileManager.trashFile(folder);
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

	/**
	 * 获取笔记的出链、反链与未解析链接。
	 *
	 * @param path - vault 相对路径。
	 * @returns 直接从 metadataCache 生成的实时图谱切片。
	 */
	getLinks(path: string): NoteLinks {
		// 关键路径:链接关系由 metadataCache 维护，避免读取文件或依赖文件系统。
		const resolved = this.app.metadataCache.resolvedLinks[path] ?? {};
		const unresolvedRaw = this.app.metadataCache.unresolvedLinks[path] ?? {};
		const backlinks = this.getBacklinks(path);
		return {
			outgoing: Object.entries(resolved).map(([targetPath, count]) => ({ path: targetPath, count })),
			backlinks: [...backlinks.entries()].map(([sourcePath, count]) => ({ path: sourcePath, count })),
			unresolved: Object.entries(unresolvedRaw).map(([link, count]) => ({ link, count })),
		};
	}

	/**
	 * 按标签查询笔记，父标签会匹配其所有嵌套标签。
	 *
	 * @param tag - 标签名，可带 `#` 前缀。
	 * @param opts - 可选的结果数量限制。
	 * @returns 匹配的路径及保留原始写法的标签。
	 */
	findByTag(tag: string, opts?: { limit?: number }): Array<{ path: string; tags: string[] }> {
		const query = this.normalizeTag(tag);
		const limit = this.resolveLimit(opts?.limit);
		const results: Array<{ path: string; tags: string[] }> = [];

		for (const path of this.listMarkdownFiles()) {
			const tags = this.collectTags(path);
			if (tags.some((candidate) => {
				const normalized = this.normalizeTag(candidate);
				return normalized === query || normalized.startsWith(`${query}/`);
			})) {
				results.push({ path, tags });
				if (results.length >= limit) break;
			}
		}
		return results;
	}

	/**
	 * 按 frontmatter 属性查询笔记。
	 *
	 * @param key - frontmatter 属性名。
	 * @param value - 目标值；省略时只检查属性存在。
	 * @param opts - 可选的结果数量限制。
	 * @returns 匹配的路径及属性值。
	 */
	findByProperty(key: string, value?: unknown, opts?: { limit?: number }): Array<{ path: string; value: unknown }> {
		const limit = this.resolveLimit(opts?.limit);
		const results: Array<{ path: string; value: unknown }> = [];

		for (const path of this.listMarkdownFiles()) {
			const frontmatter = this.getMetadata(path)?.frontmatter;
			if (!frontmatter || !(key in frontmatter)) continue;
			const propertyValue = frontmatter[key];
			if (value !== undefined && JSON.stringify(propertyValue) !== JSON.stringify(value)) continue;
			results.push({ path, value: propertyValue });
			if (results.length >= limit) break;
		}
		return results;
	}

	/**
	 * 获取 vault 的目录、标签统计与孤儿笔记。
	 *
	 * @param include - 需要收集的维度；省略时包含全部。
	 * @returns 仅包含所请求维度的 vault 结构概览。
	 */
	getVaultStructure(include: Array<'folders' | 'tags' | 'orphans'> = ['folders', 'tags', 'orphans']): VaultStructureResult {
		const requested = new Set(include);
		const paths = this.listMarkdownFiles();
		const result: VaultStructureResult = {};

		if (requested.has('folders')) {
			result.folders = [...new Set(paths
				.map((path) => path.lastIndexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '')
				.filter(Boolean))]
				.sort();
		}

		if (requested.has('tags')) {
			const tags = new Map<string, { tag: string; count: number }>();
			for (const path of paths) {
				for (const tag of this.collectTags(path)) {
					const normalized = this.normalizeTag(tag);
					const existing = tags.get(normalized);
					if (existing) existing.count += 1;
					else tags.set(normalized, { tag, count: 1 });
				}
			}
			result.tags = [...tags.values()].sort((left, right) => left.tag.localeCompare(right.tag));
		}

		if (requested.has('orphans')) {
			result.orphans = paths
				.filter((path) => {
					const normalizedPath = path.toLowerCase();
					if (normalizedPath.startsWith('.') || normalizedPath.startsWith('templates/')) return false;
					const links = this.getLinks(path);
					return links.outgoing.length === 0 && links.backlinks.length === 0;
				})
				.sort();
		}

		return result;
	}

	/**
	 * 汇集笔记内联标签与 frontmatter 标签。
	 *
	 * @param path - vault 相对路径。
	 * @returns 去重后、保留库内原始写法的标签列表。
	 */
	private collectTags(path: string): string[] {
		const metadata = this.getMetadata(path);
		if (!metadata) return [];
		const frontmatter = metadata.frontmatter;
		const frontmatterTags = [
			...this.toStringTags(frontmatter?.tags),
			...this.toStringTags(frontmatter?.tag),
		];
		const tags = [...(metadata.tags?.map(({ tag }) => tag) ?? []), ...frontmatterTags];
		const unique = new Map<string, string>();
		for (const tag of tags) {
			const normalized = this.normalizeTag(tag);
			if (normalized && !unique.has(normalized)) unique.set(normalized, tag.replace(/^#/, ''));
		}
		return [...unique.values()];
	}

	private toStringTags(value: unknown): string[] {
		if (typeof value === 'string') return [value];
		if (!Array.isArray(value)) return [];
		const tags: string[] = [];
		for (const item of value) {
			if (typeof item === 'string') tags.push(item);
		}
		return tags;
	}

	private normalizeTag(tag: string): string {
		return tag.replace(/^#/, '').toLocaleLowerCase();
	}

	private resolveLimit(limit: number | undefined): number {
		return Math.max(0, Math.min(limit ?? 50, 200));
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

	/**
	 * 获取 vault 根目录绝对路径(P-SKILL-2/ADR-017 供 skill 脚本沙箱白名单)。
	 *
	 * 关键路径:Obsidian 类型上 `getBasePath` 只在 FileSystemAdapter 上,
	 * DataAdapter 基接口无此方法,须收窄断言;桌面端(isDesktopOnly)恒为文件系统实现。
	 */
	getRootDir(): string {
		return (this.app.vault.adapter as FileSystemAdapter).getBasePath();
	}
}
