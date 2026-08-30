/**
 * @file tests/settings/settings-apply.test.ts
 * @description applySettingValue 副作用分发测试 — key 与 rebuild 副作用的映射契约
 * @module tests/settings/settings-apply
 * @depends settings/settings-apply, settings(类型)
 */
import { describe, it, expect, vi } from 'vitest';
import { applySettingValue, type SettingApplier } from '../../src/settings/settings-apply';
import { DEFAULT_SETTINGS } from '../../src/settings';

/** 构造带 spy 副作用的宿主替身 — 只覆盖接口所需成员 */
function makePlugin(): SettingApplier & {
	rebuildLLM: ReturnType<typeof vi.fn>;
	rebuildEmbeddingAdapter: ReturnType<typeof vi.fn>;
} {
	const plugin = {
		settings: structuredClone(DEFAULT_SETTINGS),
		rebuildLLM: vi.fn(),
		rebuildEmbeddingAdapter: vi.fn(),
		syncToolDefinitions: vi.fn(),
	};
	return plugin as unknown as typeof plugin;
}

describe('applySettingValue - LLM 相关副作用分发', () => {
	it('chatVisionEnabled 写入后触发 rebuildLLM - 开关即时生效', () => {
		const plugin = makePlugin();
		applySettingValue(plugin, 'chatVisionEnabled', true);
		expect(plugin.settings.chatVisionEnabled).toBe(true);
		expect(plugin.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('chatApiBase 改动仍走既有路径 - preset 置 custom 且 rebuildLLM', () => {
		const plugin = makePlugin();
		applySettingValue(plugin, 'chatApiBase', 'https://openrouter.ai/api/v1');
		expect(plugin.settings.chatPreset).toBe('custom');
		expect(plugin.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('无关 key 不误触 rebuild - debugLog 只写值', () => {
		const plugin = makePlugin();
		applySettingValue(plugin, 'debugLog', true);
		expect(plugin.rebuildLLM).not.toHaveBeenCalled();
		expect(plugin.rebuildEmbeddingAdapter).not.toHaveBeenCalled();
	});
});
