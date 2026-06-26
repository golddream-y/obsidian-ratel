import { describe, it, expect } from 'vitest';
import { createWriteNoteTool } from '../../src/tools/write-note';
import { createAppendNoteTool } from '../../src/tools/append-note';
import { createDeleteNoteTool } from '../../src/tools/delete-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('write/append/delete tools', () => {
	it('write_note - 新建', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createWriteNoteTool(vault);
		const res = await tool.execute({ path: 'new.md', content: '# Hi' }) as { created: boolean };
		expect(res.created).toBe(true);
		expect(await vault.readFile('new.md')).toBe('# Hi');
	});

	it('write_note - 覆盖', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'old' } });
		const tool = createWriteNoteTool(vault);
		const res = await tool.execute({ path: 'a.md', content: 'new' }) as { created: boolean };
		expect(res.created).toBe(false);
	});

	it('append_note - 追加', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'line1\n' } });
		const tool = createAppendNoteTool(vault);
		await tool.execute({ path: 'a.md', content: 'line2\n' });
		expect(await vault.readFile('a.md')).toBe('line1\nline2\n');
	});

	it('delete_note - 回收站', async () => {
		const vault = createMockVaultPort({ files: { 'del.md': 'x' } });
		const tool = createDeleteNoteTool(vault);
		const res = await tool.execute({ path: 'del.md' }) as { trashed: boolean };
		expect(res.trashed).toBe(true);
		expect(await vault.fileExists('del.md')).toBe(false);
	});
});
