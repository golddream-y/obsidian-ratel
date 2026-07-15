/**
 * @file tests/tools/search-by-tag.test.ts
 * @description search_by_tag 工具单测
 */

import { describe, it, expect } from 'vitest';
import { createSearchByTagTool } from '../../src/tools/search-by-tag';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('search_by_tag', () => {
	it('前缀匹配嵌套 tag - tag=project - 命中 project 与 project/active', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '', 'b.md': '', 'c.md': '' },
			metadata: {
				'a.md': { tags: [{ tag: '#project' }] },
				'b.md': { tags: [{ tag: '#project/active' }] },
				'c.md': { tags: [{ tag: '#other' }] },
			},
		});
		const tool = createSearchByTagTool(vault, makeToolDef('search_by_tag'));
		const result = (await tool.execute({ tag: 'project' })) as Array<{ path: string }>;
		expect(result.map((r) => r.path).sort()).toEqual(['a.md', 'b.md']);
	});

	it('limit 截断 - limit=1 - 只返回 1 条', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '', 'b.md': '', 'c.md': '' },
			metadata: {
				'a.md': { tags: [{ tag: '#project' }] },
				'b.md': { tags: [{ tag: '#project/active' }] },
				'c.md': { tags: [{ tag: '#project/archive' }] },
			},
		});
		const tool = createSearchByTagTool(vault, makeToolDef('search_by_tag'));
		const result = (await tool.execute({ tag: 'project', limit: 1 })) as Array<{ path: string }>;
		expect(result).toHaveLength(1);
	});
});
