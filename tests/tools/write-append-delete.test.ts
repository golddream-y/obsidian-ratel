import { describe, it, expect } from 'vitest';
import { createWriteNoteTool } from '../../src/tools/write-note';
import { createAppendNoteTool } from '../../src/tools/append-note';
import { createDeleteNoteTool } from '../../src/tools/delete-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('write/append/delete tools', () => {
	it('write_note - 新建', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createWriteNoteTool(vault, makeToolDef('write_note'));
		const res = await tool.execute({ path: 'new.md', content: '# Hi' }) as {
			text: { length: { chars: number; han: number }; words: { latin: number } };
		};
		expect(Object.keys(res).sort()).toEqual(['path', 'text']);
		expect(res.text.length.chars).toBe('# Hi'.length);
		expect(res.text.length.han).toBe(0);
		expect(res.text.words.latin).toBe(1);
		expect(await vault.readFile('new.md')).toBe('# Hi');
	});

	it('write_note - 正文是占位标记 - 拒绝且不落盘', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': '原文' } });
		const tool = createWriteNoteTool(vault, makeToolDef('write_note'));
		await expect(
			tool.execute({ path: 'a.md', content: '[written] path=a.md chars=4500' }),
		).rejects.toThrow(/占位标记/);
		expect(await vault.readFile('a.md')).toBe('原文');
	});

	it('write_note - 覆盖', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'old' } });
		const tool = createWriteNoteTool(vault, makeToolDef('write_note'));
		const res = await tool.execute({ path: 'a.md', content: 'new' }) as {
			text: { length: { han: number }; words: { latin: number } };
		};
		expect(Object.keys(res).sort()).toEqual(['path', 'text']);
		expect(res.text.words.latin).toBe(1);
		expect(res.text.length.han).toBe(0);
	});

	it('append_note - 追加', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'line1\n' } });
		const tool = createAppendNoteTool(vault, makeToolDef('append_note'));
		const res = await tool.execute({ path: 'a.md', content: 'line2\n' }) as {
			text: { length: { chars: number } };
		};
		expect(await vault.readFile('a.md')).toBe('line1\nline2\n');
		expect(res.text.length.chars).toBe('line1\nline2\n'.length);
	});

	it('delete_note - 回收站', async () => {
		const vault = createMockVaultPort({ files: { 'del.md': 'x' } });
		const tool = createDeleteNoteTool(vault, makeToolDef('delete_note'));
		const res = await tool.execute({ path: 'del.md' }) as { trashed: boolean };
		expect(res.trashed).toBe(true);
		expect(await vault.fileExists('del.md')).toBe(false);
	});
});
