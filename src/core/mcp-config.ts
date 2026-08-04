/**
 * @file src/core/mcp-config.ts
 * @description MCP Server 配置校验
 * @module core/mcp-config
 * @depends ../ports/mcp
 */

import type { McpServerConfig } from '../ports/mcp';
import { isValidMcpServerId } from '../ports/mcp';

export type McpConfigErrorCode =
	| 'invalid_id'
	| 'missing_url'
	| 'missing_command'
	| 'duplicate_id';

/**
 * 校验单条 MCP Server 配置。
 *
 * @param cfg - 待校验配置
 * @returns 错误码；合法返回 null
 */
export function validateMcpServerConfig(cfg: McpServerConfig): McpConfigErrorCode | null {
	if (!isValidMcpServerId(cfg.id)) return 'invalid_id';
	if (cfg.transport === 'http' && !cfg.url?.trim()) return 'missing_url';
	if (cfg.transport === 'stdio' && !cfg.command?.trim()) return 'missing_command';
	return null;
}
