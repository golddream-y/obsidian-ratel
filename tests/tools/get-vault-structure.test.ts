/**
 * @file tests/tools/get-vault-structure.test.ts
 * @description get_vault_structure 工具单测
 */

import { describe, it, expect, vi } from 'vitest';
import { createGetVaultStructureTool } from '../../src/tools/get-vault-structure';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('get_vault_structure', () => {
	it('include 省略 - 默认全维 - 返回 folders/tags/orphans', async () => {
		const structure = {
			folders: ['notes'],
			tags: [{ tag: 'project', count: 2 }],
			orphans: ['lonely.md'],
		};
		const vault = createMockVaultPort({ files: {}, structure });
		const tool = createGetVaultStructureTool(vault, makeToolDef('get_vault_structure'));
		const result = await tool.execute({});
		expect(result).toEqual(structure);
	});

	it('include orphans - 只请求孤儿 - 调用端口并透传', async () => {
		const orphansOnly = { orphans: ['lonely.md'] };
		const vault = createMockVaultPort({
			files: {},
			structure: {
				folders: ['notes'],
				tags: [{ tag: 'project', count: 1 }],
				orphans: ['lonely.md'],
			},
		});
		const getVaultStructure = vi.fn(() => orphansOnly);
		vault.getVaultStructure = getVaultStructure;
		const tool = createGetVaultStructureTool(vault, makeToolDef('get_vault_structure'));
		const result = await tool.execute({ include: ['orphans'] });
		expect(getVaultStructure).toHaveBeenCalledWith(['orphans']);
		expect(result).toEqual(orphansOnly);
	});

	it('端口返回原样透传 - 自定义结构 - 不改动结果', async () => {
		const custom = { folders: ['inbox', 'archive'], tags: [], orphans: [] };
		const vault = createMockVaultPort({ files: {} });
		vault.getVaultStructure = vi.fn(() => custom);
		const tool = createGetVaultStructureTool(vault, makeToolDef('get_vault_structure'));
		const result = await tool.execute({});
		expect(result).toBe(custom);
	});
});
