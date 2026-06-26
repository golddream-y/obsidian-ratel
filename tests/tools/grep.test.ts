import { describe, it, expect } from 'vitest';
import { createGrepTool } from '../../src/tools/grep';
import { createMockVaultPort } from '../helpers/mock-vault-port';

describe('grep tool', () => {
	it('字面量匹配 - 找到关键词', async () => {
		const vault = createMockVaultPort({
			files: {
				'notes/a.md': '第一行\n包含死字的行\n第三行',
				'.obsidian/hidden.md': '死',
			},
		});
		const tool = createGrepTool(vault);
		const results = await tool.execute({
			pattern: '死',
			is_regex: false,
			context_lines: 1,
		}) as Array<{ file: string; line: number; match: string }>;
		expect(results).toHaveLength(1);
		expect(results[0]!.file).toBe('notes/a.md');
		expect(results[0]!.match).toContain('死');
	});

	it('max_results - 提前截断', async () => {
		const vault = createMockVaultPort({
			files: { 'a.md': 'x\nx\nx', 'b.md': 'x\nx' },
		});
		const tool = createGrepTool(vault);
		const results = await tool.execute({ pattern: 'x', is_regex: false, max_results: 2 });
		expect(results).toHaveLength(2);
	});

	it('path 限定目录', async () => {
		const vault = createMockVaultPort({
			files: { 'daily/a.md': 'hit', 'other/b.md': 'hit' },
		});
		const tool = createGrepTool(vault);
		const results = await tool.execute({ pattern: 'hit', is_regex: false, path: 'daily' }) as Array<{ file: string }>;
		expect(results.every((r) => r.file.startsWith('daily/'))).toBe(true);
	});
});
