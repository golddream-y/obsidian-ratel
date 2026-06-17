/**
 * @file tests/core/context-manager-search.test.ts
 * @description ContextManager 检索相关行为的回归测试。
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

describe('ContextManager search context', () => {
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
