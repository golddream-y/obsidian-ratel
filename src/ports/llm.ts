/**
 * @file src/ports/llm.ts
 * @description LLM 端口 — LLM 客户端的零实现接口契约(只描述形状,不写实现)。
 * @module ports/llm
 * @depends (无)
 */

/**
 * LLM 客户端统一接口。
 *
 * 实现位置:`src/adapters/llm-deepseek.ts`、`src/adapters/llm-anthropic.ts` 等。
 */
export interface LLMClient {
	/**
	 * 发起一次对话请求,返回 ChatDelta 流(可异步迭代)。
	 * @param req - 聊天请求。
	 */
	chat(req: ChatRequest): AsyncIterable<ChatDelta>;
	/**
	 * 计算给定文本的 token 数(用于上下文截断判断)。
	 * @param text - 待计算文本。
	 */
	countTokens(text: string): number;
}

/**
 * 聊天请求:消息历史 + (可选)工具定义。
 */
export interface ChatRequest {
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	maxSteps?: number;
}

/**
 * 聊天消息:支持 system/user/assistant/tool 四种角色。
 * - `toolCallId` + `toolName` + `toolArgs` 只在 assistant 工具调用消息上设置。
 * - `toolCallId` 在 tool 角色消息上设置,用于与 assistant 工具调用配对。
 */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCallId?: string;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
}

/**
 * 流式增量:assistant 文本片段 + (可选)最终的工具调用。
 * `toolCall` 字段在流末才确定(完整 name+args),期间可能为 undefined。
 */
export interface ChatDelta {
	text: string;
	toolCall?: ToolCall;
}

/**
 * 工具调用:由 LLM 决策产生,交给 ToolRegistry 执行。
 */
export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

/**
 * 工具定义(LLM 侧 schema):名称、描述、参数 JSON Schema。
 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}
