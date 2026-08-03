/**
 * @file tests/adapters/mcp-sse.test.ts
 * @description SSE 文本中提取 JSON-RPC 响应
 * @module tests/adapters/mcp-sse
 */

import { describe, it, expect } from 'vitest';
import { extractJsonRpcFromSse } from '../../src/adapters/mcp-sse';

describe('mcp-sse', () => {
	it('extractJsonRpcFromSse - 单 data 行 - 解析 JSON', () => {
		const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
		expect(extractJsonRpcFromSse(body)).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: { tools: [] },
		});
	});

	it('extractJsonRpcFromSse - 多 data 拼行 - 合并解析', () => {
		const body =
			'data: {"jsonrpc":"2.0","id":2,\n' +
			'data: "result":{"ok":true}}\n\n';
		expect(extractJsonRpcFromSse(body)).toEqual({
			jsonrpc: '2.0',
			id: 2,
			result: { ok: true },
		});
	});

	it('extractJsonRpcFromSse - 无 data - 抛错', () => {
		expect(() => extractJsonRpcFromSse('event: ping\n\n')).toThrow(/SSE/);
	});
});
