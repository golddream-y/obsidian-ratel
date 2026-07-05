/**
 * @file tests/settings.declarative.test.ts
 * @description 声明式 SettingTab 的 getControlValue / setControlValue 嵌套 key 行为测试
 * @module tests/settings.declarative
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { RatelVaultSettingTab, DEFAULT_SETTINGS } from '../src/settings';
import type RatelVaultPlugin from '../src/main';
import type { RatelVaultSettings } from '../src/settings';

// 关键路径:mock 最小 Plugin,只需 settings + saveSettings + rebuildLLM/rebuildEmbeddingAdapter/syncToolDefinitions
function makeMockPlugin(settings: RatelVaultSettings): RatelVaultPlugin {
	return {
		settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		rebuildLLM: vi.fn(),
		rebuildEmbeddingAdapter: vi.fn(),
		syncToolDefinitions: vi.fn(),
	} as unknown as RatelVaultPlugin;
}

describe('RatelVaultSettingTab 嵌套 key 读写', () => {
	let plugin: RatelVaultPlugin;
	let tab: RatelVaultSettingTab;

	beforeEach(() => {
		plugin = makeMockPlugin(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
		const app = {} as App;
		tab = new RatelVaultSettingTab(app, plugin);
	});

	it('getControlValue - 嵌套 toolPermissions key - 返回嵌套对象的值', () => {
		plugin.settings.toolPermissions.search_vault = 'deny';
		expect(tab.getControlValue('toolPermissions.search_vault')).toBe('deny');
	});

	it('getControlValue - 嵌套 promptOverrides key - 返回嵌套对象的值', () => {
		plugin.settings.promptOverrides['system.role'] = 'custom';
		expect(tab.getControlValue('promptOverrides.system.role')).toBe('custom');
	});

	it('getControlValue - 顶层 key - 返回直接字段', () => {
		plugin.settings.chatModel = 'claude-3-5-sonnet';
		expect(tab.getControlValue('chatModel')).toBe('claude-3-5-sonnet');
	});

	it('setControlValue - 嵌套 toolPermissions key - 写入嵌套对象', async () => {
		await tab.setControlValue('toolPermissions.search_vault', 'allow');
		expect(plugin.settings.toolPermissions.search_vault).toBe('allow');
		expect(
			(plugin.settings as unknown as Record<string, unknown>)['toolPermissions.search_vault'],
		).toBeUndefined();
	});

	it('setControlValue - 嵌套 promptOverrides key - 写入嵌套对象', async () => {
		await tab.setControlValue('promptOverrides.system.role', 'custom text');
		expect(plugin.settings.promptOverrides['system.role']).toBe('custom text');
	});

	it('setControlValue - 顶层 key - 写入直接字段', async () => {
		await tab.setControlValue('chatModel', 'gpt-4');
		expect(plugin.settings.chatModel).toBe('gpt-4');
	});

	it('setControlValue - chatModel 变更 - 触发 rebuildLLM', async () => {
		await tab.setControlValue('chatModel', 'gpt-4');
		expect(plugin.rebuildLLM).toHaveBeenCalled();
	});

	it('setControlValue - embedApiBase 变更 - 触发 rebuildEmbeddingAdapter', async () => {
		await tab.setControlValue('embedApiBase', 'http://new:11434/v1');
		expect(plugin.rebuildEmbeddingAdapter).toHaveBeenCalled();
	});

	it('setControlValue - embedLocalModel 变更 - 不触发 rebuildEmbeddingAdapter', async () => {
		await tab.setControlValue('embedLocalModel', 'Xenova/other');
		expect(plugin.rebuildEmbeddingAdapter).not.toHaveBeenCalled();
	});

	it('setControlValue - promptOverrides 变更 - 触发 syncToolDefinitions', async () => {
		await tab.setControlValue('promptOverrides.system.role', 'custom');
		expect(plugin.syncToolDefinitions).toHaveBeenCalled();
	});
});
