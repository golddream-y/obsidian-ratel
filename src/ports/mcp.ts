/**
 * @file src/ports/mcp.ts
 * @description MCP Host/Client/Transport 零实现契约与配置类型
 * @module ports/mcp
 */

/** 客户端声明的 MCP 协议版本（广泛兼容） */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** 默认初始化 / 单次 call 超时 */
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;

/** 连续 call 失败多少次后熔断下线 */
export const MCP_CIRCUIT_FAILURE_THRESHOLD = 3;

/**
 * settings.json 中的 MCP Server 条目（无密钥明文）。
 */
export interface McpServerConfig {
	/** 稳定 ID：小写字母数字与连字符；用于命名前缀与钥匙串 */
	id: string;
	/** 展示名（设置页 / 确认 Modal） */
	label: string;
	enabled: boolean;
	transport: 'http' | 'stdio';
	/** http：端点 URL（Streamable HTTP） */
	url?: string;
	/** stdio：可执行文件（如 npx、node、绝对路径） */
	command?: string;
	/** stdio：参数列表（禁止拼进 shell 字符串） */
	args?: string[];
	/** 额外注入的环境变量名；值运行时解析，禁止写入 settings */
	envKeys?: string[];
	/** 初始化 / 单次 call 超时（ms）；缺省常量 */
	timeoutMs?: number;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
	/** 归一化为可喂回 LLM 的文本或结构化 JSON 字符串 */
	content: string;
	isError?: boolean;
}

/**
 * 可替换传输层：HTTP 或 stdio。
 */
export interface McpTransport {
	start(): Promise<void>;
	request(method: string, params?: unknown): Promise<unknown>;
	close(): Promise<void>;
}

/**
 * 单 Server 客户端：握手、发现、调用、关闭。
 */
export interface McpClientPort {
	readonly serverId: string;
	initialize(): Promise<void>;
	listTools(): Promise<McpToolInfo[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
	close(): Promise<void>;
}

export type McpServerStatus = 'offline' | 'connecting' | 'online' | 'error';

/**
 * 多 Server 编排入口。
 */
export interface McpHostPort {
	/** 按 settings 同步：启停/重连；幂等 */
	sync(servers: McpServerConfig[]): Promise<void>;
	getStatus(serverId: string): McpServerStatus;
	/** 最近一次启动失败原因（无则 null） */
	getLastError(serverId: string): string | null;
	/** 停止单个 Server（设置页 / 管理 Modal「停止」） */
	stop(serverId: string): Promise<void>;
	/**
	 * 强制重连并重新 listTools。
	 *
	 * 用于网络闪断、熔断后恢复，或工具列表可能已变更时手动刷新。
	 * 会先 teardown 再 bringUp；配置须 enabled。
	 */
	reconnect(cfg: McpServerConfig): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * 校验 Server id：小写字母开头，字母数字连字符，最长 32。
 *
 * @param id - 候选 id
 * @returns 是否合法
 */
export function isValidMcpServerId(id: string): boolean {
	return /^[a-z][a-z0-9-]{0,31}$/.test(id);
}

/**
 * 工具名前缀：`mcp__<serverId>__`
 *
 * @param serverId - Server id
 * @returns 注册名前缀
 */
export function mcpToolPrefix(serverId: string): string {
	return `mcp__${serverId}__`;
}
