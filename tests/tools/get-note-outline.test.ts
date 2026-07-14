/**
 * @file tests/tools/get-note-outline.test.ts
 * @description get_note_outline 工具单测
 */

import { describe, it, expect } from 'vitest';
import { createGetNoteOutlineTool } from '../../src/tools/get-note-outline';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('get_note_outline', () => {
	it('有 headings 缓存 - 返回 level/text/line', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': '# ignore body' },
			metadata: {
				'a.md': {
					headings: [
						{ level: 1, heading: '标题', line: 0 },
						{ level: 2, heading: '小节', line: 4 },
					],
				},
			},
		});
		const tool = createGetNoteOutlineTool(vault, makeToolDef('get_note_outline'));
		const result = (await tool.execute({ path: 'a.md' })) as {
			headings: Array<{ level: number; text: string; line?: number }>;
		};
		expect(result.headings).toEqual([
			{ level: 1, text: '标题', line: 0 },
			{ level: 2, text: '小节', line: 4 },
		]);
	});

	it('无元数据 - 空 headings + message', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': '' } });
		const tool = createGetNoteOutlineTool(vault, makeToolDef('get_note_outline'));
		const result = (await tool.execute({ path: 'a.md' })) as {
			headings: unknown[];
			message: string;
		};
		expect(result.headings).toEqual([]);
		expect(result.message.length).toBeGreaterThan(0);
	});
});
