/**
 * @file tests/core/mcp-tool-bridge.test.ts
 * @description MCP 工具 → ToolRegistry Tool 桥接
 * @module tests/core/mcp-tool-bridge
 */

import { describe, it, expect, vi } from 'vitest';
import {
	sanitizeMcpToolName,
	buildMcpRegistryName,
	createMcpTool,
} from '../../src/core/mcp-tool-bridge';
import type { McpClientPort } from '../../src/ports/mcp';

describe('mcp-tool-bridge', () => {
	it('sanitizeMcpToolName - 非法字符替换为下划线', () => {
		expect(sanitizeMcpToolName('search.web')).toBe('search_web');
		expect(sanitizeMcpToolName('ok_tool-1')).toBe('ok_tool-1');
	});

	it('buildMcpRegistryName - 拼前缀', () => {
		expect(buildMcpRegistryName('tavily', 'search')).toBe('mcp__tavily__search');
	});

	it('createMcpTool - execute 调 client.callTool 原名', async () => {
		const callTool = vi.fn().mockResolvedValue({ content: 'hit', isError: false });
		const client = { callTool } as unknown as McpClientPort;
		const tool = createMcpTool(client, 'tavily', 'Tavily', {
			name: 'search',
			description: 'web search',
			inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
		});
		expect(tool.definition.name).toBe('mcp__tavily__search');
		expect(tool.definition.description).toContain('web search');
		expect(tool.readOnly).toBe(false);
		const result = await tool.execute({ q: 'ratel' });
		expect(callTool).toHaveBeenCalledWith('search', { q: 'ratel' });
		expect(result).toBe('hit');
	});

	it('createMcpTool - isError 时仍返回文本（Loop 降级读字符串）', async () => {
		const client = {
			callTool: vi.fn().mockResolvedValue({ content: 'boom', isError: true }),
		} as unknown as McpClientPort;
		const tool = createMcpTool(client, 'tavily', 'Tavily', {
			name: 'search',
			description: 'd',
			inputSchema: { type: 'object', properties: {} },
		});
		await expect(tool.execute({})).resolves.toBe('boom');
	});
});
