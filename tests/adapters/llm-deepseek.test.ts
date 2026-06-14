import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekLLM } from '../../src/adapters/llm-deepseek';
import type { ChatRequest } from '../../src/ports/llm';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('DeepSeekLLM', () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it('sends chat request and yields text deltas', async () => {
		// Simulate SSE stream with two text chunks
		const sseChunks = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
			'data: [DONE]\n\n',
		];
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				for (const chunk of sseChunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});

		mockFetch.mockResolvedValueOnce({
			ok: true,
			body: stream,
		});

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});

		const req: ChatRequest = {
			messages: [{ role: 'user', content: 'Hi' }],
		};

		const deltas: string[] = [];
		for await (const delta of llm.chat(req)) {
			if (delta.text) deltas.push(delta.text);
		}

		expect(deltas).toEqual(['Hello', ' world']);
		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, options] = mockFetch.mock.calls[0]!;
		expect(url).toBe('https://api.deepseek.com/chat/completions');
		expect((options as RequestInit).method).toBe('POST');
	});

	it('handles tool calls in stream', async () => {
		const sseChunks = [
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_note","arguments":""}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.md\\"}"}}]}}]}\n\n',
			'data: [DONE]\n\n',
		];
		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				for (const chunk of sseChunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		});

		mockFetch.mockResolvedValueOnce({
			ok: true,
			body: stream,
		});

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});

		const req: ChatRequest = {
			messages: [{ role: 'user', content: 'Read test.md' }],
			tools: [{
				name: 'read_note',
				description: 'Read a note',
				parameters: { type: 'object', properties: { path: { type: 'string' } } },
			}],
		};

		let toolCallFound = false;
		for await (const delta of llm.chat(req)) {
			if (delta.toolCall) {
				toolCallFound = true;
				expect(delta.toolCall.name).toBe('read_note');
				expect(delta.toolCall.args).toEqual({ path: 'test.md' });
			}
		}
		expect(toolCallFound).toBe(true);
	});

	it('throws on API error', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
			body: null,
		});

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-bad',
			model: 'deepseek-chat',
		});

		await expect(async () => {
			const stream = llm.chat({ messages: [{ role: 'user', content: 'Hi' }] });
			for await (const _ of stream) { /* consume */ }
		}).rejects.toThrow('LLM API error: 401 Unauthorized');
	});

	it('serializes tool call messages correctly in request body', async () => {
		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});

		// Capture the request body
		let capturedBody: Record<string, unknown> | null = null;
		mockFetch.mockImplementationOnce(async (_url: string, options: RequestInit) => {
			capturedBody = JSON.parse(options.body as string);
			// Return minimal SSE stream
			const encoder = new TextEncoder();
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					controller.close();
				},
			});
			return { ok: true, body: stream };
		});

		const req: ChatRequest = {
			messages: [
				{ role: 'user', content: 'Read test.md' },
				{ role: 'assistant', content: '', toolCallId: 'call_1', toolName: 'read_note' },
				{ role: 'tool', content: 'Content of test.md', toolCallId: 'call_1' },
			],
			tools: [{
				name: 'read_note',
				description: 'Read a note',
				parameters: { type: 'object', properties: { path: { type: 'string' } } },
			}],
		};

		for await (const _ of llm.chat(req)) { /* consume */ }

		expect(capturedBody).not.toBeNull();
		const messages = capturedBody!.messages as Record<string, unknown>[];

		// User message
		expect(messages[0]).toEqual({ role: 'user', content: 'Read test.md' });

		// Assistant message with tool_calls
		expect(messages[1]!.role).toBe('assistant');
		expect(messages[1]).toHaveProperty('tool_calls');
		const toolCalls = (messages[1] as { tool_calls: unknown[] }).tool_calls;
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toEqual({
			id: 'call_1',
			type: 'function',
			function: { name: 'read_note', arguments: '{}' },
		});
		// content should be null (not empty string) when toolCallId present and content is empty
		expect(messages[1]!.content).toBeNull();

		// Tool message with tool_call_id
		expect(messages[2]).toEqual({ role: 'tool', content: 'Content of test.md', tool_call_id: 'call_1' });
	});

	it('serializes tool call arguments in request body', () => {
		const adapter = new DeepSeekLLM({ apiBase: 'http://test', apiKey: 'sk-test', model: 'test' });
		const req: ChatRequest = {
			messages: [
				{ role: 'user', content: 'test' },
				{ role: 'assistant', content: '', toolCallId: 'call_1', toolName: 'read_note', toolArgs: { path: 'notes/test.md' } },
				{ role: 'tool', content: 'result', toolCallId: 'call_1' },
			],
		};
		const body = (adapter as any).buildRequestBody(req) as { messages: any[] };
		const assistantMsg = body.messages[1];
		expect(assistantMsg.tool_calls[0].function.arguments).toBe('{"path":"notes/test.md"}');
	});

	it('countTokens returns rough estimate', () => {
		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});
		const count = llm.countTokens('Hello world');
		expect(count).toBeGreaterThan(0);
	});

	it('handles malformed SSE chunk gracefully', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('data: {not valid json\n\n'));
					controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
					controller.close();
				},
			}),
		});

		const adapter = new DeepSeekLLM({ apiBase: 'http://test', apiKey: 'sk', model: 'm' });
		const stream = adapter.chat({ messages: [] });
		const collected: string[] = [];
		for await (const delta of stream) {
			if (delta.text) collected.push(delta.text);
		}
		// Malformed chunks are silently skipped; stream completes without error
		expect(collected).toEqual([]);
	});

	it('handles multiple tool_calls in single response', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Let me check both."},"index":0}]}\n\n'));
					controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","type":"function","function":{"name":"read_note","arguments":"{\\"path\\":\\"a.md\\"}"}}]},"index":0}]}\n\n'));
					controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"tc2","type":"function","function":{"name":"read_note","arguments":"{\\"path\\":\\"b.md\\"}"}}]},"index":0}]}\n\n'));
					controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
					controller.close();
				},
			}),
		});

		const adapter = new DeepSeekLLM({ apiBase: 'http://test', apiKey: 'sk', model: 'm' });
		// The SSE parser uses Map<index, ...> so different-index tool_calls don't overwrite each other.
		// At end-of-stream, all accumulated tool_calls are yielded.
		const toolCalls: Array<{ id: string; name: string }> = [];
		for await (const delta of adapter.chat({ messages: [] })) {
			if (delta.toolCall) toolCalls.push({ id: delta.toolCall.id, name: delta.toolCall.name });
		}
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls).toEqual(expect.arrayContaining([
			{ id: 'tc1', name: 'read_note' },
			{ id: 'tc2', name: 'read_note' },
		]));
	});

	it('handles network error mid-stream', async () => {
		// Use pull-based stream so the first chunk is delivered to the consumer
		// before the stream is errored on the next pull (mimics mid-stream disconnect).
		let pullCount = 0;
		mockFetch.mockResolvedValueOnce({
			ok: true,
			body: new ReadableStream({
				pull(controller) {
					pullCount++;
					if (pullCount === 1) {
						controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n'));
					} else {
						controller.error(new Error('Connection reset'));
					}
				},
			}),
		});

		const adapter = new DeepSeekLLM({ apiBase: 'http://test', apiKey: 'sk', model: 'm' });
		const stream = adapter.chat({ messages: [] });
		const collected: string[] = [];
		await expect(async () => {
			for await (const delta of stream) {
				if (delta.text) collected.push(delta.text);
			}
		}).rejects.toThrow();
		// Should have received at least the first chunk
		expect(collected).toEqual(['Hello']);
	});
});
