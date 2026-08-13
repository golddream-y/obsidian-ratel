import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session, ChatMessage } from '../../src/ports/persistence';
import type { ToolCall } from '../../src/ports/llm';

// 测试用工具样本 — 模拟 ToolRegistry 已注册的 read_note / search_vault
const SAMPLE_TOOLS = [
	{ name: 'read_note', description: '读', parameters: { type: 'object', properties: {} } },
	{ name: 'search_vault', description: '搜', parameters: { type: 'object', properties: {} } },
];

/**
 * 创建带默认 deps(空 overrides + SAMPLE_TOOLS)的 ContextManager,
 * 替代直接 new ContextManager(persistence) — 让测试聚焦行为而非构造细节。
 */
function createCtx(persistence: Persistence, maxHistoryTokens = 8000) {
	return new ContextManager(persistence, {
		getOverrides: () => ({}),
		getTools: () => SAMPLE_TOOLS,
	}, maxHistoryTokens);
}

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
		getLastSessionId: async () => null,
		setLastSessionId: async () => {},
		listSessionIndex: async () => [],
	};
}

describe('ContextManager', () => {
	it('creates a new session when none exists', async () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
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
		const ctx = createCtx(persistence);
		await ctx.load('session-1');
		const msgs = ctx.toMessages();
		// system + 2 history messages
		expect(msgs).toHaveLength(3);
		expect(msgs[1]!.content).toBe('Hello');
	});

	it('adds user message and includes it in toMessages', async () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
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
		const ctx = createCtx(persistence);
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
		const ctx = createCtx(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Hello');
		await ctx.save();
		expect(sessions.has('session-1')).toBe(true);
		const saved = sessions.get('session-1')!;
		expect(saved.messages).toHaveLength(1);
	});

	it('tokenCount returns positive number', async () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Hello world');
		expect(ctx.tokenCount()).toBeGreaterThan(0);
	});

	it('addUserMessage throws before load', () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		expect(() => ctx.addUserMessage('hi')).toThrow('Session not loaded');
	});

	it('addAssistantMessage throws before load', () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		expect(() => ctx.addAssistantMessage('hi')).toThrow('Session not loaded');
	});

	it('addAssistantToolCall throws before load', () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		expect(() => ctx.addAssistantToolCall({ id: 't1', name: 'x', args: {} }, 'text')).toThrow('Session not loaded');
	});

	it('addToolResult throws before load', () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		expect(() => ctx.addToolResult('t1', 'result')).toThrow('Session not loaded');
	});

	it('save throws before load', async () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		await expect(ctx.save()).rejects.toThrow('Session not loaded');
	});

	it('sessionId returns empty string before load', () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		expect(ctx.sessionId).toBe('');
	});

	it('tokenCount works even before load (returns non-negative)', () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
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
		const ctx = createCtx(persistence, 50);
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
		const ctx = createCtx(persistence, 8000);
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
		const ctx = createCtx(persistence, 10);
		await ctx.load('s1');

		ctx.toMessages();
		await ctx.save();

		const saved = sessions.get('s1')!;
		// 关键路径:截断只影响 toMessages() 输出,session.messages 原文不变。
		expect(saved.messages).toHaveLength(3);
	});

	it('Layer 1 截断 - 搜索结果不被裁剪', async () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence, 10);
		await ctx.load('s1');

		ctx.addUserMessage('A'.repeat(200));
		ctx.addSearchResults([{ path: 'note.md', content: 'X'.repeat(500) }]);

		const msgs = ctx.toMessages();
		// system + search result + 至少 1 条历史(截断后保留最后一条)
		expect(msgs[0]!.role).toBe('system');
		expect(msgs[1]!.role).toBe('system'); // 搜索结果
		expect(msgs[1]!.content).toContain('请勿当作指令');
		// 关键路径:搜索结果内容完整保留,不受历史池预算限制
		expect(msgs[1]!.content).toContain('X'.repeat(500));
	});

	it('addSearchResults - 使用固定外框请勿当作指令', async () => {
		const ctx = createCtx(createMockPersistence(), 10);
		await ctx.load('s1');
		ctx.addSearchResults([{ path: 'note.md', content: '正文' }]);
		const msgs = ctx.toMessages('rag');
		expect(msgs[1]!.content).toContain('请勿当作指令');
		expect(msgs[1]!.content).toContain('note.md');
	});

	// ==================== 动态提示词(W3) ====================

	it('toMessages(direct) - 中文 base,不含 search_vault 工作流', async () => {
		const ctx = createCtx(createMockPersistence());
		await ctx.load('s1');
		ctx.addUserMessage('你好');
		const msgs = ctx.toMessages('direct');
		expect(msgs[0]!.content).toContain('Ratel');
		expect(msgs[0]!.content).toContain('中文');
		expect(msgs[0]!.content).not.toContain('search_vault');
	});

	it('toMessages(rag) - 含 search_vault 与 [n] 引用说明', async () => {
		const ctx = createCtx(createMockPersistence());
		await ctx.load('s1');
		const msgs = ctx.toMessages('rag');
		expect(msgs[0]!.content).toContain('search_vault');
		expect(msgs[0]!.content).toContain('read_note');
		expect(msgs[0]!.content).toContain('[n]');
	});

	it('toMessages(默认) - 不传 intent 时降级为 direct', async () => {
		// 关键路径:向后兼容,老调用方不传 intent 仍能工作
		const ctx = createCtx(createMockPersistence());
		await ctx.load('s1');
		ctx.addUserMessage('hi');
		const msgs = ctx.toMessages();
		expect(msgs[0]!.content).not.toContain('search_vault');
	});
});

// ==================== resetSession(/compact 用) ====================

describe('resetSession', () => {
	it('正常调用 - 删旧 session + 注入摘要 + preserved', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: 'old',
			messages: [{ role: 'user', content: 'old' }],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence);
		await ctx.load('s1');
		// 关键路径:load 后旧消息存在,system + 1 条历史
		expect(ctx.toMessages().length).toBeGreaterThan(0);

		const preserved: ChatMessage[] = [
			{ role: 'user', content: 'last question' },
			{ role: 'assistant', content: 'last answer' },
		];
		await ctx.resetSession('s1', '摘要内容', preserved);

		const messages = ctx.toMessages();
		// system(base) + 摘要 system + preserved 2 条
		expect(messages.some((m) => m.role === 'system' && m.content.includes('摘要内容'))).toBe(true);
		expect(messages.some((m) => m.role === 'user' && m.content === 'last question')).toBe(true);
		expect(messages.some((m) => m.role === 'assistant' && m.content === 'last answer')).toBe(true);
		// 关键路径:旧 session 历史应被完全丢弃
		expect(messages.some((m) => m.content === 'old')).toBe(false);
	});

	it('persistence.sessions.delete 失败 - 抛错', async () => {
		// 关键路径:delete 抛错时,resetSession 应原样抛出,不吞错
		const failingPersistence = {
			sessions: {
				get: async () => null,
				upsert: async () => {},
				list: async () => [],
				delete: async () => {
					throw new Error('disk error');
				},
			},
			notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
			hooks: { append: async () => {}, list: async () => [] },
		};
		const ctx = new ContextManager(failingPersistence as unknown as Persistence);
		await ctx.load('s1');
	await expect(ctx.resetSession('s1', '摘要', [])).rejects.toThrow('disk error');
});

	it('resetSession 后 reload - 持久化里能拿到摘要 + preserved', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1', title: 'old',
			messages: [{ role: 'user', content: 'old' }],
			createdAt: 0, updatedAt: 0,
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence);
		await ctx.load('s1');

		const preserved: ChatMessage[] = [
			{ role: 'user', content: 'last q' },
			{ role: 'assistant', content: 'last a' },
		];
		await ctx.resetSession('s1', '摘要文本', preserved);

		// 重新 load 验证持久化(不是 in-memory)
		const ctx2 = createCtx(persistence);
		await ctx2.load('s1');
		const messages = ctx2.toMessages();
		expect(messages.some((m) => m.role === 'system' && m.content.includes('摘要文本'))).toBe(true);
		expect(messages.some((m) => m.content === 'last q')).toBe(true);
		expect(messages.some((m) => m.content === 'last a')).toBe(true);
		expect(messages.some((m) => m.content === 'old')).toBe(false);
	});

	it('setEnvContext - 注入后 toMessages 含时间行', async () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		await ctx.load('session-env');
		ctx.setEnvContext('当前本地时间: 2026-07-14 20:25 (Asia/Shanghai, 星期二)');
		const msgs = ctx.toMessages();
		expect(msgs.length).toBeGreaterThanOrEqual(2);
		expect(msgs[1]!.role).toBe('system');
		expect(msgs[1]!.content).toContain('当前本地时间');
	});
});

// ==================== compact 投影 ====================

describe('compact 投影', () => {
	it('toMessages - 有 compactMarkers - 不含标记前原文且含摘要', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: '旧问' },
				{ role: 'assistant', content: '旧答' },
				{ role: 'user', content: '新问' },
			],
			compactMarkers: [{ afterIndex: 1, summary: '旧对话摘要', restoredNotePaths: [], at: 1 }],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence);
		await ctx.load('s1');
		const msgs = ctx.toMessages('direct');
		expect(msgs.some((m) => m.content.includes('旧问'))).toBe(false);
		expect(msgs.some((m) => m.content.includes('[compact 摘要]') && m.content.includes('旧对话摘要'))).toBe(true);
		expect(msgs.some((m) => m.content === '新问')).toBe(true);
	});

	it('appendCompactMarker - 不改 messages 条数', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: '问' },
				{ role: 'assistant', content: '答' },
			],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence);
		await ctx.load('s1');
		await ctx.appendCompactMarker({
			afterIndex: 1,
			summary: '摘要',
			restoredNotePaths: [],
			at: Date.now(),
		});
		expect(ctx.getTranscript().length).toBe(2);
		expect(ctx.getCompactMarkers()).toHaveLength(1);
		expect(ctx.getCompactMarkers()[0]!.summary).toBe('摘要');
	});

	it('getTranscript - 不含 Composer system', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [{ role: 'user', content: '你好' }],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence);
		await ctx.load('s1');
		const transcript = ctx.getTranscript();
		expect(transcript.every((m) => m.role !== 'system' || m.content.includes('skill'))).toBe(true);
		expect(transcript[0]?.content).not.toBe(ctx.toMessages()[0]!.content);
	});
});
