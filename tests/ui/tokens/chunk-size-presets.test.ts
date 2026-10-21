import { describe, it, expect } from 'vitest';
import {
	CHUNK_SIZE_MAX_TOKENS,
	CHUNK_SIZE_MIN_TOKENS,
	CHUNK_SIZE_PRESETS,
	applyChunkSizePreset,
	clampChunkSize,
	inferChunkSizePreset,
	normalizeChunkSizeSettings,
	presetToTokens,
	tokensToPreset,
} from '../../../src/ui/tokens/chunk-size-presets';

describe('chunk-size-presets', () => {
	it('档位 → 数字 — 粗粒度取上限,精细更小', () => {
		expect(presetToTokens('fine')).toBeLessThan(presetToTokens('balanced'));
		expect(presetToTokens('balanced')).toBeLessThan(presetToTokens('coarse'));
		expect(presetToTokens('coarse')).toBe(CHUNK_SIZE_MAX_TOKENS);
	});

	it('数字 → 档位 — 命中预设才归到该档,否则 custom', () => {
		expect(tokensToPreset(CHUNK_SIZE_PRESETS.fine)).toBe('fine');
		expect(tokensToPreset(CHUNK_SIZE_PRESETS.balanced)).toBe('balanced');
		expect(tokensToPreset(300)).toBe('custom');
	});

	it('钳制 — 超出区间落到边界,非数字回落默认档', () => {
		expect(clampChunkSize(10)).toBe(CHUNK_SIZE_MIN_TOKENS);
		expect(clampChunkSize(9999)).toBe(CHUNK_SIZE_MAX_TOKENS);
		expect(clampChunkSize(Number.NaN)).toBe(CHUNK_SIZE_PRESETS.balanced);
	});

	it('选档位 — 数字随档位走', () => {
		const settings = { chunkSizePreset: 'custom' as const, chunkSize: 200 };
		applyChunkSizePreset(settings, 'coarse');
		expect(settings.chunkSizePreset).toBe('coarse');
		expect(settings.chunkSize).toBe(CHUNK_SIZE_MAX_TOKENS);
	});

	it('选 custom — 只改标记,数字留在区间内', () => {
		const settings = { chunkSizePreset: 'coarse' as const, chunkSize: 200 };
		applyChunkSizePreset(settings, 'custom');
		expect(settings.chunkSizePreset).toBe('custom');
		expect(settings.chunkSize).toBe(200);
	});

	it('旧库迁移 — 超上限的旧值被钳回并反推档位', () => {
		const settings = { chunkSize: 500, chunkSizePreset: 'custom' as const };
		normalizeChunkSizeSettings(settings, undefined);
		expect(settings.chunkSize).toBe(CHUNK_SIZE_MAX_TOKENS);
		expect(settings.chunkSizePreset).toBe('coarse');
	});

	it('旧库迁移 — 已有档位字段时按值反推,不改用户选的自定义', () => {
		const settings = { chunkSize: 300, chunkSizePreset: 'custom' as const };
		normalizeChunkSizeSettings(settings, { chunkSizePreset: 'custom' });
		expect(settings.chunkSize).toBe(300);
		expect(settings.chunkSizePreset).toBe('custom');
	});

	it('推断 — 未设置时给默认档', () => {
		const inferred = inferChunkSizePreset(undefined);
		expect(inferred.preset).toBe('balanced');
		expect(inferred.chunkSize).toBe(CHUNK_SIZE_PRESETS.balanced);
	});
});
