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
		modify: async (file: { path: string }, content: string) => {
			files.set(file.path, { content, mtime: Date.now() });
		},
		create: async (path: string, content: string) => {
			files.set(path, { content, mtime: Date.now() });
		},
		createFolder: async (_path: string) => {},
		getMarkdownFiles: () => {
			return Array.from(files.keys())
				.filter((p) => p.endsWith('.md'))
				.map((p) => ({ path: p, stat: { mtime: files.get(p)!.mtime } }));
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
	// Use create to add file
	(mockApp.vault as { create: (p: string, c: string) => Promise<void> }).create(path, content);
}
