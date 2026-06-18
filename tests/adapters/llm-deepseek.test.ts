/**
 * @file tests/adapters/llm-deepseek.test.ts
 * @description DeepSeek LLM 适配器单元测试(requestUrl + SSE 解析 + 工具调用)
 * @module tests/adapters/llm-deepseek
 * @depends src/adapters/llm-deepseek, src/ports/llm
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 关键路径:vi.hoisted 确保 mockRequestUrl 在 vi.mock 提升前完成初始化。
const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));

vi.mock('obsidian', () => ({
	requestUrl: mockRequestUrl,
}));

import { DeepSeekLLM } from '../../src/adapters/llm-deepseek';
import type { ChatRequest } from '../../src/ports/llm';

/**
 * 把 SSE 事件数组拼接为完整的 SSE text(每行一个 data: 事件,以 [DONE] 结尾)。
 */
function buildSseText(events: string[]): string {
	return events.map((e) => `data: ${e}`).join('\n') + '\n';
}

describe('DeepSeekLLM', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('sends chat request and yields text deltas', async () => {
		const sseText = buildSseText([
			'{"choices":[{"delta":{"content":"Hello"}}]}',
			'{"choices":[{"delta":{"content":" world"}}]}',
			'[DONE]',
		]);

		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			text: sseText,
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
		expect(mockRequestUrl).toHaveBeenCalledOnce();
		const callArg = mockRequestUrl.mock.calls[0]![0] as Record<string, unknown>;
		expect(callArg.url).toBe('https://api.deepseek.com/chat/completions');
		expect(callArg.method).toBe('POST');
	});

	it('handles tool calls in stream', async () => {
		const sseText = buildSseText([
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_note","arguments":""}}]}}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.md\\"}"}}]}}]}',
			'[DONE]',
		]);

		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			text: sseText,
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
		mockRequestUrl.mockResolvedValueOnce({
			status: 401,
			text: '',
		});

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-bad',
			model: 'deepseek-chat',
		});

		await expect(async () => {
			const stream = llm.chat({ messages: [{ role: 'user', content: 'Hi' }] });
			for await (const _ of stream) { /* consume */ }
		}).rejects.toThrow('LLM API error: 401');
	});

	it('serializes tool call messages correctly in request body', async () => {
		let capturedBody: Record<string, unknown> | null = null;
		mockRequestUrl.mockImplementationOnce(async (params: Record<string, unknown>) => {
			capturedBody = JSON.parse(params.body as string);
			return {
				status: 200,
				text: buildSseText([
					'{"choices":[{"delta":{"content":"ok"}}]}',
					'[DONE]',
				]),
			};
		});

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
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
		const body = (adapter as unknown as { buildRequestBody: (req: ChatRequest) => Record<string, unknown> }).buildRequestBody(req) as { messages: Array<Record<string, unknown>> };
		const assistantMsg = body.messages[1]!;
		const toolCall = (assistantMsg.tool_calls as Array<Record<string, unknown>>)[0]!;
		const fn = toolCall.function as Record<string, unknown>;
		expect(fn.arguments).toBe('{"path":"notes/test.md"}');
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
		// 混合合法与非法 JSON 行,非法行应被跳过。
		const sseText = 'data: {not valid json\ndata: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]\n';

		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			text: sseText,
		});

		const adapter = new DeepSeekLLM({ apiBase: 'http://test', apiKey: 'sk', model: 'm' });
		const stream = adapter.chat({ messages: [] });
		const collected: string[] = [];
		for await (const delta of stream) {
			if (delta.text) collected.push(delta.text);
		}
		// 非法行跳过后,合法行仍被解析
		expect(collected).toEqual(['ok']);
	});

	it('handles multiple tool_calls in single response', async () => {
		const sseText = buildSseText([
			'{"choices":[{"delta":{"content":"Let me check both."},"index":0}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","type":"function","function":{"name":"read_note","arguments":"{\\"path\\":\\"a.md\\"}"}}]},"index":0}]}',
			'{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"tc2","type":"function","function":{"name":"read_note","arguments":"{\\"path\\":\\"b.md\\"}"}}]},"index":0}]}',
			'[DONE]',
		]);

		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			text: sseText,
		});

		const adapter = new DeepSeekLLM({ apiBase: 'http://test', apiKey: 'sk', model: 'm' });
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

	it('handles network error', async () => {
		// requestUrl 网络错误直接 reject
		mockRequestUrl.mockRejectedValueOnce(new Error('Network error'));

		const adapter = new DeepSeekLLM({ apiBase: 'http://test', apiKey: 'sk', model: 'm' });
		const stream = adapter.chat({ messages: [] });

		await expect(async () => {
			for await (const _ of stream) { /* consume */ }
		}).rejects.toThrow('Network error');
	});

	it('throws on empty response body', async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			text: '',
		});

		const adapter = new DeepSeekLLM({ apiBase: 'http://test', apiKey: 'sk', model: 'm' });

		await expect(async () => {
			for await (const _ of adapter.chat({ messages: [] })) { /* consume */ }
		}).rejects.toThrow('empty body');
	});
});
