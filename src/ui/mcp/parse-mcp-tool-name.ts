/**
 * @file src/ui/mcp/parse-mcp-tool-name.ts
 * @description 解析 ToolRegistry 中的 MCP 工具名
 * @module ui/mcp/parse-mcp-tool-name
 */

/**
 * 是否为 MCP 注册名（`mcp__` 前缀）。
 *
 * @param name - 工具名
 */
export function isMcpToolName(name: string): boolean {
	return name.startsWith('mcp__');
}

/**
 * 解析 `mcp__<serverId>__<toolName>`（toolName 可含 `_`）。
 *
 * @param name - Registry 工具名
 * @returns serverId + toolName；非 MCP 返回 null
 */
export function parseMcpToolName(
	name: string,
): { serverId: string; toolName: string } | null {
	if (!isMcpToolName(name)) return null;
	const rest = name.slice('mcp__'.length);
	const i = rest.indexOf('__');
	if (i <= 0) return null;
	const serverId = rest.slice(0, i);
	const toolName = rest.slice(i + 2);
	if (!serverId || !toolName) return null;
	return { serverId, toolName };
}
