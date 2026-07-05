import { describe, it, expect } from 'vitest';
import { createReadNoteTool } from '../../src/tools/read-note';
import type { ObsidianVault } from '../../src/adapters/obsidian-vault';
import { makeToolDef } from '../helpers/make-tool-def';

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

describe('read_note 工具', () => {
	it('read_note - 工具定义 - name 为 read_note 且 description 含笔记', () => {
		const vault = createMockVault();
		const tool = createReadNoteTool(vault, makeToolDef('read_note'));
		expect(tool.definition.name).toBe('read_note');
		// 关键路径:description 已由 Composer 注入,断言改中文「笔记」
		expect(tool.definition.description).toContain('笔记');
	});

	it('read_note - 文件存在 - 返回内容', async () => {
		const vault = createMockVault({ 'notes/test.md': '# Test\nHello world' });
		const tool = createReadNoteTool(vault, makeToolDef('read_note'));
		const result = await tool.execute({ path: 'notes/test.md' }) as Record<string, unknown>;
		expect(result.content).toContain('Hello world');
	});

	it('read_note - 文件不存在 - 抛错', async () => {
		const vault = createMockVault();
		const tool = createReadNoteTool(vault, makeToolDef('read_note'));
		await expect(tool.execute({ path: 'missing.md' })).rejects.toThrow();
	});

	it('read_note - metadata 可用 - 结果含 frontmatter', async () => {
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

	it('read_note - path 缺失 - 抛错带字段名', async () => {
		const vault = createMockVault();
		const tool = createReadNoteTool(vault, makeToolDef('read_note'));
		await expect(tool.execute({})).rejects.toThrow(/path/);
	});
});
