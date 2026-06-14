/**
 * @file src/adapters/llm-deepseek.ts
 * @description DeepSeek 聊天补全适配器(OpenAI 兼容协议,支持流式 SSE 与工具调用)
 * @module adapters/llm-deepseek
 * @depends fetch, ports/llm
 */

import type { LLMClient, ChatRequest, ChatDelta, ToolCall } from '../ports/llm';

/**
 * DeepSeek 客户端配置。
 *
 * - `apiBase`:形如 `https://api.deepseek.com`,不带尾斜杠与路径。
 * - `apiKey`:用户 API Key;若为空字符串则在 header 中省略 Authorization。
 * - `model`:模型名,例如 `deepseek-chat`。
 */
interface DeepSeekConfig {
	apiBase: string;
	apiKey: string;
	model: string;
}

/**
 * OpenAI 协议中 `tool_calls` 数组的流式增量结构。
 * `index` 标识属于同一个工具调用的不同增量片段(并行工具调用场景下尤为重要)。
 */
interface OpenAIToolCallChunk {
	index: number;
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

/**
 * DeepSeek LLM 客户端 — `LLMClient` 端口的具体实现。
 *
 * 设计要点:
 * - 走 OpenAI 兼容协议,适用于 DeepSeek / 任何 OpenAI 风格端点(Ollama 部分模型等)。
 * - 使用 SSE(`text/event-stream`)增量流式返回,以便在 UI 中实现逐字输出。
 * - 工具调用在多 chunk 间累积(`toolCallAccumulators` 按 index 聚合)再统一 yield。
 * - 网络错误、协议错误、JSON 解析错误均降级处理,不让单条坏数据中断整次会话。
 *
 * @example
 *   const llm = new DeepSeekLLM({ apiBase, apiKey, model: 'deepseek-chat' });
 *   for await (const delta of llm.chat(req)) {
 *     if (delta.text) process.stdout.write(delta.text);
 *   }
 */
export class DeepSeekLLM implements LLMClient {
	constructor(private config: DeepSeekConfig) {}

	/**
	 * 向 DeepSeek `/chat/completions` 发起流式请求,逐 chunk yield `ChatDelta`。
	 *
	 * 行为契约:
	 * - 文本增量通过 `{ text }` yield。
	 * - 工具调用在 `[DONE]` 之前累积,流结束后按 index 顺序 yield `{ toolCall }`(text 为空字符串)。
	 * - 若 SSE 出现无法解析的 JSON chunk,静默跳过,不影响后续 chunk。
	 *
	 * @param req - 对话消息 + 可选工具定义。
	 * @returns 异步迭代的 `ChatDelta`。
	 * @throws 当 HTTP 状态非 2xx、响应体为空、或底层网络异常时抛出。
	 */
	async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
		const body = this.buildRequestBody(req);

		const response = await fetch(`${this.config.apiBase}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error('LLM API returned no body');
		}

		// 工具调用增量缓冲:key = tool_call.index,value = {id, name, arguments 字符串拼接}
		// —— 关键路径:DeepSeek 的工具调用参数以片段方式到达,需要按 index 聚合。
		const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			readLoop: while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// 关键路径:SSE 按行分割,`stream: true` 让多字节字符跨 chunk 也能正确解码。
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				// 保留最后一段(可能是不完整的行)等待下一轮拼接。
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) continue;

					const data = trimmed.slice(6);
					if (data === '[DONE]') {
						break readLoop;
					}

					try {
						const parsed = JSON.parse(data) as {
							choices?: Array<{
								delta?: {
									content?: string;
									tool_calls?: OpenAIToolCallChunk[];
								};
							}>;
						};

						const choice = parsed.choices?.[0];
						if (!choice?.delta) continue;

						// 文本增量
						if (choice.delta.content) {
							yield { text: choice.delta.content };
						}

						// 工具调用:按 index 累积参数(arguments 是 JSON 字符串片段)。
						if (choice.delta.tool_calls) {
							for (const tc of choice.delta.tool_calls) {
								const existing = toolCallAccumulators.get(tc.index);
								if (existing) {
									if (tc.function?.arguments) {
										existing.arguments += tc.function.arguments;
									}
								} else {
									// 首个 chunk 携带 id 与 name,后续 chunk 仅补全 arguments。
									toolCallAccumulators.set(tc.index, {
										id: tc.id ?? '',
										name: tc.function?.name ?? '',
										arguments: tc.function?.arguments ?? '',
									});
								}
							}
						}
					} catch {
						// 修复:协议偶发返回非法 JSON,跳过单条以保证流继续。
					}
				}
			}
		} finally {
			// 关键路径:无论正常 / 异常结束都要释放底层流,避免连接泄漏。
			reader.releaseLock();
		}

		// 收尾:把累积的工具调用一次性 yield 出去,text 留空以便调用方区分。
		for (const [, tc] of toolCallAccumulators) {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc.arguments) as Record<string, unknown>;
			} catch {
				// 修复:模型截断或残缺 JSON 时,把原始字符串塞入 raw 字段,避免整轮失败。
				args = { raw: tc.arguments };
			}
			const toolCall: ToolCall = { id: tc.id, name: tc.name, args };
			yield { text: '', toolCall };
		}
	}

	/**
	 * 估算文本 token 数。
	 *
	 * 简化实现:按 4 字符 ≈ 1 token 处理,对中英文混合语料大致可用。
	 * 仅用于上下文预算的粗判,不替代真实的 tokenizer。
	 *
	 * @param text - 待估算文本。
	 * @returns 估算的 token 数(向上取整)。
	 */
	countTokens(text: string): number {
		// 经验值:CJK + Latin 混合语料平均 ~4 字符 / token。
		return Math.ceil(text.length / 4);
	}

	/**
	 * 构造 OpenAI 兼容的请求体。
	 *
	 * 关键转换:
	 * - 助手消息若携带 `toolCallId`,补齐 `tool_calls` 数组,让多轮工具调用上下文完整。
	 * - 工具消息(`role: 'tool'`)需要 `tool_call_id` 把结果回绑到对应调用。
	 *
	 * @param req - 内部 `ChatRequest`。
	 * @returns 序列化前的请求体对象。
	 */
	private buildRequestBody(req: ChatRequest): Record<string, unknown> {
		const messages: Record<string, unknown>[] = req.messages.map((m) => {
			const msg: Record<string, unknown> = { role: m.role, content: m.content };
			if (m.role === 'assistant' && m.toolCallId) {
				// OpenAI 协议要求 content 与 tool_calls 同时存在;空内容置 null。
				msg.content = m.content || null;
				msg.tool_calls = [{
					id: m.toolCallId,
					type: 'function',
					function: { name: m.toolName ?? '', arguments: JSON.stringify(m.toolArgs ?? {}) },
				}];
			}
			if (m.role === 'tool' && m.toolCallId) {
				msg.tool_call_id = m.toolCallId;
			}
			return msg;
		});

		const body: Record<string, unknown> = {
			model: this.config.model,
			messages,
			stream: true,
		};

		if (req.tools && req.tools.length > 0) {
			// 仅在有工具时下发 tools 字段,减少无关请求体积。
			body.tools = req.tools.map((t) => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				},
			}));
		}

		return body;
	}
}
