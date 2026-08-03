/**
 * @file tests/ui/tokens/context-length-presets.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
	presetToTokens,
	tokensToPreset,
	applyContextRecommendation,
	applyContextLengthPreset,
} from '../../../src/ui/tokens/context-length-presets';

describe('context-length-presets', () => {
	it('presetToTokens - 256k', () => {
		expect(presetToTokens('256k')).toBe(256_000);
	});

	it('tokensToPreset - 精确命中 128k', () => {
		expect(tokensToPreset(128_000)).toBe('128k');
	});

	it('tokensToPreset - 非预设值返回 custom', () => {
		expect(tokensToPreset(131_072)).toBe('custom');
	});

	it('applyContextRecommendation - 131072 映射为 custom', () => {
		const r = applyContextRecommendation(131_072);
		expect(r.preset).toBe('custom');
		expect(r.chatModelMaxTokens).toBe(131_072);
	});

	it('applyContextRecommendation - 200000 映射为 200k', () => {
		const r = applyContextRecommendation(200_000);
		expect(r.preset).toBe('200k');
		expect(r.chatModelMaxTokens).toBe(200_000);
	});

	it('applyContextLengthPreset - 切到 1M - 同步写入 chatModelMaxTokens', () => {
		const s = { contextLengthPreset: '256k' as const, chatModelMaxTokens: 256_000 };
		applyContextLengthPreset(s, '1M');
		expect(s.contextLengthPreset).toBe('1M');
		expect(s.chatModelMaxTokens).toBe(1_048_576);
	});

	it('applyContextLengthPreset - 切到 custom - 保留当前 token 数', () => {
		const s = { contextLengthPreset: '256k' as const, chatModelMaxTokens: 256_000 };
		applyContextLengthPreset(s, 'custom');
		expect(s.contextLengthPreset).toBe('custom');
		expect(s.chatModelMaxTokens).toBe(256_000);
	});
});
