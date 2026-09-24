/**
 * @file src/ui/tokens/apply-model-context.ts
 * @description 换模型时按映射表写上下文上限 — 设置与多配置切换共用
 * @module ui/tokens/apply-model-context
 * @depends ./model-context-registry, ./context-length-presets
 */

import { applyContextRecommendation } from './context-length-presets';
import type { ContextLengthPresetId } from './context-length-presets';

/** 写入目标 — 当前 settings 或某一套 profile,结构一致即可 */
export type ModelContextTarget = {
	contextLengthPreset: ContextLengthPresetId;
	chatModelMaxTokens: number;
};

/** 映射表最小接口 — 与 ModelContextRegistry 结构兼容,测试用 mock */
export type ModelContextLookup = {
	ensureRegistry(url: string): Promise<unknown>;
	lookupContextLength(model: string, map: unknown): number | undefined;
};

/**
 * 按模型名查映射表并写入上限。查不到保留旧值,由调用方决定是否提示。
 *
 * @param deps.model - 模型标识
 * @param deps.registry - 映射表注册中心
 * @param deps.registryUrl - 映射表 URL(空串时调用方传默认)
 * @param deps.settings - 写入目标(当前 settings 或一套 profile)
 * @returns applied=true 且带 tokens 表示已写入;applied=false 表示未命中
 */
export async function applyModelContextWindow(deps: {
	model: string;
	registry: ModelContextLookup;
	registryUrl: string;
	settings: ModelContextTarget;
}): Promise<{ applied: boolean; tokens?: number }> {
	const map = await deps.registry.ensureRegistry(deps.registryUrl);
	const tokens = map != null ? deps.registry.lookupContextLength(deps.model, map) : undefined;
	if (tokens == null) return { applied: false };
	const applied = applyContextRecommendation(tokens);
	deps.settings.contextLengthPreset = applied.preset;
	deps.settings.chatModelMaxTokens = applied.chatModelMaxTokens;
	return { applied: true, tokens };
}
