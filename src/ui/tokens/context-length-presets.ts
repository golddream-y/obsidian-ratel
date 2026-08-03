/**
 * @file src/ui/tokens/context-length-presets.ts
 * @description Context Length 预设常量与互转 — 见 ADR-007 / S-CONTEXT-WINDOW
 * @module ui/tokens/context-length-presets
 */

export type ContextLengthPresetId = '128k' | '200k' | '256k' | '1M' | 'custom';

export const CONTEXT_LENGTH_PRESETS = {
	'128k': 128_000,
	'200k': 200_000,
	'256k': 256_000,
	'1M': 1_048_576,
} as const;

export const DEFAULT_CONTEXT_LENGTH_PRESET: Exclude<ContextLengthPresetId, 'custom'> = '256k';

export const CUSTOM_TOKEN_MIN = 4_096;
export const CUSTOM_TOKEN_MAX = 10_485_760;

export function presetToTokens(id: Exclude<ContextLengthPresetId, 'custom'>): number {
	return CONTEXT_LENGTH_PRESETS[id];
}

export function tokensToPreset(tokens: number): ContextLengthPresetId {
	for (const [id, value] of Object.entries(CONTEXT_LENGTH_PRESETS)) {
		if (tokens === value) {
			return id as Exclude<ContextLengthPresetId, 'custom'>;
		}
	}
	return 'custom';
}

export function applyContextRecommendation(tokens: number): {
	preset: ContextLengthPresetId;
	chatModelMaxTokens: number;
} {
	const preset = tokensToPreset(tokens);
	return { preset, chatModelMaxTokens: tokens };
}

/**
 * 设置页下拉切换 Context Length 时同步写入 settings。
 *
 * @param settings - 可变 settings 片段
 * @param preset - 新的预设 id
 */
export function applyContextLengthPreset(
	settings: { contextLengthPreset: ContextLengthPresetId; chatModelMaxTokens: number },
	preset: ContextLengthPresetId,
): void {
	settings.contextLengthPreset = preset;
	// 关键路径:下拉只写 preset 时抽屉上限不更新 — 必须同步 token
	if (preset !== 'custom') {
		settings.chatModelMaxTokens = presetToTokens(preset);
	}
}

/**
 * 从 chatModelMaxTokens 推断 preset(用于 loadSettings 迁移)。
 */
export function inferPresetFromTokens(
	tokens: number | undefined,
): { preset: ContextLengthPresetId; chatModelMaxTokens: number } {
	if (tokens == null || tokens <= 0) {
		return {
			preset: DEFAULT_CONTEXT_LENGTH_PRESET,
			chatModelMaxTokens: presetToTokens(DEFAULT_CONTEXT_LENGTH_PRESET),
		};
	}
	const preset = tokensToPreset(tokens);
	return { preset, chatModelMaxTokens: tokens };
}
