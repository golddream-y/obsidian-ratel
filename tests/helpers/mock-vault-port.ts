import type { VaultPort } from '../../src/ports/vault';

export interface MockVaultState {
	files: Record<string, string>;
	dirs?: Record<string, { files: string[]; folders: string[] }>;
	/** 可选 mtime 覆盖;缺省用固定递增值 */
	mtimes?: Record<string, number>;
	metadata?: Record<string, import('../../src/ports/vault').VaultMetadata | null>;
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
		getBacklinks: () => new Map(),
		getMetadata: (path) => {
			if (state.metadata && path in state.metadata) return state.metadata[path] ?? null;
			return null;
		},
		listMarkdownFiles: () => Object.keys(state.files).filter((p) => p.endsWith('.md')),
		stat: (path) => {
			if (!(path in state.files)) return null;
			const mtime = state.mtimes?.[path] ?? (autoMtime += 1000);
			return { mtime, ctime: mtime, size: state.files[path]!.length };
		},
	};
}
