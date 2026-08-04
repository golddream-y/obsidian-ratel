/**
 * @file tests/adapters/mcp-client.test.ts
 * @description McpClient 握手 / list / call（注入假 Transport）
 * @module tests/adapters/mcp-client
 */

import { describe, it, expect, vi } from 'vitest';
import { McpClient } from '../../src/adapters/mcp-client';
import type { McpTransport } from '../../src/ports/mcp';
import { MCP_PROTOCOL_VERSION } from '../../src/ports/mcp';

function fakeTransport(handler: (method: string, params?: unknown) => unknown): McpTransport {
	return {
		start: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		request: vi.fn(async (method: string, params?: unknown) => handler(method, params)),
	};
}

describe('McpClient', () => {
	it('initialize - 发送 protocolVersion 与 clientInfo', async () => {
		const transport = fakeTransport((method) => {
			if (method === 'initialize') {
				return {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: 'fake', version: '0' },
				};
			}
			if (method === 'notifications/initialized') return {};
			throw new Error(`unexpected ${method}`);
		});
		const client = new McpClient('tavily', transport);
		await client.initialize();
		expect(transport.start).toHaveBeenCalled();
		expect(transport.request).toHaveBeenCalledWith(
			'initialize',
			expect.objectContaining({
				protocolVersion: MCP_PROTOCOL_VERSION,
				clientInfo: expect.objectContaining({ name: 'ratel-vault' }),
			}),
		);
	});

	it('listTools - 映射 name/description/inputSchema', async () => {
		const transport = fakeTransport((method) => {
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
					tools: [
						{
							name: 'search',
							description: 'd',
							inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
						},
					],
				};
			}
			throw new Error(method);
		});
		const client = new McpClient('tavily', transport);
		await client.initialize();
		const tools = await client.listTools();
		expect(tools).toEqual([
			{
				name: 'search',
				description: 'd',
				inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
			},
		]);
	});

	it('callTool - 归一化 content 文本', async () => {
		const transport = fakeTransport((method) => {
			if (method === 'initialize') {
				return {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: 'f', version: '0' },
				};
			}
			if (method === 'notifications/initialized') return {};
			if (method === 'tools/call') {
				return {
					content: [{ type: 'text', text: 'hello' }],
					isError: false,
				};
			}
			throw new Error(method);
		});
		const client = new McpClient('tavily', transport);
		await client.initialize();
		await expect(client.callTool('search', { q: 'x' })).resolves.toEqual({
			content: 'hello',
			isError: false,
		});
	});

	it('initialize - Server 无 tools capability - 抛错', async () => {
		const transport = fakeTransport(() => ({
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			serverInfo: { name: 'f', version: '0' },
		}));
		const client = new McpClient('x', transport);
		await expect(client.initialize()).rejects.toThrow(/tools/);
	});
});
