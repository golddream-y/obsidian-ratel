import { describe, it, expect } from 'vitest';
import { createReadNoteTool } from '../../src/tools/read-note';
import type { ObsidianVault } from '../../src/adapters/obsidian-vault';
import { composeToolDefinitions } from '../../src/prompts/composer';
import type { ToolDefinition } from '../../src/ports/llm';

function makeToolDef(name: string): ToolDefinition {
	return composeToolDefinitions({}, [name])[0]!;
}

function createMockVault(files: Record<string, string> = {}): ObsidianVault {
	return {
		readFile: async (path: string) => {
			if (path in files) return files[path]!;
			throw new Error(`File not found: ${path}`);
		},
		getMetadata: (_path: string) => null,
		getBacklinks: (_path: string) => new Map(),
		writeFile: async () => {},
		cachedRead: async (path: string) => {
			if (path in files) return files[path]!;
			throw new Error(`File not found: ${path}`);
		},
		appendFile: async () => {},
		trashFile: async () => {},
		listFiles: async () => ({ files: [], folders: [] }),
		fileExists: async (path) => path in files,
		processFile: async (path, fn) => fn(files[path] ?? ''),
		onFileModify: () => () => {},
		onFileCreate: () => () => {},
		onFileDelete: () => () => {},
		onFileRename: () => () => {},
		listMarkdownFiles: () => Object.keys(files),
	} as unknown as ObsidianVault;
}

describe('read_note tool', () => {
	it('has correct definition', () => {
		const vault = createMockVault();
		const tool = createReadNoteTool(vault, makeToolDef('read_note'));
		expect(tool.definition.name).toBe('read_note');
		// 关键路径:description 已由 Composer 注入,断言改中文「笔记」
		expect(tool.definition.description).toContain('笔记');
	});

	it('reads file content from vault', async () => {
		const vault = createMockVault({ 'notes/test.md': '# Test\nHello world' });
		const tool = createReadNoteTool(vault, makeToolDef('read_note'));
		const result = await tool.execute({ path: 'notes/test.md' }) as Record<string, unknown>;
		expect(result.content).toContain('Hello world');
	});

	it('throws on missing file', async () => {
		const vault = createMockVault();
		const tool = createReadNoteTool(vault, makeToolDef('read_note'));
		await expect(tool.execute({ path: 'missing.md' })).rejects.toThrow();
	});

	it('includes metadata in result when available', async () => {
		const vault = createMockVault({ 'notes/test.md': '# Test\nContent' });
		// Override getMetadata to return frontmatter
		const mockVault = {
			...vault,
			getMetadata: (_path: string) => ({
				frontmatter: { tags: ['test'], status: 'draft' },
				tags: [{ tag: '#test', position: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } } }],
			}),
		} as unknown as ObsidianVault;
		const tool = createReadNoteTool(mockVault, makeToolDef('read_note'));
		const result = await tool.execute({ path: 'notes/test.md' }) as Record<string, unknown>;
		expect(result.content).toContain('Content');
		expect(result.metadata).toBeDefined();
	});
});
