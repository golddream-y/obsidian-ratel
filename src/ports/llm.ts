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
	 * 当前端点是否支持图片输入(S-VISION)。
	 * agent-loop 发送前探测:含图 && 不支持 → 直接报错,不静默丢图。
	 */
	supportsImages: boolean;
	/**
	 * 计算给定文本的 token 数(用于上下文截断判断)。
	 * @param text - 待计算文本。
	 */
	countTokens(text: string): number;
}

/**
 * 图片附件引用(S-VISION v1.3)— session 里只存 {id, mimeType};
 * base64 仅在出站解析副本上出现(见 context-manager.toMessagesResolved),持久层永不含。
 * id = 内容 hash(AttachmentStore 文件名);base64 不含 `data:` 前缀。
 */
export interface AttachmentRef {
	id: string;
	mimeType: string;
	base64?: string;
}

/**
 * 生成参数 — LLM 采样参数,测试页可临时覆盖。
 *
 * - `temperature`:0~2,默认 1(0 = 确定性输出,越高越随机)。
 * - `topP`:0~1,默认 1(核采样阈值)。
 * - `maxTokens`:最大生成 token 数,默认由模型侧决定。
 * - `thinking`:DeepSeek V4 思考开关;`disabled` 用于短任务(标题/分类),避免推理 token 吃光 max_tokens 导致 content 为空。
 */
export interface GenerationOptions {
	temperature?: number;
	topP?: number;
	maxTokens?: number;
	thinking?: 'enabled' | 'disabled';
}

/**
 * 聊天请求:消息历史 + (可选)工具定义 + (可选)生成参数。
 */
export interface ChatRequest {
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	maxSteps?: number;
	options?: GenerationOptions;
	/** 取消信号 — 适配器应穿透到 HTTP 层,abort 时销毁请求/socket 立即中断 */
	signal?: AbortSignal;
}

/**
 * 聊天消息:支持 system/user/assistant/tool 四种角色。
 * - `toolCallId` + `toolName` + `toolArgs` 只在 assistant 工具调用消息上设置。
 * - `toolCallId` 在 tool 角色消息上设置,用于与 assistant 工具调用配对。
 * - `reasoning` 为思考过程全文(DeepSeek reasoning_content);thinking 模式下含 tool_calls 的
 *   assistant 消息必须在后续请求中原样回传,否则 API 返回 400。
 */
export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	/** 图片附件引用 — 仅 user 消息;适配器按端点能力构造 vision 格式或拒绝 */
	attachments?: AttachmentRef[];
	/** 思考过程全文 — 适配器映射为 API 的 reasoning_content */
	reasoning?: string;
	toolCallId?: string;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
}

/**
 * 流式增量:assistant 文本片段 + (可选)工具调用 + (可选)结束原因。
 * - `toolCall` 在流中可能出现多次(并行工具调用),agent-loop 应全部收集。
 * - `finishReason` 在流末尾 yield 一次,告知上层为何结束:
 *   - `stop`:模型正常结束(无后续工具调用)
 *   - `length`:达到 max_tokens 上限,输出被截断
 *   - `tool_calls`:模型决定调用工具(后续会有 toolCall 增量)
 *   - `content_filter`:内容过滤截断
 */
export interface ChatDelta {
	text: string;
	/** 思考过程文本(DeepSeek reasoning_content / Claude thinking),与 text 互斥 */
	reasoning?: string;
	toolCall?: ToolCall;
	finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
	/** API 真值 token 统计(流末尾出现一次) */
	usage?: { promptTokens: number; completionTokens: number };
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
