/**
 * @file src/core/tool-permissions.ts
 * @description 工具权限 allow/ask/deny 决策
 * @module core/tool-permissions
 */

import type { ToolCall } from '../ports/llm';
import { tNow } from '../i18n';

export type ToolPermission = 'allow' | 'ask' | 'deny';

export interface ToolPermissionSettings {
	trustMode: boolean;
	toolPermissions: Record<string, ToolPermission>;
}

export type ToolConfirmResult = 'allow' | 'session' | 'deny';

export class ToolPermissionSessionGrants {
	private keys = new Set<string>();

	private key(toolName: string, path?: string): string {
		return path ? `${toolName}:${path}` : toolName;
	}

	has(toolName: string, path?: string): boolean {
		return this.keys.has(this.key(toolName, path));
	}

	grant(toolName: string, path?: string): void {
		this.keys.add(this.key(toolName, path));
	}

	/** 清空本会话授权 — /new 或切换会话时调用 */
	clear(): void {
		this.keys.clear();
	}
}

export function extractToolPath(toolCall: ToolCall): string | undefined {
	const p = toolCall.args.path;
	return typeof p === 'string' ? p : undefined;
}

export function summarizeToolCall(toolCall: ToolCall): string {
	const path = extractToolPath(toolCall);
	switch (toolCall.name) {
		case 'write_note':
			// 关键路径:path 存在时显示具体路径,否则显示通用动作名(用于 Notice / Modal 标题)
			return path ? tNow('toolPerm.writeNote', { path }) : tNow('settings.toolPermissions.write_note');
		case 'append_note':
			return path ? tNow('toolPerm.appendNote', { path }) : tNow('settings.toolPermissions.append_note');
		case 'edit_note':
			return path ? tNow('toolPerm.editNote', { path }) : tNow('settings.toolPermissions.edit_note');
		case 'delete_note':
			return path ? tNow('toolPerm.deleteNote', { path }) : tNow('settings.toolPermissions.delete_note');
		default:
			return path ? `${toolCall.name} → ${path}` : toolCall.name;
	}
}

export async function resolveToolPermission(
	toolCall: ToolCall,
	settings: ToolPermissionSettings,
	grants: ToolPermissionSessionGrants,
	confirm: (toolCall: ToolCall) => Promise<ToolConfirmResult>,
): Promise<void> {
	if (settings.trustMode) return;

	const path = extractToolPath(toolCall);
	if (grants.has(toolCall.name, path)) return;

	const perm: ToolPermission = settings.toolPermissions[toolCall.name] ?? 'ask';
	if (perm === 'allow') return;
	if (perm === 'deny') {
		throw new Error(tNow('error.tool.rejectedDisabled', { toolName: toolCall.name }));
	}

	const decision = await confirm(toolCall);
	if (decision === 'deny') {
		throw new Error(tNow('error.tool.rejected'));
	}
	if (decision === 'session') {
		grants.grant(toolCall.name, path);
	}
}
