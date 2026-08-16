import { describe, it, expect, vi } from 'vitest';
import {
	ToolPermissionSessionGrants,
	resolveToolPermission,
	isDestructiveTool,
} from '../../src/core/tool-permissions';
import type { ToolCall } from '../../src/ports/llm';

const writeCall: ToolCall = { id: '1', name: 'write_note', args: { path: 'a.md', content: 'x' } };
const deleteCall: ToolCall = { id: '2', name: 'delete_note', args: { path: 'a.md' } };
const mcpCall: ToolCall = { id: '3', name: 'mcp__srv__tool', args: {} };

describe('isDestructiveTool', () => {
	it('isDestructiveTool - delete_note / forget_memory - true', () => {
		expect(isDestructiveTool('delete_note')).toBe(true);
		expect(isDestructiveTool('forget_memory')).toBe(true);
		expect(isDestructiveTool('write_note')).toBe(false);
		expect(isDestructiveTool('mcp__x__y')).toBe(true);
	});
});

describe('resolveToolPermission 档位', () => {
	it('deny - 任意档位 - 仍抛错', async () => {
		const grants = new ToolPermissionSessionGrants();
		await expect(
			resolveToolPermission(
				writeCall,
				{ toolPermissionLevel: 'danger', toolPermissions: { write_note: 'deny' } },
				grants,
				vi.fn(),
			),
		).rejects.toThrow('已被禁用');
	});

	it('auto - write_note ask - 不弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn();
		await resolveToolPermission(
			writeCall,
			{ toolPermissionLevel: 'auto', toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('auto - delete_note ask - 仍弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('allow' as const);
		await resolveToolPermission(
			deleteCall,
			{ toolPermissionLevel: 'auto', toolPermissions: { delete_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('auto - MCP 工具 - 仍弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('allow' as const);
		await resolveToolPermission(
			mcpCall,
			{ toolPermissionLevel: 'auto', toolPermissions: {} },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('auto - update_app_config - 仍弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('allow' as const);
		const cfgCall: ToolCall = { id: '4', name: 'update_app_config', args: { updates: {} } };
		await resolveToolPermission(
			cfgCall,
			{ toolPermissionLevel: 'auto', toolPermissions: { update_app_config: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('danger - write ask - 不弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn();
		await resolveToolPermission(
			writeCall,
			{ toolPermissionLevel: 'danger', toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('safe - write ask - 弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('allow' as const);
		await resolveToolPermission(
			writeCall,
			{ toolPermissionLevel: 'safe', toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('兼容 - 仅 trustMode true 无 level - 等同 danger', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn();
		await resolveToolPermission(
			writeCall,
			{ trustMode: true, toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe('resolveToolPermission', () => {
	it('deny - 抛错', async () => {
		const grants = new ToolPermissionSessionGrants();
		await expect(
			resolveToolPermission(
				writeCall,
				{ trustMode: false, toolPermissions: { write_note: 'deny' } },
				grants,
				vi.fn(),
			),
		).rejects.toThrow('已被禁用');
	});

	it('ask - 用户拒绝', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('deny' as const);
		await expect(
			resolveToolPermission(
				writeCall,
				{ trustMode: false, toolPermissions: { write_note: 'ask' } },
				grants,
				confirm,
			),
		).rejects.toThrow('用户拒绝');
	});

	it('ask - 会话放行后不再弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('session' as const);
		await resolveToolPermission(
			writeCall,
			{ trustMode: false, toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		await resolveToolPermission(
			writeCall,
			{ trustMode: false, toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('ask - 会话放行后换 path 也不再弹窗', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('session' as const);
		await resolveToolPermission(
			writeCall,
			{ trustMode: false, toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		const otherPath: ToolCall = {
			id: '2',
			name: 'write_note',
			args: { path: 'b.md', content: 'y' },
		};
		await resolveToolPermission(
			otherPath,
			{ trustMode: false, toolPermissions: { write_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it('ask - 会话放行只覆盖该工具名', async () => {
		const grants = new ToolPermissionSessionGrants();
		const confirm = vi.fn().mockResolvedValue('session' as const);
		await resolveToolPermission(
			writeCall,
			{ trustMode: false, toolPermissions: { write_note: 'ask', edit_note: 'ask' } },
			grants,
			confirm,
		);
		const editCall: ToolCall = {
			id: '3',
			name: 'edit_note',
			args: { path: 'a.md', old_string: 'x', new_string: 'y' },
		};
		confirm.mockResolvedValueOnce('allow' as const);
		await resolveToolPermission(
			editCall,
			{ trustMode: false, toolPermissions: { write_note: 'ask', edit_note: 'ask' } },
			grants,
			confirm,
		);
		expect(confirm).toHaveBeenCalledTimes(2);
	});
});
