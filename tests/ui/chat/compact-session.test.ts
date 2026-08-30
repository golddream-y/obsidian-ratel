/**
 * @file tests/ui/chat/compact-session.test.ts
 * @description compact-session 单元测试 — /compact 写 marker 不删 transcript
 */

import { describe, it, expect } from 'vitest';
import { compactSession } from '../../../src/ui/chat/compact-session';
import { projectView } from '../../../src/core/compact-project';
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
		getLastSessionId: async () => null,
		setLastSessionId: async () => {},
		listSessionIndex: async () => [],
	};
}

function createMockLLM(responses: ChatDelta[][]): LLMClient {
	let i = 0;
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			for (const d of responses[i++] ?? []) yield d;
		},
		supportsImages: false,
		countTokens: () => 10,
	};
}

describe('compactSession', () => {
	it('compactSession - 长历史 - messages 条数不变且写入 marker', async () => {
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
		const ctx = new ContextManager(persistence, undefined, 8000);
		const llm = createMockLLM([[{ text: '这是摘要' }]]);

		const result = await compactSession(ctx, llm, 's1');

		expect(result.summary).toBe('这是摘要');
		expect(result.skipped).toBeFalsy();
		await ctx.load('s1');
		expect(ctx.getTranscript().length).toBe(9);
		expect(ctx.getTranscript()[0]!.content).toBe('问题1');
		expect(ctx.getCompactMarkers()).toHaveLength(1);
		expect(ctx.getCompactMarkers()[0]!.summary).toBe('这是摘要');
		const projected = ctx.toMessages('direct');
		expect(projected.some((m) => m.content.includes('问题1'))).toBe(false);
	});

	it('compactSession - 历史不足 - skipped 不调 LLM', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: '问1' },
				{ role: 'assistant', content: '答1' },
			],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createPersistence(sessions);
		const ctx = new ContextManager(persistence, undefined, 8000);
		const llm: LLMClient = {
			async *chat() {
				throw new Error('LLM 不应被调用');
			},
			supportsImages: false,
			countTokens: () => 0,
		};

		const result = await compactSession(ctx, llm, 's1');
		expect(result.skipped).toBe(true);
		expect(result.summary).toBe('');
		expect(ctx.getCompactMarkers()).toHaveLength(0);
	});

	it('compactSession - 空摘要 - 抛错且不写 marker', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: '问1' },
				{ role: 'assistant', content: '答1' },
				{ role: 'user', content: '问2' },
				{ role: 'assistant', content: '答2' },
			],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createPersistence(sessions);
		const ctx = new ContextManager(persistence, undefined, 8000);
		const llm = createMockLLM([[{ text: '   ' }]]);

		await expect(compactSession(ctx, llm, 's1')).rejects.toThrow();

		await ctx.load('s1');
		expect(ctx.getCompactMarkers()).toHaveLength(0);
		expect(ctx.getTranscript().length).toBe(4);
	});

	it('compactSession - LLM 抛错 - messages 原样', async () => {
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
		const ctx = new ContextManager(persistence, undefined, 8000);
		const llm: LLMClient = {
			async *chat() {
				throw new Error('network');
			},
			supportsImages: false,
			countTokens: () => 0,
		};

		await expect(compactSession(ctx, llm, 's1')).rejects.toThrow('network');

		await ctx.load('s1');
		expect(ctx.getTranscript().length).toBe(4);
		expect(ctx.getTranscript()[0]!.content).toBe('原问1');
		expect(ctx.getCompactMarkers()).toHaveLength(0);
	});

	it('compactSession - untilIndex 排除当前 user - marker 后 tail 仍含该句', async () => {
		const currentUser = '本轮新问题';
		const oldMessages: ChatMessage[] = [
			{ role: 'user', content: '问题1' },
			{ role: 'assistant', content: '答案1' },
			{ role: 'user', content: '问题2' },
			{ role: 'assistant', content: '答案2' },
			{ role: 'user', content: '问题3' },
			{ role: 'assistant', content: '答案3' },
			{ role: 'user', content: '保留问题1' },
			{ role: 'assistant', content: '保留答案1' },
			{ role: 'user', content: currentUser },
		];
		const sessions = new Map<string, Session>();
		sessions.set('s1', { id: 's1', title: '', messages: oldMessages, createdAt: 0, updatedAt: 0 });

		let capturedHistory = '';
		const llm: LLMClient = {
			async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
				const userMsg = req.messages.find((m) => m.role === 'user');
				capturedHistory = typeof userMsg?.content === 'string' ? userMsg.content : '';
				yield { text: '溢出摘要' };
			},
			supportsImages: false,
			countTokens: () => 10,
		};

		const persistence = createPersistence(sessions);
		const ctx = new ContextManager(persistence, undefined, 8000);
		const untilIndex = oldMessages.length - 2;

		const result = await compactSession(ctx, llm, 's1', {}, { untilIndex });

		expect(result.marker?.afterIndex).toBe(untilIndex);
		expect(capturedHistory).not.toContain(currentUser);
		await ctx.load('s1');
		const projected = ctx.toMessages('direct');
		expect(projected.some((m) => m.content.includes(currentUser))).toBe(true);
		const { tail } = projectView(ctx.getTranscript(), ctx.getCompactMarkers());
		expect(tail.some((m) => m.content === currentUser)).toBe(true);
	});
});
