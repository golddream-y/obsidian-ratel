import type { VaultPort } from '../../src/ports/vault';

export interface MockVaultState {
	files: Record<string, string>;
	dirs?: Record<string, { files: string[]; folders: string[] }>;
}

export function createMockVaultPort(state: MockVaultState = { files: {} }): VaultPort {
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
		getMetadata: () => null,
		listMarkdownFiles: () => Object.keys(state.files).filter((p) => p.endsWith('.md')),
	};
}
