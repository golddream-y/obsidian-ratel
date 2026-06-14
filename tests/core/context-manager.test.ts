import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session } from '../../src/ports/persistence';
import type { ToolCall } from '../../src/ports/llm';

function createMockPersistence(sessions: Map<string, Session> = new Map()): Persistence {
	return {
		sessions: {
			get: async (id: string) => sessions.get(id) ?? null,
			upsert: async (session: Session) => { sessions.set(session.id, session); },
			list: async () => Array.from(sessions.values()),
			delete: async (id: string) => { sessions.delete(id); },
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

describe('ContextManager', () => {
	it('creates a new session when none exists', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		expect(ctx.toMessages()).toHaveLength(1); // system prompt only
		expect(ctx.toMessages()[0]!.role).toBe('system');
	});

	it('loads existing session with history', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('session-1', {
			id: 'session-1',
			title: 'Test',
			messages: [
				{ role: 'user', content: 'Hello' },
				{ role: 'assistant', content: 'Hi there' },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		const msgs = ctx.toMessages();
		// system + 2 history messages
		expect(msgs).toHaveLength(3);
		expect(msgs[1]!.content).toBe('Hello');
	});

	it('adds user message and includes it in toMessages', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('What is X?');
		const msgs = ctx.toMessages();
		// system + user
		expect(msgs).toHaveLength(2);
		expect(msgs[1]!.role).toBe('user');
		expect(msgs[1]!.content).toBe('What is X?');
	});

	it('adds tool result to context', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Read foo.md');

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'read_note',
			args: { path: 'foo.md' },
		};
		ctx.addAssistantToolCall(toolCall, '');
		ctx.addToolResult('call_1', 'Content of foo.md');

		const msgs = ctx.toMessages();
		// system + user + assistant(tool_call) + tool(result)
		expect(msgs).toHaveLength(4);
		expect(msgs[2]!.role).toBe('assistant');
		expect(msgs[2]!.toolName).toBe('read_note');
		expect(msgs[3]!.role).toBe('tool');
		expect(msgs[3]!.content).toBe('Content of foo.md');
	});

	it('saves session via persistence', async () => {
		const sessions = new Map<string, Session>();
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Hello');
		await ctx.save();
		expect(sessions.has('session-1')).toBe(true);
		const saved = sessions.get('session-1')!;
		expect(saved.messages).toHaveLength(1);
	});

	it('tokenCount returns positive number', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Hello world');
		expect(ctx.tokenCount()).toBeGreaterThan(0);
	});

	it('addUserMessage throws before load', () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		expect(() => ctx.addUserMessage('hi')).toThrow('Session not loaded');
	});

	it('addAssistantMessage throws before load', () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		expect(() => ctx.addAssistantMessage('hi')).toThrow('Session not loaded');
	});

	it('addAssistantToolCall throws before load', () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		expect(() => ctx.addAssistantToolCall({ id: 't1', name: 'x', args: {} }, 'text')).toThrow('Session not loaded');
	});

	it('addToolResult throws before load', () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		expect(() => ctx.addToolResult('t1', 'result')).toThrow('Session not loaded');
	});

	it('save throws before load', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await expect(ctx.save()).rejects.toThrow('Session not loaded');
	});

	it('sessionId returns empty string before load', () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		expect(ctx.sessionId).toBe('');
	});

	it('tokenCount works even before load (returns non-negative)', () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		expect(ctx.tokenCount()).toBeGreaterThanOrEqual(0);
	});
});
