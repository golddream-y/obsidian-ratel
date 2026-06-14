// ObsidianVault facade — thin wrapper around Obsidian API
// From ARCHITECTURE.md section 5

import { type App, type CachedMetadata, TFile } from 'obsidian';
import type { VaultPort, VaultMetadata } from '../ports/vault';

export class ObsidianVault implements VaultPort {
	constructor(private app: App) {}

	/** Read file content */
	async readFile(path: string): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file || !(file instanceof TFile)) throw new Error(`File not found: ${path}`);
		return this.app.vault.read(file);
	}

	/** Write file (modify if exists, create if not) */
	async writeFile(path: string, content: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			const dir = path.substring(0, path.lastIndexOf('/'));
			if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
				await this.app.vault.createFolder(dir);
			}
			await this.app.vault.create(path, content);
		}
	}

	/** Get backlinks for a file (computed from resolvedLinks) */
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

	/** Get file metadata (frontmatter / links / tags) */
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

	/** Listen for file modifications */
	onFileModify(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('modify', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	/** Listen for file creations */
	onFileCreate(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('create', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	/** Listen for file deletions */
	onFileDelete(callback: (path: string) => void): () => void {
		const ref = this.app.vault.on('delete', (file) => callback(file.path));
		return () => this.app.vault.offref(ref);
	}

	/** Listen for file renames */
	onFileRename(callback: (path: string, oldPath: string) => void): () => void {
		const ref = this.app.vault.on('rename', (file, oldPath) => callback(file.path, oldPath));
		return () => this.app.vault.offref(ref);
	}

	/** List all Markdown file paths */
	listMarkdownFiles(): string[] {
		return this.app.vault.getMarkdownFiles().map((f) => f.path);
	}
}
