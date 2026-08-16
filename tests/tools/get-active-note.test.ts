/**
 * @file tests/tools/get-active-note.test.ts
 * @description get_active_note 工具单测
 */

import { describe, it, expect } from 'vitest';
import { createGetActiveNoteTool } from '../../src/tools/get-active-note';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';
import type { WorkspacePort } from '../../src/ports/workspace';

function mockWorkspace(path: string | null, selection: string | null = null): WorkspacePort {
	return {
		getActiveFilePath: () => path,
		getActiveSelection: () => selection,
		// 本工具不消费 UI 操作;补齐 WorkspacePort 新增方法的最小桩
		openNote: () => Promise.resolve(false),
		openPluginSettings: () => Promise.resolve(false),
	};
}

describe('get_active_note', () => {
	it('无活动文件 - 返回 path=null 与 message', async () => {
		const vault = createMockVaultPort();
		const tool = createGetActiveNoteTool(mockWorkspace(null), vault, makeToolDef('get_active_note'));
		const result = (await tool.execute({})) as { path: null; message: string };
		expect(result.path).toBeNull();
		expect(result.message.length).toBeGreaterThan(0);
	});

	it('有路径+选区 - 返回 basename 与 selection', async () => {
		const vault = createMockVaultPort({
			files: { 'notes/foo.md': 'hi' },
			metadata: { 'notes/foo.md': { frontmatter: { title: 'Foo' } } },
		});
		const tool = createGetActiveNoteTool(
			mockWorkspace('notes/foo.md', '选中片段'),
			vault,
			makeToolDef('get_active_note'),
		);
		const result = (await tool.execute({})) as {
			path: string;
			basename: string;
			selection: string;
			frontmatter: Record<string, unknown>;
		};
		expect(result.path).toBe('notes/foo.md');
		expect(result.basename).toBe('foo.md');
		expect(result.selection).toBe('选中片段');
		expect(result.frontmatter).toEqual({ title: 'Foo' });
	});
});
