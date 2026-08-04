/**
 * @file src/adapters/mcp-jsonrpc.ts
 * @description MCP JSON-RPC 2.0 请求构造与响应解析
 * @module adapters/mcp-jsonrpc
 */

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number | string;
	method: string;
	params?: unknown;
}

/**
 * JSON-RPC 错误 —— 带 code / data，便于 Transport 与 Client 区分协议失败。
 */
export class McpJsonRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = 'McpJsonRpcError';
		this.code = code;
		this.data = data;
	}
}

/**
 * 构造 JSON-RPC 请求对象。
 *
 * @param id - 请求 id（与响应关联）
 * @param method - MCP 方法名
 * @param params - 可选参数
 * @returns 可序列化的请求体
 */
export function createJsonRpcRequest(
	id: number | string,
	method: string,
	params?: unknown,
): JsonRpcRequest {
	const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
	if (params !== undefined) req.params = params;
	return req;
}

/**
 * 解析 JSON-RPC 响应对象；成功返回 result，错误抛 McpJsonRpcError。
 *
 * @param raw - 已解析的 JSON 值
 * @returns result 字段
 * @throws McpJsonRpcError 或形状非法时的 Error
 */
export function parseJsonRpcResponse(raw: unknown): unknown {
	if (!raw || typeof raw !== 'object') {
		throw new Error('MCP JSON-RPC 响应无效');
	}
	const obj = raw as Record<string, unknown>;
	if (obj.error && typeof obj.error === 'object') {
		const err = obj.error as { code?: number; message?: string; data?: unknown };
		throw new McpJsonRpcError(
			typeof err.code === 'number' ? err.code : -32000,
			err.message ?? 'MCP 错误',
			err.data,
		);
	}
	if (!('result' in obj)) {
		throw new Error('MCP JSON-RPC 响应缺少 result');
	}
	return obj.result;
}
