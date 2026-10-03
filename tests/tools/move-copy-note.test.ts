/**
 * @file tests/tools/move-copy-note.test.ts
 * @description move_note / copy_note — 换路径不重写正文
 * @module tests/tools/move-copy-note
 */
import { describe, expect, it } from 'vitest';
import { AgentsChainSeen } from '../../src/tools/note-agents';
import { createMoveNoteTool } from '../../src/tools/move-note';
import { createCopyNoteTool } from '../../src/tools/copy-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

describe('move_note / copy_note', () => {
	it('move_note - 已有笔记 - 正文跟着走且原路径消失', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': '全文' } });
		const tool = createMoveNoteTool(vault, makeToolDef('move_note'));
		const res = await tool.execute({ from: 'a.md', to: 'dir/b.md' }) as { from: string; to: string };
		expect(res).toEqual({ from: 'a.md', to: 'dir/b.md' });
		expect(await vault.readFile('dir/b.md')).toBe('全文');
		await expect(vault.readFile('a.md')).rejects.toThrow(/not found/);
	});

	it('move_note - 目录有约束 - 第一次就移动且结果不含约束正文', async () => {
		const vault = createMockVaultPort({ files: { '卷一/a.md': '全文' } });
		const seen = new AgentsChainSeen();
		const appended: string[] = [];
		const tool = createMoveNoteTool(vault, makeToolDef('move_note'), () => ({
			seen,
			readAgentsFile: async (dir) => (dir === '卷一/第一幕' ? '第一幕规则' : dir === '卷一' ? '卷一规则' : null),
			appendChain: (text) => appended.push(text),
		}));
		const res = await tool.execute({
			from: '卷一/a.md',
			to: '卷一/第一幕/a.md',
		}) as { from: string; to: string };
		expect(res).toEqual({ from: '卷一/a.md', to: '卷一/第一幕/a.md' });
		expect(JSON.stringify(res)).not.toContain('第一幕规则');
		expect(appended.join('\n')).toContain('第一幕规则');
		expect(await vault.readFile('卷一/第一幕/a.md')).toBe('全文');
	});

	it('move_note - 目标已存在 - 不覆盖', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': '全文', 'b.md': '旧' } });
		const tool = createMoveNoteTool(vault, makeToolDef('move_note'));
		await expect(tool.execute({ from: 'a.md', to: 'b.md' })).rejects.toThrow(/exists/);
		expect(await vault.readFile('b.md')).toBe('旧');
		expect(await vault.readFile('a.md')).toBe('全文');
	});

	it('move_note - 原路径不存在 - 报找不到', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createMoveNoteTool(vault, makeToolDef('move_note'));
		await expect(tool.execute({ from: 'a.md', to: 'b.md' })).rejects.toThrow(/not found/);
	});

	it('copy_note - 已有笔记 - 两份正文相同且原文件还在', async () => {
		const vault = createMockVaultPort({ files: { 'a.md': '全文' } });
		const tool = createCopyNoteTool(vault, makeToolDef('copy_note'));
		await tool.execute({ from: 'a.md', to: 'b.md' });
		expect(await vault.readFile('a.md')).toBe('全文');
		expect(await vault.readFile('b.md')).toBe('全文');
	});

	it('copy_note - 源不存在 - 抛错', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createCopyNoteTool(vault, makeToolDef('copy_note'));
		await expect(tool.execute({ from: 'a.md', to: 'b.md' })).rejects.toThrow(/not found/);
	});
});
