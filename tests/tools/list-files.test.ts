import { describe, it, expect } from 'vitest';
import { createListFilesTool } from '../../src/tools/list-files';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('list_files tool', () => {
	it('根目录列表 - 空参数返回 "." 作为路径标识', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '', 'notes/b.md': '' },
			dirs: { '': { files: ['a.md'], folders: ['notes'] } },
		});
		const tool = createListFilesTool(vault);
		const result = await tool.execute({}) as { path: string; files: string[]; folders: string[] };
		expect(result.path).toBe('.');
		expect(result.files).toContain('a.md');
		expect(result.folders).toContain('notes');
	});

	it('根目录列表 - 过滤 .obsidian 和 .trash', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '' },
			dirs: { '': { files: ['a.md'], folders: ['notes', '.obsidian', '.trash'] } },
		});
		const tool = createListFilesTool(vault);
		const result = await tool.execute({ path: '' }) as { path: string; files: string[]; folders: string[] };
		expect(result.folders).toContain('notes');
		expect(result.folders).not.toContain('.obsidian');
		expect(result.folders).not.toContain('.trash');
	});

	it('根目录列表 - path="." 归一化为根目录', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '' },
			dirs: { '': { files: ['a.md'], folders: [] } },
		});
		const tool = createListFilesTool(vault);
		const result = await tool.execute({ path: '.' }) as { path: string; files: string[]; folders: string[] };
		expect(result.path).toBe('.');
		expect(result.files).toContain('a.md');
	});
});
