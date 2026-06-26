/**
 * @file src/core/tool-permissions.ts
 * @description 工具权限 allow/ask/deny 决策
 * @module core/tool-permissions
 */

import type { ToolCall } from '../ports/llm';

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
}

export function extractToolPath(toolCall: ToolCall): string | undefined {
	const p = toolCall.args.path;
	return typeof p === 'string' ? p : undefined;
}

export function summarizeToolCall(toolCall: ToolCall): string {
	const path = extractToolPath(toolCall);
	switch (toolCall.name) {
		case 'write_note':
			return path ? `创建或覆盖笔记 ${path}` : '写入笔记';
		case 'append_note':
			return path ? `追加内容到 ${path}` : '追加笔记';
		case 'edit_note':
			return path ? `精确替换 ${path} 中的文本` : '编辑笔记';
		case 'delete_note':
			return path ? `将 ${path} 移到回收站` : '删除笔记';
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
		throw new Error(`工具调用被拒绝: ${toolCall.name} 已被禁用`);
	}

	const decision = await confirm(toolCall);
	if (decision === 'deny') {
		throw new Error('用户拒绝了工具调用');
	}
	if (decision === 'session') {
		grants.grant(toolCall.name, path);
	}
}
