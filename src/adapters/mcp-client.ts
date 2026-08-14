/**
 * @file src/adapters/mcp-client.ts
 * @description 通用 MCP Client：initialize / tools/list / tools/call
 * @module adapters/mcp-client
 * @depends ../ports/mcp
 */

import type {
	McpCallResult,
	McpClientPort,
	McpToolInfo,
	McpTransport,
} from '../ports/mcp';
import { MCP_PROTOCOL_VERSION } from '../ports/mcp';

/** 与 manifest.json version 对齐的客户端版本声明（发版可不强求同步） */
const MCP_CLIENT_VERSION = '0.1.15';

/**
 * 将 tools/call 原始结果归一为文本 content。
 */
function normalizeCallContent(raw: unknown): McpCallResult {
	if (raw == null) {
		return { content: '', isError: true };
	}
	if (typeof raw !== 'object') {
		return { content: typeof raw === 'string' ? raw : JSON.stringify(raw), isError: true };
	}
	const obj = raw as {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	const texts = (obj.content ?? [])
		.filter((c) => c && (c.type === 'text' || c.text))
		.map((c) => c.text ?? '')
		.filter(Boolean);
	const content = texts.length > 0 ? texts.join('\n') : JSON.stringify(raw);
	return { content, isError: !!obj.isError };
}

/**
 * 单 Server MCP 客户端。
 *
 * 设计要点:
 * - Transport 可替换（HTTP / stdio / 测试假实现）
 * - initialize 要求 Server 声明 tools capability，否则拒绝入册
 * - notifications/initialized 失败不阻断（部分实现无此方法）
 */
export class McpClient implements McpClientPort {
	readonly serverId: string;
	private readonly transport: McpTransport;
	private initialized = false;

	constructor(serverId: string, transport: McpTransport) {
		this.serverId = serverId;
		this.transport = transport;
	}

	/**
	 * 启动 Transport 并完成协议握手。
	 *
	 * @throws Server 不支持 tools 时抛错
	 */
	async initialize(): Promise<void> {
		await this.transport.start();
		const result = (await this.transport.request('initialize', {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: 'ratel-vault', version: MCP_CLIENT_VERSION },
		})) as {
			capabilities?: { tools?: unknown };
		};
		if (!result?.capabilities || !('tools' in result.capabilities)) {
			throw new Error(`MCP Server ${this.serverId} 不支持 tools`);
		}
		try {
			await this.transport.request('notifications/initialized', {});
		} catch {
			// 通知失败不阻断
		}
		this.initialized = true;
	}

	/**
	 * 发现工具列表。
	 *
	 * @returns 归一化的 McpToolInfo 数组
	 */
	async listTools(): Promise<McpToolInfo[]> {
		this.assertReady();
		const result = (await this.transport.request('tools/list', {})) as {
			tools?: Array<{
				name: string;
				description?: string;
				inputSchema?: Record<string, unknown>;
			}>;
		};
		return (result.tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
		}));
	}

	/**
	 * 调用远程工具。
	 *
	 * @param name - MCP 原工具名（非 Registry 前缀名）
	 * @param args - 参数对象
	 * @returns 归一化文本结果
	 */
	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
		this.assertReady();
		const raw = await this.transport.request('tools/call', {
			name,
			arguments: args,
		});
		return normalizeCallContent(raw);
	}

	/**
	 * 关闭 Transport 并标记未初始化。
	 */
	async close(): Promise<void> {
		this.initialized = false;
		await this.transport.close();
	}

	private assertReady(): void {
		if (!this.initialized) throw new Error(`MCP Client ${this.serverId} 未初始化`);
	}
}
