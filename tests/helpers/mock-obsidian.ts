import type { App } from 'obsidian';

/**
 * Minimal mock of Obsidian App for testing adapters.
 * Only includes methods used by ObsidianVault facade.
 */
export function createMockApp(overrides?: Partial<App>): App {
	const files = new Map<string, { content: string; mtime: number }>();

	const mockVault = {
		getAbstractFileByPath: (path: string) => {
			if (files.has(path)) {
				return { path, stat: { mtime: files.get(path)!.mtime } };
			}
			return null;
		},
		read: async (file: { path: string }) => {
			const entry = files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			return entry.content;
		},
		cachedRead: async (file: { path: string }) => {
			const entry = files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			return entry.content;
		},
		modify: async (file: { path: string }, content: string) => {
			files.set(file.path, { content, mtime: Date.now() });
		},
		append: async (file: { path: string }, content: string) => {
			const entry = files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			entry.content += content;
		},
		create: async (path: string, content: string) => {
			files.set(path, { content, mtime: Date.now() });
		},
		createFolder: async (_path: string) => {},
		trash: async (file: { path: string }) => {
			files.delete(file.path);
		},
		process: async (file: { path: string }, fn: (data: string) => string) => {
			const entry = files.get(file.path);
			if (!entry) throw new Error(`File not found: ${file.path}`);
			entry.content = fn(entry.content);
			return entry.content;
		},
		getMarkdownFiles: () => {
			return Array.from(files.keys())
				.filter((p) => p.endsWith('.md'))
				.map((p) => ({ path: p, stat: { mtime: files.get(p)!.mtime } }));
		},
		adapter: {
			list: async (dir: string) => {
				const prefix = dir ? `${dir}/` : '';
				const fileNames = new Set<string>();
				const folderNames = new Set<string>();
				for (const p of files.keys()) {
					if (dir && !p.startsWith(prefix)) continue;
					const rest = dir ? p.slice(prefix.length) : p;
					const slash = rest.indexOf('/');
					if (slash === -1) fileNames.add(rest);
					else folderNames.add(rest.slice(0, slash));
				}
				return { files: [...fileNames], folders: [...folderNames] };
			},
			exists: async (path: string) => files.has(path),
		},
		on: (_event: string, _callback: () => void) => ({}),
		offref: (_ref: unknown) => {},
	};

	const mockMetadataCache = {
		resolvedLinks: {} as Record<string, Record<string, number>>,
		getFileCache: (_file: unknown) => null,
		getBacklinksForFile: (_file: unknown) => ({ data: new Map() }),
	};

	return {
		vault: mockVault,
		metadataCache: mockMetadataCache,
		...overrides,
	} as unknown as App;
}

/**
 * Add a file to the mock vault's file map.
 */
export function addMockFile(
	mockApp: App,
	path: string,
	content: string,
	_mtime = Date.now(),
): void {
	void _mtime;
	(mockApp.vault as { create: (p: string, c: string) => Promise<void> }).create(path, content);
}
