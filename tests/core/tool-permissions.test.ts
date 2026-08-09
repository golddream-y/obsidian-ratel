import { describe, it, expect, vi } from 'vitest';
import {
	ToolPermissionSessionGrants,
	resolveToolPermission,
} from '../../src/core/tool-permissions';
import type { ToolCall } from '../../src/ports/llm';

const writeCall: ToolCall = { id: '1', name: 'write_note', args: { path: 'a.md', content: 'x' } };

describe('resolveToolPermission', () => {
	it('trustMode - 直接放行', async () => {
		const grants = new ToolPermissionSessionGrants();
		await expect(
			resolveToolPermission(writeCall, { trustMode: true, toolPermissions: { write_note: 'deny' } }, grants, vi.fn()),
		).resolves.toBeUndefined();
	});

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
