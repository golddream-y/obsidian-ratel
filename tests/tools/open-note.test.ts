/**
 * @file tests/tools/open-note.test.ts
 * @description open_note 工具单测 — 路径归一化 / 锚点拼接 / path 内嵌锚点拆分 / 文件不存在降级
 * @module tests/tools/open-note
 * @depends ../../src/tools/open-note, ../helpers/mock-vault-port, ../helpers/make-tool-def
 */

import { describe, it, expect, vi } from 'vitest';
import { createOpenNoteTool } from '../../src/tools/open-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';
import type { WorkspacePort } from '../../src/ports/workspace';

function mockWorkspace(openNote = vi.fn().mockResolvedValue(true)): WorkspacePort {
	return {
		getActiveFilePath: () => null,
		getActiveSelection: () => null,
		openNote: openNote as WorkspacePort['openNote'],
		openPluginSettings: vi.fn(),
	};
}

describe('open_note', () => {
	it('文件存在无锚点 - 直接传 path 打开', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		const result = (await tool.execute({ path: 'notes/foo.md' })) as Record<string, unknown>;
		expect(openNote).toHaveBeenCalledWith('notes/foo.md');
		expect(result.opened).toBe(true);
		expect(tool.readOnly).toBe(true);
	});

	it('path 省略 .md - 归一化补扩展名后验证', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		await tool.execute({ path: 'notes/foo' });
		expect(openNote).toHaveBeenCalledWith('notes/foo.md');
	});

	it('标题锚点 - 拼接 path#标题', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		await tool.execute({ path: 'notes/foo.md', anchor: '第二章 安装' });
		expect(openNote).toHaveBeenCalledWith('notes/foo.md#第二章 安装');
	});

	it('块锚点 ^abc - 拼接 path#^abc', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		await tool.execute({ path: 'notes/foo.md', anchor: '^abc123' });
		expect(openNote).toHaveBeenCalledWith('notes/foo.md#^abc123');
	});

	it('文件不存在 - 不抛错,返回降级提示与 opened=false', async () => {
		const openNote = vi.fn();
		const vault = createMockVaultPort({ files: { 'other.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		const result = (await tool.execute({ path: 'notes/foo.md' })) as Record<string, unknown>;
		expect(result.opened).toBe(false);
		expect(String(result.message)).toContain('search_vault');
		expect(openNote).not.toHaveBeenCalled();
	});

	it('path 内嵌锚点 foo.md#标题 - 拆分后正确打开', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		const result = (await tool.execute({ path: 'notes/foo.md#第二章' })) as Record<string, unknown>;
		expect(openNote).toHaveBeenCalledWith('notes/foo.md#第二章');
		expect(result.opened).toBe(true);
	});

	it('anchor 带 # 前缀 - 归一化后拼接单井号', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		await tool.execute({ path: 'notes/foo.md', anchor: '#标题' });
		expect(openNote).toHaveBeenCalledWith('notes/foo.md#标题');
	});

	it('打开失败 - 返回 opened=false 与提示', async () => {
		const openNote = vi.fn().mockResolvedValue(false);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		const result = (await tool.execute({ path: 'notes/foo.md' })) as Record<string, unknown>;
		expect(result.opened).toBe(false);
		expect(result.message).toBeTruthy();
		expect(result.path).toBe('notes/foo.md');
	});

	it('path 非字符串 - 返回参数错误提示不探测', async () => {
		const openNote = vi.fn();
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const fileExistsSpy = vi.spyOn(vault, 'fileExists');
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		const result = (await tool.execute({ path: 123 })) as Record<string, unknown>;
		expect(result.opened).toBe(false);
		expect(String(result.message)).toContain('字符串');
		expect(fileExistsSpy).not.toHaveBeenCalled();
		expect(openNote).not.toHaveBeenCalled();
	});

	it('path 内嵌块锚点 foo.md#^abc - 拆分块 ID', async () => {
		const openNote = vi.fn().mockResolvedValue(true);
		const vault = createMockVaultPort({ files: { 'notes/foo.md': 'hi' } });
		const tool = createOpenNoteTool(mockWorkspace(openNote), vault, makeToolDef('open_note'));
		const result = (await tool.execute({ path: 'notes/foo.md#^abc123' })) as Record<string, unknown>;
		expect(openNote).toHaveBeenCalledWith('notes/foo.md#^abc123');
		expect(result.opened).toBe(true);
	});
});
