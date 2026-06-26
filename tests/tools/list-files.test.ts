import { describe, it, expect } from 'vitest';
import { createListFilesTool } from '../../src/tools/list-files';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('list_files tool', () => {
	it('根目录列表', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '', 'notes/b.md': '' },
			dirs: { '': { files: ['a.md'], folders: ['notes'] } },
		});
		const tool = createListFilesTool(vault);
		const result = await tool.execute({}) as { path: string; files: string[]; folders: string[] };
		expect(result.path).toBe('');
		expect(result.files).toContain('a.md');
		expect(result.folders).toContain('notes');
	});
});
