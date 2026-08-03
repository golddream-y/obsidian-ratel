/**
 * @file tests/adapters/mcp-jsonrpc.test.ts
 * @description MCP JSON-RPC 编解码单元测试
 * @module tests/adapters/mcp-jsonrpc
 */

import { describe, it, expect } from 'vitest';
import {
	createJsonRpcRequest,
	parseJsonRpcResponse,
	McpJsonRpcError,
} from '../../src/adapters/mcp-jsonrpc';

describe('mcp-jsonrpc', () => {
	it('createJsonRpcRequest - 生成带 id 的请求对象', () => {
		const req = createJsonRpcRequest(1, 'tools/list', {});
		expect(req).toEqual({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: {},
		});
	});

	it('parseJsonRpcResponse - 成功 result - 返回 result', () => {
		expect(parseJsonRpcResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toEqual({
			ok: true,
		});
	});

	it('parseJsonRpcResponse - error 字段 - 抛 McpJsonRpcError', () => {
		expect(() =>
			parseJsonRpcResponse({
				jsonrpc: '2.0',
				id: 1,
				error: { code: -32601, message: 'Method not found' },
			}),
		).toThrow(McpJsonRpcError);
	});

	it('parseJsonRpcResponse - 非法形状 - 抛错', () => {
		expect(() => parseJsonRpcResponse(null)).toThrow(/无效/);
	});
});
