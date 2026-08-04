/**
 * @file tests/adapters/mcp-http.test.ts
 * @description MCP HTTP Transport（mock requestUrl）
 * @module tests/adapters/mcp-http
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestUrl = vi.fn();
vi.mock('obsidian', () => ({ requestUrl: (...args: unknown[]) => requestUrl(...args) }));

import { McpHttpTransport } from '../../src/adapters/mcp-http';

describe('McpHttpTransport', () => {
	beforeEach(() => {
		requestUrl.mockReset();
	});

	it('request - JSON 响应 - 返回 result', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: {},
			text: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
			json: { jsonrpc: '2.0', id: 1, result: { ok: true } },
		});
		const t = new McpHttpTransport({
			url: 'https://mcp.example/mcp',
			getApiKey: () => 'secret',
		});
		await t.start();
		await expect(t.request('initialize', { protocolVersion: '2024-11-05' })).resolves.toEqual({
			ok: true,
		});
		expect(requestUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				url: 'https://mcp.example/mcp',
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer secret',
					'Content-Type': 'application/json',
				}),
			}),
		);
	});

	it('request - 记住 mcp-session-id', async () => {
		requestUrl
			.mockResolvedValueOnce({
				status: 200,
				headers: { 'mcp-session-id': 'sess-1' },
				json: { jsonrpc: '2.0', id: 1, result: {} },
				text: '{}',
			})
			.mockResolvedValueOnce({
				status: 200,
				headers: {},
				json: { jsonrpc: '2.0', id: 2, result: { tools: [] } },
				text: '{}',
			});
		const t = new McpHttpTransport({ url: 'https://mcp.example/mcp', getApiKey: () => null });
		await t.start();
		await t.request('initialize', {});
		await t.request('tools/list', {});
		expect(requestUrl.mock.calls.length).toBeGreaterThanOrEqual(2);
		const secondCall = requestUrl.mock.calls[1];
		expect(secondCall).toBeDefined();
		const second = secondCall![0] as { headers: Record<string, string> };
		expect(second.headers['mcp-session-id']).toBe('sess-1');
	});

	it('request - SSE 文本 - 走 extractJsonRpcFromSse', async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
			text: 'data: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n',
			json: undefined,
		});
		const t = new McpHttpTransport({ url: 'https://mcp.example/mcp', getApiKey: () => null });
		await t.start();
		await expect(t.request('initialize', {})).resolves.toEqual({ x: 1 });
	});
});
