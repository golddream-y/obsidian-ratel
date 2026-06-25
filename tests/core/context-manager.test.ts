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

	// ==================== Layer 1 截断 ====================

	it('Layer 1 截断 - 历史超预算 - 从最旧裁剪,保留最后一条', async () => {
		const sessions = new Map<string, Session>();
		// 关键路径:5 条消息,每条 ~100 字符(~25 tokens),总 ~125 tokens。
		// maxHistoryTokens=50 触发截断,保留最后 1-2 条。
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: 'A'.repeat(100) },
				{ role: 'assistant', content: 'B'.repeat(100) },
				{ role: 'user', content: 'C'.repeat(100) },
				{ role: 'assistant', content: 'D'.repeat(100) },
				{ role: 'user', content: 'E'.repeat(100) },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence, 50);
		await ctx.load('s1');

		const msgs = ctx.toMessages();
		// system + 截断后的历史
		const history = msgs.slice(1); // 去掉 system prompt
		expect(history.length).toBeLessThan(5);
		// 关键路径:最后一条(当前用户消息)必须保留
		expect(history[history.length - 1]!.content).toBe('E'.repeat(100));
	});

	it('Layer 1 截断 - 历史未超预算 - 不裁剪', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: 'Hello' },
				{ role: 'assistant', content: 'Hi' },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence, 8000);
		await ctx.load('s1');

		const msgs = ctx.toMessages();
		// system + 2 history = 3
		expect(msgs).toHaveLength(3);
	});

	it('Layer 1 截断 - 不影响 session.messages 原文', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: 'A'.repeat(200) },
				{ role: 'assistant', content: 'B'.repeat(200) },
				{ role: 'user', content: 'C'.repeat(200) },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = new ContextManager(persistence, 10);
		await ctx.load('s1');

		ctx.toMessages();
		await ctx.save();

		const saved = sessions.get('s1')!;
		// 关键路径:截断只影响 toMessages() 输出,session.messages 原文不变。
		expect(saved.messages).toHaveLength(3);
	});

	it('Layer 1 截断 - 搜索结果不被裁剪', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence, 10);
		await ctx.load('s1');

		ctx.addUserMessage('A'.repeat(200));
		ctx.addSearchResults([{ path: 'note.md', content: 'X'.repeat(500) }]);

		const msgs = ctx.toMessages();
		// system + search result + 至少 1 条历史(截断后保留最后一条)
		expect(msgs[0]!.role).toBe('system');
		expect(msgs[1]!.role).toBe('system'); // 搜索结果
		expect(msgs[1]!.content).toContain('知识库检索结果');
		// 关键路径:搜索结果内容完整保留,不受历史池预算限制
		expect(msgs[1]!.content).toContain('X'.repeat(500));
	});

	// ==================== 动态提示词(W3) ====================

	it('toMessages(direct) - 返回 BASE_PROMPT(不含 RAG 工作流指令)', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('s1');
		ctx.addUserMessage('你好');

		const msgs = ctx.toMessages('direct');
		expect(msgs[0]!.role).toBe('system');
		// 关键路径:direct 模式不含 RAG workflow 指令
		expect(msgs[0]!.content).not.toContain('search_vault');
		expect(msgs[0]!.content).toContain('Ratel');
	});

	it('toMessages(rag) - 返回 RAG_PROMPT(含 search_vault 工作流指令)', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('s1');
		ctx.addUserMessage('我的笔记里有什么?');

		const msgs = ctx.toMessages('rag');
		expect(msgs[0]!.role).toBe('system');
		// 关键路径:rag 模式含 search_vault + read_note + 引用 [1][2] 指令
		expect(msgs[0]!.content).toContain('search_vault');
		expect(msgs[0]!.content).toContain('read_note');
		expect(msgs[0]!.content).toContain('[1]');
	});

	it('toMessages(默认) - 不传 intent 时降级为 direct', async () => {
		// 关键路径:向后兼容,老调用方不传 intent 仍能工作
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('s1');
		ctx.addUserMessage('hi');

		const msgs = ctx.toMessages();
		expect(msgs[0]!.content).not.toContain('search_vault');
	});
});
