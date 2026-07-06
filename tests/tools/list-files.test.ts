import { describe, it, expect, beforeEach } from 'vitest';
import { createListFilesTool } from '../../src/tools/list-files';
import { setConfigDir } from '../../src/utils/path-safety';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('list_files tool', () => {
	// 关键路径:模拟生产环境 configDir,否则 isExcludedVaultPath 无法识别 .obsidian
	beforeEach(() => setConfigDir('.obsidian'));
	it('根目录列表 - 空参数返回 "." 作为路径标识', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '', 'notes/b.md': '' },
			dirs: { '': { files: ['a.md'], folders: ['notes'] } },
		});
		const tool = createListFilesTool(vault, makeToolDef('list_files'));
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
		const tool = createListFilesTool(vault, makeToolDef('list_files'));
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
		const tool = createListFilesTool(vault, makeToolDef('list_files'));
		const result = await tool.execute({ path: '.' }) as { path: string; files: string[]; folders: string[] };
		expect(result.path).toBe('.');
		expect(result.files).toContain('a.md');
	});
});
