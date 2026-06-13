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

	it('countTokens returns rough estimate', () => {
		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});
		const count = llm.countTokens('Hello world');
		expect(count).toBeGreaterThan(0);
	});
});
