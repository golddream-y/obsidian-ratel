import type { NoteLinks, VaultMetadata, VaultPort, VaultStructureResult } from '../../src/ports/vault';

function toStringTags(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (!Array.isArray(value)) return [];
	const tags: string[] = [];
	for (const item of value) {
		if (typeof item === 'string') tags.push(item);
	}
	return tags;
}

/** 合并内联与 frontmatter 标签，按归一化键去重（与 ObsidianVault.collectTags 一致）。 */
function collectTagsFromMetadata(metadata: VaultMetadata): string[] {
	const frontmatterTags = [
		...toStringTags(metadata.frontmatter?.tags),
		...toStringTags(metadata.frontmatter?.tag),
	];
	const tags = [...(metadata.tags?.map(({ tag }) => tag) ?? []), ...frontmatterTags];
	const unique = new Map<string, string>();
	for (const tag of tags) {
		const normalized = tag.replace(/^#/, '').toLocaleLowerCase();
		if (normalized && !unique.has(normalized)) unique.set(normalized, tag.replace(/^#/, ''));
	}
	return [...unique.values()];
}

export interface MockVaultState {
	files: Record<string, string>;
	dirs?: Record<string, { files: string[]; folders: string[] }>;
	/** 可选 mtime 覆盖;缺省用固定递增值 */
	mtimes?: Record<string, number>;
	metadata?: Record<string, import('../../src/ports/vault').VaultMetadata | null>;
	links?: Record<string, NoteLinks>;
	tagIndex?: Array<{ path: string; tags: string[] }>;
	propertyIndex?: Array<{ path: string; frontmatter: Record<string, unknown> }>;
	structure?: VaultStructureResult;
}

export function createMockVaultPort(state: MockVaultState = { files: {} }): VaultPort {
	let autoMtime = 1_700_000_000_000;
	return {
		readFile: async (path) => {
			if (!(path in state.files)) throw new Error(`File not found: ${path}`);
			return state.files[path]!;
		},
		cachedRead: async (path) => {
			if (!(path in state.files)) throw new Error(`File not found: ${path}`);
			return state.files[path]!;
		},
		writeFile: async (path, content) => {
			state.files[path] = content;
		},
		appendFile: async (path, content) => {
			state.files[path] = (state.files[path] ?? '') + content;
		},
		trashFile: async (path) => {
			delete state.files[path];
		},
		// trashFolder:SkillManageModal 删除流程的 no-op 桩,不维护目录态
		trashFolder: async () => {},
		listFiles: async (dir = '') => {
			const normalized = dir === '.' ? '' : dir;
			if (state.dirs && normalized in state.dirs) return state.dirs[normalized]!;
			const files = Object.keys(state.files)
				.filter((p) => {
					const slash = p.lastIndexOf('/');
					const parent = slash >= 0 ? p.slice(0, slash) : '';
					return parent === normalized;
				})
				.map((p) => {
					const slash = p.lastIndexOf('/');
					return slash >= 0 ? p.slice(slash + 1) : p;
				});
			return { files, folders: [] };
		},
		fileExists: async (path) => path in state.files,
		processFile: async (path, fn) => {
			const current = state.files[path] ?? '';
			const next = fn(current);
			state.files[path] = next;
			return next;
		},
		getBacklinks: (path) => new Map(
			state.links?.[path]?.backlinks.map(({ path: sourcePath, count }) => [sourcePath, count]),
		),
		getMetadata: (path) => {
			if (state.metadata && path in state.metadata) return state.metadata[path] ?? null;
			return null;
		},
		getLinks: (path) => state.links?.[path] ?? { outgoing: [], backlinks: [], unresolved: [] },
		findByTag: (tag, opts) => {
			const query = tag.replace(/^#/, '').toLocaleLowerCase();
			const limit = Math.max(0, Math.min(opts?.limit ?? 50, 200));
			const candidates = state.tagIndex ?? Object.entries(state.metadata ?? {}).flatMap(([path, metadata]) => {
				if (!metadata) return [];
				return [{ path, tags: collectTagsFromMetadata(metadata) }];
			});
			return candidates
				.filter(({ tags }) => tags.some((candidate) => {
					const normalized = candidate.replace(/^#/, '').toLocaleLowerCase();
					return normalized === query || normalized.startsWith(`${query}/`);
				}))
				.slice(0, limit);
		},
		findByProperty: (key, value, opts) => {
			const limit = Math.max(0, Math.min(opts?.limit ?? 50, 200));
			const candidates = state.propertyIndex ?? Object.entries(state.metadata ?? {}).flatMap(([path, metadata]) => {
				if (!metadata?.frontmatter) return [];
				return [{ path, frontmatter: metadata.frontmatter }];
			});
			return candidates
				.filter(({ frontmatter }) => key in frontmatter
					&& (value === undefined || JSON.stringify(frontmatter[key]) === JSON.stringify(value)))
				.slice(0, limit)
				.map(({ path, frontmatter }) => ({ path, value: frontmatter[key] }));
		},
		getVaultStructure: () => state.structure ?? { folders: [], tags: [], orphans: [] },
		listMarkdownFiles: () => Object.keys(state.files).filter((p) => p.endsWith('.md')),
		stat: (path) => {
			if (!(path in state.files)) return null;
			const mtime = state.mtimes?.[path] ?? (autoMtime += 1000);
			return { mtime, ctime: mtime, size: state.files[path]!.length };
		},
	};
}
