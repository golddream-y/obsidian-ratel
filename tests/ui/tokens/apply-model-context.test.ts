/**
 * @file tests/ui/tokens/apply-model-context.test.ts
 * @description 换模型更新上下文上限 — 查到写入,查不到保留并报未命中
 * @module tests/ui/tokens/apply-model-context
 */
import { describe, it, expect } from 'vitest';
import { applyModelContextWindow } from '../../../src/ui/tokens/apply-model-context';

function fakeRegistry(hit: number | undefined) {
	return {
		ensureRegistry: async () => ({}),
		lookupContextLength: () => hit,
	};
}

describe('applyModelContextWindow', () => {
	it('映射表命中 - 写入推荐上限', async () => {
		const settings = { contextLengthPreset: '256k' as const, chatModelMaxTokens: 256_000 };
		const result = await applyModelContextWindow({
			model: 'deepseek-v4-flash',
			registry: fakeRegistry(128_000),
			registryUrl: 'http://test/registry.json',
			settings,
		});
		expect(result).toEqual({ applied: true, tokens: 128_000 });
		expect(settings.chatModelMaxTokens).toBe(128_000);
		expect(settings.contextLengthPreset).toBe('128k');
	});

	it('映射表未命中 - 保留旧值并报未命中', async () => {
		const settings = { contextLengthPreset: '256k' as const, chatModelMaxTokens: 256_000 };
		const result = await applyModelContextWindow({
			model: 'unknown-model',
			registry: fakeRegistry(undefined),
			registryUrl: 'http://test/registry.json',
			settings,
		});
		expect(result).toEqual({ applied: false });
		expect(settings.chatModelMaxTokens).toBe(256_000);
	});
});
