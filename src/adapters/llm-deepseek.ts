import type { LLMClient, ChatRequest, ChatDelta, ToolCall } from '../ports/llm';

interface DeepSeekConfig {
	apiBase: string;
	apiKey: string;
	model: string;
}

interface OpenAIToolCallChunk {
	index: number;
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

export class DeepSeekLLM implements LLMClient {
	constructor(private config: DeepSeekConfig) {}

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

		const toolCallAccumulators = new Map<number, { id: string; name: string; arguments: string }>();

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		let streamDone = false;
		try {
			readLoop: while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) continue;

					const data = trimmed.slice(6);
					if (data === '[DONE]') {
						streamDone = true;
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

						// Text content
						if (choice.delta.content) {
							yield { text: choice.delta.content };
						}

						// Tool calls — accumulate across chunks
						if (choice.delta.tool_calls) {
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
					} catch {
						// Skip malformed JSON chunks
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		// Yield accumulated tool calls
		for (const [, tc] of toolCallAccumulators) {
			let args: Record<string, unknown> = {};
			try {
				args = JSON.parse(tc.arguments) as Record<string, unknown>;
			} catch {
				args = { raw: tc.arguments };
			}
			const toolCall: ToolCall = { id: tc.id, name: tc.name, args };
			yield { text: '', toolCall };
		}
	}

	countTokens(text: string): number {
		// Rough estimation: ~4 chars per token for mixed CJK/Latin
		return Math.ceil(text.length / 4);
	}

	private buildRequestBody(req: ChatRequest): Record<string, unknown> {
		const messages: Record<string, unknown>[] = req.messages.map((m) => {
			const msg: Record<string, unknown> = { role: m.role, content: m.content };
			if (m.role === 'assistant' && m.toolCallId) {
				msg.content = m.content || null;
				msg.tool_calls = [{
					id: m.toolCallId,
					type: 'function',
					function: { name: m.toolName ?? '', arguments: '{}' },
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
