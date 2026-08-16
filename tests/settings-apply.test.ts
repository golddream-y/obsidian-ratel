/**
 * @file tests/settings-apply.test.ts
 * @description applySettingValue 共享设置应用逻辑单测(从 settings.declarative.test.ts 迁移写入/副作用类用例)
 * @module tests/settings-apply
 */

import { describe, it, expect, vi } from 'vitest';
import { applySettingValue } from '../src/settings/settings-apply';
import { DEFAULT_SETTINGS, type RatelVaultSettings } from '../src/settings';

// 关键路径:mock 最小宿主 — settings + 三个副作用回调;
// vi.fn<() => void>() 显式签名使其可赋给 SettingApplier 的回调类型
function mockApplier() {
	return {
		settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as RatelVaultSettings,
		rebuildLLM: vi.fn<() => void>(),
		rebuildEmbeddingAdapter: vi.fn<() => void>(),
		syncToolDefinitions: vi.fn<() => void>(),
	};
}

describe('applySettingValue', () => {
	it('嵌套 toolPermissions key - 写入嵌套对象而非字面量字段', () => {
		const p = mockApplier();
		applySettingValue(p, 'toolPermissions.search_vault', 'allow');
		expect(p.settings.toolPermissions.search_vault).toBe('allow');
		expect(
			(p.settings as unknown as Record<string, unknown>)['toolPermissions.search_vault'],
		).toBeUndefined();
	});

	it('嵌套 promptOverrides key - 写入嵌套对象并触发 syncToolDefinitions', () => {
		const p = mockApplier();
		applySettingValue(p, 'promptOverrides.system.role', 'custom text');
		expect((p.settings.promptOverrides as Record<string, string | undefined>)['system.role']).toBe('custom text');
		expect(p.syncToolDefinitions).toHaveBeenCalledTimes(1);
	});

	it('chatModel 变更 - preset 切 custom 并 rebuildLLM', () => {
		const p = mockApplier();
		p.settings.chatPreset = 'deepseek';
		applySettingValue(p, 'chatModel', 'gpt-4');
		expect(p.settings.chatModel).toBe('gpt-4');
		expect(p.settings.chatPreset).toBe('custom');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('chatApiBase 变更 - preset 切 custom 并 rebuildLLM', () => {
		const p = mockApplier();
		p.settings.chatPreset = 'deepseek';
		applySettingValue(p, 'chatApiBase', 'https://example.com/v1');
		expect(p.settings.chatPreset).toBe('custom');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('embedApiBase 变更 - 触发 rebuildEmbeddingAdapter', () => {
		const p = mockApplier();
		applySettingValue(p, 'embedApiBase', 'http://new:11434/v1');
		expect(p.rebuildEmbeddingAdapter).toHaveBeenCalledTimes(1);
	});

	it('embedLocalModel 变更 - 不触发 rebuildEmbeddingAdapter', () => {
		const p = mockApplier();
		applySettingValue(p, 'embedLocalModel', 'Xenova/other');
		expect(p.rebuildEmbeddingAdapter).not.toHaveBeenCalled();
	});

	it('chatPreset deepseek - 写入多字段并 rebuildLLM', () => {
		const p = mockApplier();
		p.settings.chatModel = 'other';
		p.settings.chatApiBase = 'https://example.com';
		applySettingValue(p, 'chatPreset', 'deepseek');
		expect(p.settings.chatPreset).toBe('deepseek');
		expect(p.settings.chatModel).toBe('deepseek-v4-flash');
		expect(p.settings.chatApiBase).toBe('https://api.deepseek.com');
		expect(p.rebuildLLM).toHaveBeenCalledTimes(1);
	});

	it('contextLengthPreset 变更 - 同步 chatModelMaxTokens', () => {
		const p = mockApplier();
		// 关键路径:默认 preset 是 256k,选 128k 才能验证「变更」而非「写入原值」
		applySettingValue(p, 'contextLengthPreset', '128k');
		expect(p.settings.contextLengthPreset).toBe('128k');
		expect(p.settings.chatModelMaxTokens).toBe(128_000);
	});

	it('toolPermissionLevel 非法值 - 不写入', () => {
		const p = mockApplier();
		const before = p.settings.toolPermissionLevel;
		applySettingValue(p, 'toolPermissionLevel', 'yolo');
		expect(p.settings.toolPermissionLevel).toBe(before);
	});

	it('顶层普通 key - 直接写入', () => {
		const p = mockApplier();
		applySettingValue(p, 'chunkSize', 800);
		expect(p.settings.chunkSize).toBe(800);
	});
});
