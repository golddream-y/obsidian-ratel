/**
 * @file tests/core/context-manager-usage.test.ts
 * @description ContextManager.getContextUsage() — 上下文使用率计算单测
 * @module tests/core/context-manager-usage
 * @depends core/context-manager
 */

import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session } from '../../src/ports/persistence';

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

describe('ContextManager.getContextUsage', () => {
	it('空会话 - usedTokens 仅含系统提示,percentage 按 maxTokens 计算', async () => {
		const ctx = new ContextManager(createMockPersistence());
		await ctx.load('s1');
		const usage = ctx.getContextUsage(32000);
		expect(usage.maxTokens).toBe(32000);
		expect(usage.usedTokens).toBeGreaterThan(0);
		expect(usage.percentage).toBe(Math.round((usage.usedTokens / 32000) * 100));
	});

	it('maxTokens=0 - percentage 防除零返回 0', async () => {
		const ctx = new ContextManager(createMockPersistence());
		await ctx.load('s1');
		const usage = ctx.getContextUsage(0);
		expect(usage.percentage).toBe(0);
	});

	it('历史消息累积 - usedTokens 随消息增加而增加', async () => {
		const ctx = new ContextManager(createMockPersistence());
		await ctx.load('s1');
		const before = ctx.getContextUsage(32000).usedTokens;
		ctx.addUserMessage('A'.repeat(400));
		const after = ctx.getContextUsage(32000).usedTokens;
		expect(after).toBeGreaterThan(before);
	});

	it('attachmentTokens 透传 - 加在 usedTokens 外,percentage 含附件', async () => {
		const ctx = new ContextManager(createMockPersistence());
		await ctx.load('s1');
		const usage = ctx.getContextUsage(32000, 374);
		expect(usage.attachmentTokens).toBe(374);
		// percentage = (used + attachment) / max * 100
		expect(usage.percentage).toBe(Math.round(((usage.usedTokens + 374) / 32000) * 100));
	});

	it('rag 意图 - usedTokens 包含 RAG 系统提示(比 direct 长)', async () => {
		const ctx = new ContextManager(createMockPersistence());
		await ctx.load('s1');
		const direct = ctx.getContextUsage(32000, 0, 'direct').usedTokens;
		const rag = ctx.getContextUsage(32000, 0, 'rag').usedTokens;
		expect(rag).toBeGreaterThan(direct);
	});

	it('getContextUsage - 中文文本 - 用 estimateTokens 而非 length/4', async () => {
		// 关键路径:增量测试,避免系统提示词干扰。6 个 CJK 按 estimateTokens = 6/1.5 = 4;
		// 旧算法 length/4 会给出 6/4=1.5→ceil=2。
		const ctx = new ContextManager(createMockPersistence());
		await ctx.load('s1');
		const before = ctx.getContextUsage(1000, 0, 'direct').usedTokens;
		ctx.addUserMessage('你好世界测试'); // 6 个 CJK
		const after = ctx.getContextUsage(1000, 0, 'direct').usedTokens;
		expect(after - before).toBe(4);
	});
});
