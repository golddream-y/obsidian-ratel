import { describe, it, expect, vi } from 'vitest';
import { agentLoop } from '../../src/core/agent-loop';
import { ContextManager } from '../../src/core/context-manager';
import { ToolRegistry } from '../../src/core/tool-registry';
import { HookRegistry } from '../../src/core/hooks';
import type { LLMClient, ChatRequest, ChatDelta, ToolCall } from '../../src/ports/llm';
import type { Persistence, Session } from '../../src/ports/persistence';
import type { AgentEvent } from '../../src/types';

function createMockPersistence(sessions: Map<string, Session> = new Map()): Persistence {
	return {
		sessions: {
			get: async (id: string) => sessions.get(id) ?? null,
			upsert: async (session: Session) => { sessions.set(session.id, session); },
			list: async () => [],
			delete: async () => {},
		},
		notes: {
			get: async () => null,
			upsert: async () => {},
			listByPath: async () => [],
			delete: async () => {},
		},
		hooks: {
			append: async () => {},
			list: async () => [],
		},
	};
}

function createMockLLM(responses: ChatDelta[][]): LLMClient {
	let callIndex = 0;
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			const response = responses[callIndex++] ?? [];
			for (const delta of response) {
				yield delta;
			}
		},
		embed: async () => [],
		countTokens: () => 10,
	};
}

describe('agentLoop', () => {
	it('yields message events for a simple response', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([
			[
				{ text: 'Hello' },
				{ text: ' world' },
			],
		]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		expect(events.some((e) => e.type === 'message.start')).toBe(true);
		expect(events.filter((e) => e.type === 'message.delta')).toHaveLength(2);
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('handles tool call and continues loop', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'read_note',
			args: { path: 'test.md' },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: 'The note says hello' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'read_note', description: 'Read a note', parameters: {} },
			execute: async () => 'Content of test.md',
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Read test.md' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		expect(events.some((e) => e.type === 'tool.call')).toBe(true);
		expect(events.some((e) => e.type === 'tool.result')).toBe(true);
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('respects MAX_STEPS limit', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const infiniteToolCall: ToolCall = {
			id: 'call_loop',
			name: 'read_note',
			args: { path: 'loop.md' },
		};

		const llm = createMockLLM(
			Array(20).fill([{ text: '', toolCall: infiniteToolCall }]),
		);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'read_note', description: 'Read', parameters: {} },
			execute: async () => 'content',
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Loop test' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		const toolCallCount = events.filter((e) => e.type === 'tool.call').length;
		expect(toolCallCount).toBeLessThanOrEqual(10);
	});

	it('saves session after completion', async () => {
		const sessions = new Map<string, Session>();
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([[{ text: 'Done' }]]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		for await (const _ of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			// consume
		}

		expect(sessions.has('s1')).toBe(true);
	});

	it('does not fire write hooks for readOnly tools', async () => {
		const hooks = new HookRegistry();
		const hookCalls: string[] = [];
		hooks.register('pre-write', async () => { hookCalls.push('pre-write'); });
		hooks.register('post-write', async () => { hookCalls.push('post-write'); });

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'read_only_tool', description: 'test', parameters: { type: 'object', properties: {} } },
			execute: async () => 'result',
			readOnly: true,
		});

		const llm = createMockLLM([{
			text: '',
			toolCall: { id: 'tc1', name: 'read_only_tool', args: {} },
		}]);

		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		for await (const _ of agentLoop({ sessionId: 'test', message: 'hi' }, ctx, llm, tools, hooks)) {
			// consume
		}

		expect(hookCalls).toEqual([]);
	});

	it('fires write hooks for non-readOnly tools', async () => {
		const hooks = new HookRegistry();
		const hookCalls: string[] = [];
		hooks.register('pre-write', async () => { hookCalls.push('pre-write'); });
		hooks.register('post-write', async () => { hookCalls.push('post-write'); });

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'write_tool', description: 'test', parameters: { type: 'object', properties: {} } },
			execute: async () => 'result',
			readOnly: false,
		});

		const llm = createMockLLM([
			[{ text: '', toolCall: { id: 'tc1', name: 'write_tool', args: {} } }],
			[{ text: 'Done' }],
		]);

		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		for await (const _ of agentLoop({ sessionId: 'test', message: 'hi' }, ctx, llm, tools, hooks)) {
			// consume
		}

		expect(hookCalls).toEqual(['pre-write', 'post-write']);
	});

	it('handles tool execution error gracefully', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'read_note',
			args: { path: 'missing.md' },
		};

		// First LLM response: tool call, second: final answer
		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: 'Sorry, I could not find that note.' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'read_note', description: 'Read a note', parameters: {} },
			execute: async () => { throw new Error('File not found: missing.md'); },
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Read missing.md' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		// Should have error event but continue the loop
		expect(events.some((e) => e.type === 'error')).toBe(true);
		// Should still have tool.call and tool.result
		expect(events.some((e) => e.type === 'tool.call')).toBe(true);
		expect(events.some((e) => e.type === 'tool.result')).toBe(true);
		// Should still end normally
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('saves session when LLM stream errors mid-way', async () => {
		const saveSpy = vi.fn();
		const mockPersistence = {
			sessions: {
				get: vi.fn().mockResolvedValue(null),
				upsert: saveSpy,
			},
		} as unknown as Persistence;
		const ctx = new ContextManager(mockPersistence);

		const llm = {
			chat: vi.fn().mockImplementation(async function* () {
				yield { text: 'Partial ' };
				yield { text: 'response' };
				throw new Error('Network error');
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const events: string[] = [];
		for await (const e of agentLoop({ sessionId: 's1', message: 'hi' }, ctx, llm as unknown as LLMClient, tools, hooks)) {
			events.push(e.type);
		}

		// Should yield error event and still save session
		expect(events).toContain('error');
		expect(saveSpy).toHaveBeenCalled();
	});

	it('handles multiple rounds of tool calls (2+ steps)', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCallCount = { count: 0 };
		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'counter', description: '', parameters: { type: 'object', properties: {} } },
			execute: async () => {
				toolCallCount.count++;
				return `result-${toolCallCount.count}`;
			},
			readOnly: true,
		});

		let callCount = 0;
		const llm = {
			chat: vi.fn().mockImplementation(async function* () {
				callCount++;
				if (callCount <= 2) {
					yield { text: 'Calling tool', toolCall: { id: 'tc1', name: 'counter', args: {} } };
				} else {
					yield { text: 'Done' };
				}
			}),
			countTokens: vi.fn().mockReturnValue(0),
		};

		const hooks = new HookRegistry();
		for await (const _ of agentLoop({ sessionId: 's1', message: 'hi' }, ctx, llm as unknown as LLMClient, tools, hooks)) {
			// drain
			void _;
		}

		// Verify multiple tool calls happened (truly tests multi-round)
		expect(toolCallCount.count).toBeGreaterThanOrEqual(2);
	});

	// ==================== 取消机制 ====================

	it('取消 - signal 已 abort - 不调 LLM,直接 yield error + message.end', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([[{ text: 'should not reach' }]]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const controller = new AbortController();
		controller.abort();

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
			controller.signal,
		)) {
			events.push(event);
		}

		// 关键路径:signal 已 abort,第一轮就退出,不产生 message.delta
		expect(events.filter((e) => e.type === 'message.delta')).toHaveLength(0);
		expect(events.some((e) => e.type === 'error' && e.payload.code === 'CANCELLED')).toBe(true);
		// finally 块仍执行
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('取消 - 流式输出期间 abort - 保留已收到文本,yield error + message.end', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const controller = new AbortController();
		const llm: LLMClient = {
			async *chat(): AsyncIterable<ChatDelta> {
				yield { text: 'Partial ' };
				// 关键路径:第二个 delta 前触发取消
				controller.abort();
				yield { text: 'response' };
			},
			embed: async () => [],
			countTokens: () => 10,
		};

		const tools = new ToolRegistry();
		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
			controller.signal,
		)) {
			events.push(event);
		}

		// 关键路径:至少收到第一个 delta,取消后不再有更多 delta
		const deltas = events.filter((e) => e.type === 'message.delta');
		expect(deltas.length).toBeGreaterThanOrEqual(1);
		expect(events.some((e) => e.type === 'error' && e.payload.code === 'CANCELLED')).toBe(true);
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
	});

	it('取消 - 仍保存 session', async () => {
		const sessions = new Map<string, Session>();
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);

		const controller = new AbortController();
		const llm: LLMClient = {
			async *chat(): AsyncIterable<ChatDelta> {
				yield { text: 'Hello' };
				controller.abort();
			},
			embed: async () => [],
			countTokens: () => 10,
		};

		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		for await (const _ of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
			controller.signal,
		)) {
			void _;
		}

		// 关键路径:取消后 finally 块仍执行 save()
		expect(sessions.has('s1')).toBe(true);
	});
});
