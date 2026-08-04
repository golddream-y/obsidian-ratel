/**
 * @file tests/core/mcp-host.test.ts
 * @description McpHost 差分 sync、入册出册、dispose
 * @module tests/core/mcp-host
 */

import { describe, it, expect, vi } from 'vitest';
import { McpHost } from '../../src/core/mcp-host';
import { ToolRegistry } from '../../src/core/tool-registry';
import type { McpServerConfig, McpTransport } from '../../src/ports/mcp';
import { MCP_PROTOCOL_VERSION } from '../../src/ports/mcp';

function makeTransportFactory(tools: Array<{ name: string; description?: string }>) {
	return (_cfg: McpServerConfig): McpTransport => {
		return {
			start: vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			request: vi.fn(async (method: string) => {
				if (method === 'initialize') {
					return {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: 'f', version: '0' },
					};
				}
				if (method === 'notifications/initialized') return {};
				if (method === 'tools/list') {
					return {
						tools: tools.map((t) => ({
							name: t.name,
							description: t.description ?? '',
							inputSchema: { type: 'object', properties: {} },
						})),
					};
				}
				if (method === 'tools/call') return { content: [{ type: 'text', text: 'ok' }] };
				throw new Error(method);
			}),
		};
	};
}

describe('McpHost', () => {
	it('sync - enabled http server - 注册 mcp__ 工具', async () => {
		const registry = new ToolRegistry();
		const host = new McpHost({
			tools: registry,
			createTransport: makeTransportFactory([{ name: 'search', description: 'd' }]),
			confirmSpawn: async () => true,
			getApiKey: () => null,
			getEnvValue: () => '',
		});
		const cfg: McpServerConfig = {
			id: 'tavily',
			label: 'Tavily',
			enabled: true,
			transport: 'http',
			url: 'https://example/mcp',
		};
		await host.sync([cfg]);
		expect(host.getStatus('tavily')).toBe('online');
		expect(registry.definitions().map((d) => d.name)).toEqual(['mcp__tavily__search']);
	});

	it('sync - disable 后 - 出册并 offline', async () => {
		const registry = new ToolRegistry();
		const host = new McpHost({
			tools: registry,
			createTransport: makeTransportFactory([{ name: 'search' }]),
			confirmSpawn: async () => true,
			getApiKey: () => null,
			getEnvValue: () => '',
		});
		const base: McpServerConfig = {
			id: 'tavily',
			label: 'Tavily',
			enabled: true,
			transport: 'http',
			url: 'https://example/mcp',
		};
		await host.sync([base]);
		await host.sync([{ ...base, enabled: false }]);
		expect(host.getStatus('tavily')).toBe('offline');
		expect(registry.definitions()).toEqual([]);
	});

	it('dispose - 清空全部', async () => {
		const registry = new ToolRegistry();
		const host = new McpHost({
			tools: registry,
			createTransport: makeTransportFactory([{ name: 'search' }]),
			confirmSpawn: async () => true,
			getApiKey: () => null,
			getEnvValue: () => '',
		});
		await host.sync([
			{
				id: 'tavily',
				label: 'Tavily',
				enabled: true,
				transport: 'http',
				url: 'https://example/mcp',
			},
		]);
		await host.dispose();
		expect(registry.definitions()).toEqual([]);
	});

	it('sync - stdio confirmSpawn 拒绝 - 保持 offline 且不注册', async () => {
		const registry = new ToolRegistry();
		const host = new McpHost({
			tools: registry,
			createTransport: makeTransportFactory([{ name: 'search' }]),
			confirmSpawn: async () => false,
			getApiKey: () => null,
			getEnvValue: () => '',
		});
		await host.sync([
			{
				id: 'local',
				label: 'Local',
				enabled: true,
				transport: 'stdio',
				command: 'npx',
				args: ['-y', 'fake-mcp'],
			},
		]);
		expect(host.getStatus('local')).toBe('offline');
		expect(registry.definitions()).toEqual([]);
	});
});
