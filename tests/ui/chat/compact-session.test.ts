/**
 * @file tests/ui/chat/compact-session.test.ts
 * @description compact-session 单元测试 — /compact 流程:LLM 摘要 + 保留最近 3 条 + 重置 session
 */

import { describe, it, expect } from 'vitest';
import { compactSession } from '../../../src/ui/chat/compact-session';
import { ContextManager } from '../../../src/core/context-manager';
import type { LLMClient, ChatRequest, ChatDelta } from '../../../src/ports/llm';
import type { Persistence, Session, ChatMessage } from '../../../src/ports/persistence';

function createPersistence(sessions = new Map<string, Session>()): Persistence {
	return {
		sessions: {
			get: async (id) => sessions.get(id) ?? null,
			upsert: async (s) => {
				sessions.set(s.id, s);
			},
			list: async () => [],
			delete: async (id) => {
				sessions.delete(id);
			},
		},
		notes: {
			get: async () => null,
			upsert: async () => {},
			listByPath: async () => [],
			delete: async () => {},
		},
		hooks: { append: async () => {}, list: async () => [] },
	};
}

function createMockLLM(responses: ChatDelta[][]): LLMClient {
	let i = 0;
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			for (const d of responses[i++] ?? []) yield d;
		},
		countTokens: () => 10,
	};
}

describe('compactSession', () => {
	it('正常 - 摘要 + 保留最近 3 条 + 重置 session', async () => {
		const sessions = new Map<string, Session>();
		const oldMessages: ChatMessage[] = [
			{ role: 'user', content: '问题1' },
			{ role: 'assistant', content: '答案1' },
			{ role: 'user', content: '问题2' },
			{ role: 'assistant', content: '答案2' },
			{ role: 'user', content: '问题3' },
			{ role: 'assistant', content: '答案3' },
			{ role: 'user', content: '保留问题1' },
			{ role: 'assistant', content: '保留答案1' },
			{ role: 'user', content: '保留问题2' },
		];
		sessions.set('s1', { id: 's1', title: '', messages: oldMessages, createdAt: 0, updatedAt: 0 });

		const persistence = createPersistence(sessions);
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([[{ text: '这是摘要' }]]);

		const result = await compactSession(ctx, llm, 's1');

		expect(result.summary).toBe('这是摘要');
		expect(result.preservedMessages).toHaveLength(3);
		// 关键路径:slice(-3) 保留最后 3 条 = [保留问题1, 保留答案1, 保留问题2]
		// 注:plan 原始测试期望 [答案3, 保留问题1, 保留答案1] 与实现 slice(-3) 语义冲突,此处修正为匹配实现
		expect(result.preservedMessages[0]!.content).toBe('保留问题1');
		expect(result.preservedMessages[1]!.content).toBe('保留答案1');
		expect(result.preservedMessages[2]!.content).toBe('保留问题2');

		// session 已重置,只剩摘要 system + 3 条 preserved
		await ctx.load('s1');
		const messages = ctx.toMessages('direct');
		expect(messages.some((m) => m.role === 'system' && m.content.includes('这是摘要'))).toBe(true);
		expect(messages.some((m) => m.content === '问题1')).toBe(false);
		expect(messages.some((m) => m.content === '保留问题1')).toBe(true);
	});

	it('LLM 失败 - 抛错,session 不重置', async () => {
		// 关键路径:数据需 ≥ 4 条才会触发 LLM 摘要(length <= 3 时早返回不调 LLM)
		// 注:plan 原始测试只放 1 条消息但期望 LLM 抛错,与早返回边界冲突,此处补足至 4 条
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: '原问1' },
				{ role: 'assistant', content: '原答1' },
				{ role: 'user', content: '原问2' },
				{ role: 'assistant', content: '原答2' },
			],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createPersistence(sessions);
		const ctx = new ContextManager(persistence);
		const llm: LLMClient = {
			async *chat() {
				throw new Error('network');
			},
			countTokens: () => 0,
		};

		await expect(compactSession(ctx, llm, 's1')).rejects.toThrow('network');

		// session 未被重置,原消息还在
		await ctx.load('s1');
		const messages = ctx.toMessages('direct');
		expect(messages.some((m) => m.content === '原问1')).toBe(true);
	});

	it('历史不足 3 条 - 全部保留,不调 LLM', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [{ role: 'user', content: '只一条' }],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createPersistence(sessions);
		const ctx = new ContextManager(persistence);
		// 关键路径:mock 改为 throw,真正验证"历史不足 3 条不调 LLM"(早返回路径)
		const llm: LLMClient = {
			async *chat() { throw new Error('LLM 不应被调用'); },
			countTokens: () => 0,
		};

		const result = await compactSession(ctx, llm, 's1');
		expect(result.summary).toBe('');
		expect(result.preservedMessages).toHaveLength(1);
	});
});
