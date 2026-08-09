/**
 * @file src/core/tool-permissions.ts
 * @description 工具权限 allow/ask/deny 决策
 * @module core/tool-permissions
 */

import type { ToolCall } from '../ports/llm';
import { tNow } from '../i18n';
import { parseMcpToolName } from '../ui/mcp/parse-mcp-tool-name';

export type ToolPermission = 'allow' | 'ask' | 'deny';

export interface ToolPermissionSettings {
	trustMode: boolean;
	toolPermissions: Record<string, ToolPermission>;
}

export type ToolConfirmResult = 'allow' | 'session' | 'deny';

/**
 * 本会话工具授权缓存。
 *
 * 设计要点:
 * - 「允许(本次会话不再询问)」按**工具名**放行整场会话（不绑 path）
 * - 旧实现按 tool+path 记授权，多篇笔记会反复弹窗，与按钮文案不符
 * - `/new` 或切换会话时 clear()；不持久化到 settings
 */
export class ToolPermissionSessionGrants {
	private tools = new Set<string>();

	/**
	 * 是否已对本工具会话放行。
	 *
	 * @param toolName - 工具名（含 mcp__…）
	 * @param _path - 保留参数仅为调用方兼容；会话授权不区分路径
	 */
	has(toolName: string, _path?: string): boolean {
		void _path;
		return this.tools.has(toolName);
	}

	/**
	 * 记录本会话对该工具的放行。
	 *
	 * @param toolName - 工具名
	 * @param _path - 保留参数仅为调用方兼容；忽略
	 */
	grant(toolName: string, _path?: string): void {
		void _path;
		this.tools.add(toolName);
	}

	/** 清空本会话授权 — /new 或切换会话时调用 */
	clear(): void {
		this.tools.clear();
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
		default: {
			const parsed = parseMcpToolName(toolCall.name);
			if (parsed) {
				return tNow('tool.name.mcp', {
					server: parsed.serverId,
					tool: parsed.toolName,
				});
			}
			return path ? `${toolCall.name} → ${path}` : toolCall.name;
		}
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
