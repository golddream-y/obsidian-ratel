/**
 * @file tests/ui/tokens/probe-model.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
vi.mock('obsidian', () => ({ requestUrl: mockRequestUrl }));

import { probeChatConnection } from '../../../src/ui/tokens/probe-model';
import type { ModelContextRegistry } from '../../../src/ui/tokens/model-context-registry';

function createRegistry(hit: number | undefined): ModelContextRegistry {
	return {
		ensureRegistry: vi.fn().mockResolvedValue(
			hit != null ? { 'deepseek-chat': { max_input_tokens: hit } } : {},
		),
		lookupContextLength: vi.fn((_model, reg) => reg['deepseek-chat']?.max_input_tokens),
	} as unknown as ModelContextRegistry;
}

describe('probeChatConnection', () => {
	beforeEach(() => mockRequestUrl.mockReset());

	it('401 - ok false', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 401, text: 'unauthorized' });
		const r = await probeChatConnection({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-bad',
			model: 'deepseek-chat',
			registry: createRegistry(131_072),
			registryUrl: 'https://example.com/map.json',
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain('401');
	});

	it('成功 + registry 命中', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		const r = await probeChatConnection({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
			registry: createRegistry(131_072),
			registryUrl: 'https://example.com/map.json',
		});
		expect(r).toEqual({ ok: true, recommendedTokens: 131_072, registryHit: true });
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.headers?.Authorization).toBe('Bearer sk-test');
	});

	it('成功 + registry 未命中', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		const registry = createRegistry(undefined);
		(registry.lookupContextLength as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
		const r = await probeChatConnection({
			apiBase: 'https://api.example.com',
			apiKey: 'sk-test',
			model: 'unknown',
			registry,
			registryUrl: 'https://example.com/map.json',
		});
		expect(r).toEqual({ ok: true, recommendedTokens: undefined, registryHit: false });
	});
});
