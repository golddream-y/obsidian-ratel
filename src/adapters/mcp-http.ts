/**
 * @file src/adapters/mcp-http.ts
 * @description MCP Streamable HTTP Transport（Obsidian requestUrl）
 * @module adapters/mcp-http
 * @depends obsidian(requestUrl), ./mcp-jsonrpc, ./mcp-sse
 */

import { requestUrl } from 'obsidian';
import type { McpTransport } from '../ports/mcp';
import { MCP_DEFAULT_TIMEOUT_MS } from '../ports/mcp';
import { createJsonRpcRequest, parseJsonRpcResponse } from './mcp-jsonrpc';
import { extractJsonRpcFromSse } from './mcp-sse';

export interface McpHttpTransportOptions {
	url: string;
	getApiKey: () => string | null;
	timeoutMs?: number;
}

/**
 * 通过 requestUrl 发送 JSON-RPC；支持 JSON 与 SSE 响应，记住 mcp-session-id。
 *
 * 关键路径:禁止裸 fetch，复用 ADR-001 CORS 策略。
 */
export class McpHttpTransport implements McpTransport {
	private readonly url: string;
	private readonly getApiKey: () => string | null;
	/** 预留：requestUrl 无原生超时，后续可用 Promise.race 包装 */
	private readonly _timeoutMs: number;
	private nextId = 1;
	private sessionId: string | null = null;
	private started = false;

	constructor(opts: McpHttpTransportOptions) {
		this.url = opts.url;
		this.getApiKey = opts.getApiKey;
		this._timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
	}

	async start(): Promise<void> {
		this.started = true;
	}

	/**
	 * 发送 JSON-RPC 请求并返回 result。
	 *
	 * @param method - MCP 方法
	 * @param params - 参数
	 * @returns parseJsonRpcResponse 的 result
	 */
	async request(method: string, params?: unknown): Promise<unknown> {
		if (!this.started) throw new Error('MCP HTTP Transport 未 start');
		const id = this.nextId++;
		const body = createJsonRpcRequest(id, method, params);
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		};
		const key = this.getApiKey();
		if (key) headers.Authorization = `Bearer ${key}`;
		if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

		const response = await requestUrl({
			url: this.url,
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			throw: false,
		});

		const session = headerGet(response.headers, 'mcp-session-id');
		if (session) this.sessionId = session;

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`MCP HTTP 失败: HTTP ${response.status}`);
		}

		const contentType = headerGet(response.headers, 'content-type') ?? '';
		const text = typeof response.text === 'string' ? response.text : '';
		let raw: unknown;
		if (
			contentType.includes('event-stream') ||
			text.trimStart().startsWith('data:') ||
			text.trimStart().startsWith('event:')
		) {
			raw = extractJsonRpcFromSse(text);
		} else if (response.json !== undefined && response.json !== null) {
			raw = response.json;
		} else {
			raw = text ? (JSON.parse(text) as unknown) : null;
		}
		return parseJsonRpcResponse(raw);
	}

	async close(): Promise<void> {
		this.started = false;
		this.sessionId = null;
	}
}

/**
 * 大小写不敏感读取响应头。
 */
function headerGet(
	headers: Record<string, string> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}
