import { describe, it, expect } from 'vitest';
import { createApplyPatchTool } from '../../src/tools/apply-patch';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

function patch(fileBody: string): string {
	return `*** Begin Patch\n*** Update File: 章/第004章.md\n${fileBody}\n*** End Patch\n`;
}

describe('apply_patch', () => {
	it('两处修改 - 一次落盘且只返回 path 和 text', async () => {
		const vault = createMockVaultPort({ files: { '章/第004章.md': '甲\n乙\n丙\n丁\n' } });
		const tool = createApplyPatchTool(vault, makeToolDef('apply_patch'));
		const res = await tool.execute({
			patch: patch('@@\n 甲\n-乙\n+乙二\n@@\n 丁\n+戊'),
		}) as { path: string; text: { length: { han: number } } };
		expect(Object.keys(res).sort()).toEqual(['path', 'text']);
		expect(res.path).toBe('章/第004章.md');
		expect(res.text.length.han).toBe(6);
		expect(await vault.readFile('章/第004章.md')).toBe('甲\n乙二\n丙\n丁\n戊\n');
	});

	it('对不上 - 文件保持原样', async () => {
		const vault = createMockVaultPort({ files: { '章/第004章.md': '甲\n乙\n' } });
		const tool = createApplyPatchTool(vault, makeToolDef('apply_patch'));
		await expect(tool.execute({ patch: patch('@@\n 不存在\n-乙\n+乙二') })).rejects.toThrow('对不上');
		expect(await vault.readFile('章/第004章.md')).toBe('甲\n乙\n');
	});

	it('Add File - 拒绝并指向 write_note', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createApplyPatchTool(vault, makeToolDef('apply_patch'));
		await expect(tool.execute({
			patch: '*** Begin Patch\n*** Add File: a.md\n+hi\n*** End Patch\n',
		})).rejects.toThrow('write_note');
	});

	it('文件不存在 - 不创建', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createApplyPatchTool(vault, makeToolDef('apply_patch'));
		await expect(tool.execute({ patch: patch('@@\n 甲\n+乙') })).rejects.toThrow('文件不存在');
		expect(await vault.fileExists('章/第004章.md')).toBe(false);
	});
});
