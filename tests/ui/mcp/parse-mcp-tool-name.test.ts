/**
 * @file tests/ui/mcp/parse-mcp-tool-name.test.ts
 * @description 解析 mcp__server__tool 注册名
 * @module tests/ui/mcp/parse-mcp-tool-name
 */

import { describe, it, expect } from 'vitest';
import { parseMcpToolName, isMcpToolName } from '../../../src/ui/mcp/parse-mcp-tool-name';

describe('parseMcpToolName', () => {
	it('isMcpToolName - mcp__ 前缀 - true', () => {
		expect(isMcpToolName('mcp__tavily__search')).toBe(true);
		expect(isMcpToolName('search_vault')).toBe(false);
	});

	it('parseMcpToolName - 标准三段 - 拆出 server 与 tool', () => {
		expect(parseMcpToolName('mcp__tavily__search')).toEqual({
			serverId: 'tavily',
			toolName: 'search',
		});
	});

	it('parseMcpToolName - tool 名含下划线 - 只按前两段 __ 切分', () => {
		expect(parseMcpToolName('mcp__tavily__search_web')).toEqual({
			serverId: 'tavily',
			toolName: 'search_web',
		});
	});

	it('parseMcpToolName - 非 MCP - 返回 null', () => {
		expect(parseMcpToolName('read_note')).toBeNull();
	});
});
