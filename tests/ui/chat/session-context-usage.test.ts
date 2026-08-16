/**
 * @file tests/ui/chat/session-context-usage.test.ts
 * @description 会话上下文占用 — loadSessionContextUsage 投影与降级
 */

import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../../src/core/context-manager';
import { loadSessionContextUsage } from '../../../src/ui/chat/session-context-usage';
import type { Persistence, Session } from '../../../src/ports/persistence';

function createPersistence(sessions = new Map<string, Session>()): Persistence {
	return {
		sessions: {
			get: async (id) => sessions.get(id) ?? null,
			upsert: async (s) => { sessions.set(s.id, s); },
			list: async () => [],
			delete: async (id) => { sessions.delete(id); },
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

describe('loadSessionContextUsage', () => {
	it('loadSessionContextUsage - 有 compact marker - 低于 UI 全量估算', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: '旧问'.repeat(200) },
				{ role: 'assistant', content: '旧答'.repeat(200) },
				{ role: 'user', content: '新问' },
			],
			compactMarkers: [
				{ afterIndex: 1, summary: '摘要', restoredNotePaths: [], at: 1 },
			],
			createdAt: 0,
			updatedAt: 0,
		});
		const persistence = createPersistence(sessions);
		const inflatedFallback = 999_999;
		const patch = await loadSessionContextUsage(
			() => new ContextManager(persistence, undefined, 8000),
			's1',
			32_000,
			inflatedFallback,
		);
		expect(patch.usedTokens).toBeLessThan(inflatedFallback);
		expect(patch.source).toBe('estimate');
	});

	it('loadSessionContextUsage - createContext 失败 - 降级 fallback', async () => {
		const patch = await loadSessionContextUsage(
			() => {
				throw new Error('不可用');
			},
			's1',
			32_000,
			12_345,
		);
		expect(patch.usedTokens).toBe(12_345);
	});
});
