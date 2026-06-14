import { describe, it, expect } from 'vitest';
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
});
