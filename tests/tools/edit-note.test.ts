import { describe, it, expect } from 'vitest';
import { createEditNoteTool } from '../../src/tools/edit-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('edit_note tool', () => {
	it('唯一匹配 - 替换成功', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'foo bar baz' } });
		const tool = createEditNoteTool(vault);
		const res = await tool.execute({ path: 'a.md', old_string: 'bar', new_string: 'qux' }) as { replaced: boolean };
		expect(res.replaced).toBe(true);
		expect(await vault.readFile('a.md')).toBe('foo qux baz');
	});

	it('old_string 不存在 - 报错', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'x' } });
		const tool = createEditNoteTool(vault);
		await expect(
			tool.execute({ path: 'a.md', old_string: 'missing', new_string: 'y' }),
		).rejects.toThrow('未找到要替换的文本');
	});

	it('old_string 多次匹配 - 报错', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': 'dup\ndup' } });
		const tool = createEditNoteTool(vault);
		await expect(
			tool.execute({ path: 'a.md', old_string: 'dup', new_string: 'x' }),
		).rejects.toThrow('出现多次');
	});
});
