/**
 * @file tests/core/mcp-config-validate.test.ts
 * @description MCP Server 配置校验
 * @module tests/core/mcp-config-validate
 */

import { describe, it, expect } from 'vitest';
import { validateMcpServerConfig } from '../../src/core/mcp-config';

describe('validateMcpServerConfig', () => {
	it('合法 http - 返回 null', () => {
		expect(
			validateMcpServerConfig({
				id: 'tavily',
				label: 'Tavily',
				enabled: true,
				transport: 'http',
				url: 'https://mcp.tavily.com/mcp',
			}),
		).toBeNull();
	});

	it('非法 id - 返回错误码', () => {
		expect(
			validateMcpServerConfig({
				id: 'Tavily',
				label: 'Tavily',
				enabled: true,
				transport: 'http',
				url: 'https://x',
			}),
		).toBe('invalid_id');
	});

	it('http 缺 url - 返回错误码', () => {
		expect(
			validateMcpServerConfig({
				id: 'tavily',
				label: 'Tavily',
				enabled: true,
				transport: 'http',
			}),
		).toBe('missing_url');
	});

	it('stdio 缺 command - 返回错误码', () => {
		expect(
			validateMcpServerConfig({
				id: 'local',
				label: 'Local',
				enabled: true,
				transport: 'stdio',
			}),
		).toBe('missing_command');
	});
});
