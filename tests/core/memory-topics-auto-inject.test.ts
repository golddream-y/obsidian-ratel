/**
 * @file tests/core/memory-topics-auto-inject.test.ts
 * @description topics 自动注入测试 — 验证 setMemoryContext 分层参数经 injector 进入 system 消息(S-SR-LAYERING Task 3)
 * @module tests/core/memory-topics-auto-inject
 * @depends core/context-manager, prompts/composer
 */

import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';

/** 最小 deps 桩 — getOverrides/getTools 返回空,记忆段直接由 setMemoryContext 决定 */
function makeCtx(): ContextManager {
	return new ContextManager(
		{
			sessions: {
				get: async () => undefined,
				upsert: async () => undefined,
				delete: async () => undefined,
			},
		} as never,
		{ getOverrides: () => ({}), getTools: () => [] },
		// 关键路径:第 3 参 maxHistoryTokens 必传(来自 tailBudget;测试给固定小值即可)
		206_400,
	);
}

describe('setMemoryContext 分层参数', () => {
	it('传 layering - relatedTopics 块进入 system 消息', () => {
		const ctx = makeCtx();
		ctx.setMemoryContext('## 偏好\n- a', [], {}, {
			injectLimitBytes: 20 * 1024,
			totalLimitBytes: 64 * 1024,
			relatedTopics: [{ name: 'obsidian', summary: '偏好' }],
		});
		const msgs = ctx.toMessages('direct');
		const memoryMsg = msgs.find((m) => m.content.includes('关于用户的已知信息'));
		expect(memoryMsg).toBeDefined();
		expect(memoryMsg!.content).toContain('obsidian');
	});

	it('不传 layering - 兼容旧行为', () => {
		const ctx = makeCtx();
		ctx.setMemoryContext('## 偏好\n- a', [], {});
		const msgs = ctx.toMessages('direct');
		expect(msgs.some((m) => m.content.includes('## 偏好'))).toBe(true);
	});
});
