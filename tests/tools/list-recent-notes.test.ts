/**
 * @file tests/tools/list-recent-notes.test.ts
 * @description list_recent_notes 工具单测
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createListRecentNotesTool } from '../../src/tools/list-recent-notes';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';
import { setConfigDir } from '../../src/utils/path-safety';

describe('list_recent_notes', () => {
	beforeEach(() => setConfigDir('.obsidian'));

	it('按 mtime 降序 - 最近在前', async () => {
		const vault = createMockVaultPort({
			files: {
				'old.md': 'a',
				'new.md': 'b',
				'.ratel/memory/global.md': 'x',
			},
			mtimes: {
				'old.md': 1000,
				'new.md': 3000,
				'.ratel/memory/global.md': 9999,
			},
		});
		const tool = createListRecentNotesTool(vault, makeToolDef('list_recent_notes'));
		const result = (await tool.execute({ limit: 10 })) as {
			notes: Array<{ path: string; mtime: number }>;
		};
		expect(result.notes.map((n) => n.path)).toEqual(['new.md', 'old.md']);
	});
});
