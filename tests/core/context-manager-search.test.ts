/**
 * @file tests/core/context-manager-search.test.ts
 * @description ContextManager.addSearchResults 单元测试
 * @module tests/core/context-manager-search
 * @depends ../../src/core/context-manager, ../../src/ports/persistence
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

describe('ContextManager.addSearchResults', () => {
	it('addSearchResults - 空数组 - 不修改 messages', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('hello');
		ctx.addSearchResults([]);

		const msgs = ctx.toMessages();
		expect(msgs).toHaveLength(2);
		expect(msgs[0]!.role).toBe('system');
		expect(msgs[1]!.role).toBe('user');
	});

	it('addSearchResults - 有结果 - 插入 system 之后 user 之前', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('项目用什么技术栈?');
		ctx.addSearchResults([
			{ path: 'notes/project.md', content: '项目使用 TypeScript + esbuild 构建。' },
		]);

		const msgs = ctx.toMessages();
		expect(msgs).toHaveLength(3);
		expect(msgs[0]!.role).toBe('system');
		expect(msgs[1]!.role).toBe('system');
		expect(msgs[1]!.content).toContain('知识库检索结果');
		expect(msgs[1]!.content).toContain('notes/project.md');
		expect(msgs[2]!.role).toBe('user');
	});

	it('addSearchResults - 多次调用 - 追加不覆盖', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('session-1');
		ctx.addUserMessage('Q');
		ctx.addSearchResults([{ path: 'a.md', content: 'A' }]);
		ctx.addSearchResults([{ path: 'b.md', content: 'B' }]);

		const systemMsgs = ctx.toMessages().filter((m) => m.role === 'system');
		expect(systemMsgs).toHaveLength(3); // base + 2 search results
	});

	it('addSearchResults - 切换会话 - 不保留旧会话检索结果', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		await ctx.load('session-1');
		ctx.addUserMessage('Q');
		ctx.addSearchResults([{ path: 'a.md', content: 'A' }]);

		await ctx.load('session-2');
		ctx.addUserMessage('Q2');

		const msgs = ctx.toMessages();
		expect(msgs).toHaveLength(2);
		expect(msgs[0]!.role).toBe('system');
		expect(msgs[1]!.role).toBe('user');
	});
});
