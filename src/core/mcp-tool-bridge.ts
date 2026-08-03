/**
 * @file src/core/mcp-tool-bridge.ts
 * @description 将 MCP tools/list 条目转为 ToolRegistry 可注册的 Tool
 * @module core/mcp-tool-bridge
 * @depends ../ports/mcp, ./tool-registry
 */

import type { Tool } from './tool-registry';
import type { McpClientPort, McpToolInfo } from '../ports/mcp';
import { mcpToolPrefix } from '../ports/mcp';

/**
 * 净化 MCP 工具名中的非法字符为下划线。
 *
 * @param name - 原始工具名
 * @returns 可嵌入注册名的片段
 */
export function sanitizeMcpToolName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * 拼出 Registry 工具名：`mcp__<serverId>__<tool>`。
 *
 * @param serverId - Server id
 * @param toolName - MCP 原工具名
 * @returns 注册名
 */
export function buildMcpRegistryName(serverId: string, toolName: string): string {
	return `${mcpToolPrefix(serverId)}${sanitizeMcpToolName(toolName)}`;
}

/**
 * 构造可注册 Tool；execute 闭包捕获 client 与 MCP 原名。
 *
 * 关键路径:readOnly 一期固定 false（保守走权限 ask / 写钩子）。
 *
 * @param client - 已连接的 MCP Client
 * @param serverId - Server id
 * @param serverLabel - 展示名（写入 description 前缀）
 * @param info - tools/list 条目
 * @returns ToolRegistry 可 register 的 Tool
 */
export function createMcpTool(
	client: McpClientPort,
	serverId: string,
	serverLabel: string,
	info: McpToolInfo,
): Tool {
	const registryName = buildMcpRegistryName(serverId, info.name);
	const description = info.description?.trim()
		? `[MCP:${serverLabel}] ${info.description.trim()}`
		: `[MCP:${serverLabel}] ${info.name}`;

	return {
		definition: {
			name: registryName,
			description,
			parameters: info.inputSchema ?? { type: 'object', properties: {} },
		},
		readOnly: false,
		async execute(args: Record<string, unknown>): Promise<unknown> {
			const result = await client.callTool(info.name, args);
			return result.content;
		},
	};
}
