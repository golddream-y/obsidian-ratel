/**
 * @file tests/core/preloaded-context.test.ts
 * @description ask 是否复用预加载 ctx — 纯函数，不启动 Plugin
 * @module tests/core/preloaded-context
 */

import { describe, it, expect } from 'vitest';
import {
	reloadPreloadedContextAfterCompact,
	shouldReusePreloadedContext,
} from '../../src/core/preloaded-context';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session } from '../../src/ports/persistence';

function createCtx(persistence: Persistence) {
	return new ContextManager(persistence, {
		getOverrides: () => ({}),
		getTools: () => [],
	});
}

function createMockPersistence(sessions: Map<string, Session> = new Map()): Persistence {
	return {
		sessions: {
			// 关键路径:模拟 sessions/*.json 往返 — get/upsert 都 clone,两份 ContextManager 不共享引用
			get: async (id: string) => {
				const s = sessions.get(id);
				return s ? structuredClone(s) : null;
			},
			upsert: async (session: Session) => {
				sessions.set(session.id, structuredClone(session));
			},
			list: async () => Array.from(sessions.values()),
			delete: async (id: string) => {
				sessions.delete(id);
			},
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

describe('shouldReusePreloadedContext', () => {
	it('shouldReusePreloadedContext - sessionId 相同 - 复用', () => {
		expect(shouldReusePreloadedContext({ sessionId: 's1' }, 's1')).toBe(true);
	});
	it('shouldReusePreloadedContext - sessionId 不同或缺失 - 不复用', () => {
		expect(shouldReusePreloadedContext({ sessionId: 's1' }, 's2')).toBe(false);
		expect(shouldReusePreloadedContext(undefined, 's1')).toBe(false);
		expect(shouldReusePreloadedContext({ sessionId: '' }, 's1')).toBe(false);
	});
});

describe('reloadPreloadedContextAfterCompact', () => {
	it('load - 另一实例已 compact 后同 id 再 load - 看不到 marker', async () => {
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
		const preCtx = createCtx(persistence);
		await preCtx.load('s1');

		const compactCtx = createCtx(persistence);
		await compactCtx.load('s1');
		await compactCtx.appendCompactMarker({
			afterIndex: 1,
			summary: '摘要',
			restoredNotePaths: [],
			at: Date.now(),
		});

		await preCtx.load('s1');
		expect(preCtx.getCompactMarkers()).toHaveLength(0);

		const reused = await reloadPreloadedContextAfterCompact(
			false,
			preCtx,
			() => createCtx(persistence),
			's1',
		);
		expect(reused).toBe(preCtx);
		expect(reused.getCompactMarkers()).toHaveLength(0);

		const fresh = await reloadPreloadedContextAfterCompact(
			true,
			preCtx,
			() => createCtx(persistence),
			's1',
		);
		expect(fresh).not.toBe(preCtx);
		expect(fresh.getCompactMarkers()).toHaveLength(1);
		expect(fresh.getCompactMarkers()[0]!.summary).toBe('摘要');
	});
});
