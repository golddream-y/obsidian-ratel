/**
 * @file src/adapters/llm-deepseek.ts
 * @description DeepSeek 聊天补全适配器(OpenAI 兼容协议,支持流式 SSE 与工具调用)
 * @module adapters/llm-deepseek
 * @depends obsidian(requestUrl 备用), ports/llm, node:https/node:http(node 原生流式)
 */

import { requestUrl } from 'obsidian';
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
 * - 使用 Node.js 原生 https/http 模块流式读取 SSE,真正逐 chunk yield delta,
 *   让 UI 层能实现打字机效果并缩短首 token 时间(TTFT)。
 * - 工具调用在多 chunk 间累积(`toolCallAccumulators` 按 index 聚合)再统一 yield。
 * - 网络错误、协议错误、JSON 解析错误均降级处理,不让单条坏数据中断整次会话。
 * - 若 URL 解析失败或协议不支持,降级到 Obsidian `requestUrl`(一次性返回,无打字机效果)。
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
	 * - 文本增量通过 `{ text }` yield,每个 chunk 到达时立即 yield(真流式)。
	 * - 工具调用在 `[DONE]` 之前累积,流结束后按 index 顺序 yield `{ toolCall }`(text 为空字符串)。
	 * - 若 SSE 出现无法解析的 JSON chunk,静默跳过,不影响后续 chunk。
	 *
	 * 关键路径:Node.js https/http 原生模块支持 ReadableStream,可以边收边解析 SSE,
	 * 无需等整个响应完成。相比 Obsidian `requestUrl`(一次性返回 text),首 token 时间大幅缩短,
	 * UI 层可以实现逐字打字机效果。
	 *
	 * @param req - 对话消息 + 可选工具定义。
	 * @returns 异步迭代的 `ChatDelta`。
	 * @throws 当 HTTP 状态非 2xx、响应体为空、或底层网络异常时抛出。
	 */
	async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
		const body = this.buildRequestBody(req);
		const url = new URL(`${this.config.apiBase}/chat/completions`);
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'text/event-stream',
		};
		if (this.config.apiKey) {
			headers['Authorization'] = `Bearer ${this.config.apiKey}`;
		}

		// 关键路径:Node.js 原生 http/https 流式读取。
		// 按协议选择 http 或 https 模块,Ollama 本地端点可能走 http。
		let stream: NodeJS.ReadableStream;
		let statusCode = 0;
		try {
			({ stream, statusCode } = await this.requestStream(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			}));
		} catch (err) {
			// 降级:若原生流式请求失败(如特殊代理/协议问题),回退到 requestUrl 一次性请求。
			// 这种降级模式下无打字机效果,但保证功能可用。
			yield* this.chatViaRequestUrl(req);
			return;
		}

		if (statusCode < 200 || statusCode >= 300) {
			// 消费掉错误体以便连接干净关闭
			const errText = await this.readAll(stream);
			throw new Error(`LLM API error: ${statusCode} ${errText.slice(0, 200)}`);
		}

		// 工具调用增量缓冲:key = tool_call.index,value = {id, name, arguments 字符串拼接}
		const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();
		let buffer = '';
		let finishReason: string | null = null;
		// 关键路径:保存流末尾的 API 真值 token,finally 阶段 yield 到 message.end
		let capturedUsage: { promptTokens: number; completionTokens: number } | undefined;

		for await (const chunk of stream as unknown as AsyncIterable<Buffer | string>) {
			buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

			// SSE 事件以 \n\n 分隔
			let newlineIdx: number;
			while ((newlineIdx = buffer.indexOf('\n\n')) !== -1) {
				const rawEvent = buffer.slice(0, newlineIdx);
				buffer = buffer.slice(newlineIdx + 2);
				const result = this.processSSEEvent(rawEvent, toolCallAccumulators);
				if (result.finishReason) finishReason = result.finishReason;
				if (result.usage) capturedUsage = result.usage;
				yield* result.deltas;
			}
		}

		// 处理尾部可能残留的最后一个事件
		if (buffer.trim()) {
			const result = this.processSSEEvent(buffer, toolCallAccumulators);
			if (result.finishReason) finishReason = result.finishReason;
			if (result.usage) capturedUsage = result.usage;
			yield* result.deltas;
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

		// 关键路径:流末尾 yield usage,供 agent-loop 透传到 message.end
		if (capturedUsage) {
			yield { text: '', usage: capturedUsage };
		}

		// 关键路径:流末尾 yield finishReason,让 agent-loop 判断是否被 max_tokens 截断。
		if (finishReason) {
			yield { text: '', finishReason: finishReason as ChatDelta['finishReason'] };
		}
	}

	/**
	 * 处理一段 SSE 事件文本(单条或多条 data: 行),逐行解析并收集 delta 与 finishReason。
	 *
	 * @param raw - 不含结尾 \n\n 的原始事件文本。
	 * @param toolCallAccumulators - 工具调用累积 map(跨 chunk 共享)。
	 * @returns `{ deltas, finishReason, usage }` — deltas 是本轮收集的 ChatDelta 数组,finishReason 是解析到的结束原因(若有),usage 是 API 真值 token 统计(流末尾出现一次)。
	 */
	private processSSEEvent(
		raw: string,
		toolCallAccumulators: Map<number, { id: string; name: string; arguments: string }>,
	): { deltas: ChatDelta[]; finishReason: string | null; usage?: { promptTokens: number; completionTokens: number } } {
		const deltas: ChatDelta[] = [];
		let finishReason: string | null = null;
		let usage: { promptTokens: number; completionTokens: number } | undefined;
		const lines = raw.split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith('data: ')) continue;

			const data = trimmed.slice(6);
			if (data === '[DONE]') return { deltas, finishReason, usage };

			try {
				const parsed = JSON.parse(data) as {
					choices?: Array<{
						delta?: {
							content?: string;
							reasoning_content?: string;
							tool_calls?: OpenAIToolCallChunk[];
						};
						finish_reason?: string | null;
					}>;
					usage?: {
						prompt_tokens?: number;
						completion_tokens?: number;
						total_tokens?: number;
					};
				};

				const choice = parsed.choices?.[0];
				if (!choice) {
					// 关键路径:usage 可能在无 choices 的末尾 chunk 中出现
					if (parsed.usage) {
						usage = {
							promptTokens: parsed.usage.prompt_tokens ?? 0,
							completionTokens: parsed.usage.completion_tokens ?? 0,
						};
					}
					continue;
				}

				if (choice.delta?.content) {
					deltas.push({ text: choice.delta.content });
				}
				// 关键路径:DeepSeek reasoner 的思考过程,yield 为 reasoning delta(text 留空)
				if (choice.delta?.reasoning_content) {
					deltas.push({ text: '', reasoning: choice.delta.reasoning_content });
				}

				if (choice.delta?.tool_calls) {
					for (const tc of choice.delta.tool_calls) {
						const existing = toolCallAccumulators.get(tc.index);
						if (existing) {
							if (tc.function?.arguments) {
								existing.arguments += tc.function.arguments;
							}
						} else {
							toolCallAccumulators.set(tc.index, {
								id: tc.id ?? '',
								name: tc.function?.name ?? '',
								arguments: tc.function?.arguments ?? '',
							});
						}
					}
				}

				// 关键路径:捕获 finish_reason,用于上层判断是否被 max_tokens 截断。
				if (choice.finish_reason) {
					finishReason = choice.finish_reason;
				}

				// 关键路径:usage 可能在最后一个带 choices 的 chunk 中出现
				if (parsed.usage) {
					usage = {
						promptTokens: parsed.usage.prompt_tokens ?? 0,
						completionTokens: parsed.usage.completion_tokens ?? 0,
					};
				}
			} catch {
				// 修复:协议偶发返回非法 JSON,跳过单条以保证流继续。
			}
		}
		return { deltas, finishReason, usage };
	}

	/**
	 * 使用 Node.js 原生 https/http 模块发起请求,返回 Readable 流与状态码。
	 *
	 * 关键路径:不用 Obsidian requestUrl 是因为它不支持流式(等完整响应返回);
	 * 不用浏览器 fetch 是因为 DeepSeek 等 API 端点不返回 CORS 头,浏览器 fetch 被拦截。
	 * Node.js 原生模块在 Electron 渲染进程中可用(插件 marked isDesktopOnly: true),
	 * 且不受 CORS 限制,能真实流式读取 SSE。
	 *
	 * @param url - 完整请求 URL。
	 * @param options - 请求方法、头、体。
	 * @returns { stream, statusCode } 响应流与 HTTP 状态码。
	 */
	private requestStream(
		url: URL,
		options: { method: string; headers: Record<string, string>; body: string },
	): Promise<{ stream: NodeJS.ReadableStream; statusCode: number }> {
		return new Promise((resolve, reject) => {
			const isHttps = url.protocol === 'https:';
			const lib = isHttps ? require('node:https') : require('node:http');
			const req = lib.request(
				{
					hostname: url.hostname,
					port: url.port || (isHttps ? 443 : 80),
					path: url.pathname + url.search,
					method: options.method,
					headers: {
						...options.headers,
						'Content-Length': Buffer.byteLength(options.body),
					},
				},
				(res: { statusCode: number; on: (ev: string, cb: (v: unknown) => void) => void }) => {
					resolve({
						stream: res as unknown as NodeJS.ReadableStream,
						statusCode: res.statusCode ?? 0,
					});
				},
			);
			req.on('error', reject);
			req.write(options.body);
			req.end();
		});
	}

	/**
	 * 读取流的剩余内容为字符串(用于错误响应体)。
	 */
	private readAll(stream: NodeJS.ReadableStream): Promise<string> {
		return new Promise((resolve, reject) => {
			let chunks = '';
			stream.on('data', (c: Buffer | string) => {
				chunks += typeof c === 'string' ? c : c.toString('utf8');
			});
			stream.on('end', () => resolve(chunks));
			stream.on('error', reject);
		});
	}

	/**
	 * 降级路径:使用 Obsidian requestUrl 一次性请求(无流式,无打字机效果)。
	 * 当原生 https 模块因特殊环境(如某些代理配置)失败时作为兜底。
	 */
	private async *chatViaRequestUrl(req: ChatRequest): AsyncIterable<ChatDelta> {
		const body = this.buildRequestBody(req);
		const response = await requestUrl({
			url: `${this.config.apiBase}/chat/completions`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.config.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(`LLM API error: ${response.status}`);
		}

		const text = response.text;
		if (!text) throw new Error('LLM API returned empty body');

		// 关键路径:复用 processSSEEvent 解析,保证降级路径与主路径行为一致
		// (支持 reasoning_content / usage,DRY)
		const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();
		let finishReason: string | null = null;
		let capturedUsage: { promptTokens: number; completionTokens: number } | undefined;

		// 把整个响应文本作为一段 raw 传给 processSSEEvent(它内部按 \n split 行)
		const result = this.processSSEEvent(text, toolCallAccumulators);
		finishReason = result.finishReason;
		capturedUsage = result.usage;
		yield* result.deltas;

		for (const [, tc] of toolCallAccumulators) {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc.arguments) as Record<string, unknown>;
			} catch {
				args = { raw: tc.arguments };
			}
			yield { text: '', toolCall: { id: tc.id, name: tc.name, args } };
		}

		if (capturedUsage) {
			yield { text: '', usage: capturedUsage };
		}

		if (finishReason) {
			yield { text: '', finishReason: finishReason as ChatDelta['finishReason'] };
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

		// 生成参数(测试页或上层调用可覆盖)
		if (req.options) {
			if (req.options.temperature !== undefined) body.temperature = req.options.temperature;
			if (req.options.topP !== undefined) body.top_p = req.options.topP;
			if (req.options.maxTokens !== undefined) body.max_tokens = req.options.maxTokens;
		}

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
