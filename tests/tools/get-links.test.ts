/**
 * @file tests/tools/get-links.test.ts
 * @description get_links 工具单测
 */

import { describe, it, expect } from 'vitest';
import { createGetLinksTool } from '../../src/tools/get-links';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('get_links', () => {
	it('返回出链反链与未解析链接 - 有图数据 - 三组齐全', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '' },
			links: {
				'a.md': {
					outgoing: [{ path: 'b.md', count: 2 }],
					backlinks: [{ path: 'c.md', count: 1 }],
					unresolved: [{ link: 'Missing Note', count: 1 }],
				},
			},
		});
		const tool = createGetLinksTool(vault, makeToolDef('get_links'));
		const result = await tool.execute({ path: 'a.md' });
		expect(result).toEqual({
			path: 'a.md',
			outgoing: [{ path: 'b.md', count: 2 }],
			backlinks: [{ path: 'c.md', count: 1 }],
			unresolved: [{ link: 'Missing Note', count: 1 }],
		});
	});
});
