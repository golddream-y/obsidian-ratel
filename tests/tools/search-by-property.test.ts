/**
 * @file tests/tools/search-by-property.test.ts
 * @description search_by_property 工具单测
 */

import { describe, it, expect } from 'vitest';
import { createSearchByPropertyTool } from '../../src/tools/search-by-property';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('search_by_property', () => {
	it('等值过滤 - status=draft - 只返回匹配笔记', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '', 'b.md': '' },
			metadata: {
				'a.md': { frontmatter: { status: 'draft' } },
				'b.md': { frontmatter: { status: 'done' } },
			},
		});
		const tool = createSearchByPropertyTool(vault, makeToolDef('search_by_property'));
		const result = (await tool.execute({ key: 'status', value: 'draft' })) as Array<{
			path: string;
			value: unknown;
		}>;
		expect(result).toEqual([{ path: 'a.md', value: 'draft' }]);
	});

	it('仅键存在 - 不传 value - 返回所有含该键的笔记', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '', 'b.md': '', 'c.md': '' },
			metadata: {
				'a.md': { frontmatter: { status: 'draft' } },
				'b.md': { frontmatter: { status: 'done' } },
				'c.md': { frontmatter: { title: 'no status' } },
			},
		});
		const tool = createSearchByPropertyTool(vault, makeToolDef('search_by_property'));
		const result = (await tool.execute({ key: 'status' })) as Array<{ path: string }>;
		expect(result.map((r) => r.path).sort()).toEqual(['a.md', 'b.md']);
	});
});
