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

	it('setControlValue - chatPreset deepseek - 写入多字段并 rebuildLLM', async () => {
		plugin.settings.chatModel = 'other';
		plugin.settings.chatApiBase = 'https://example.com';
		await tab.setControlValue('chatPreset', 'deepseek');
		expect(plugin.settings.chatPreset).toBe('deepseek');
		expect(plugin.settings.chatModel).toBe('deepseek-v4-flash');
		expect(plugin.settings.chatApiBase).toBe('https://api.deepseek.com');
		expect(plugin.rebuildLLM).toHaveBeenCalled();
	});

	it('setControlValue - 手改 chatModel - chatPreset 变为 custom', async () => {
		plugin.settings.chatPreset = 'deepseek';
		await tab.setControlValue('chatModel', 'gpt-4');
		expect(plugin.settings.chatPreset).toBe('custom');
	});

	it('setControlValue - 手改 chatApiBase - chatPreset 变为 custom', async () => {
		plugin.settings.chatPreset = 'deepseek';
		await tab.setControlValue('chatApiBase', 'https://example.com/v1');
		expect(plugin.settings.chatPreset).toBe('custom');
		expect(plugin.rebuildLLM).toHaveBeenCalled();
	});

	it('getSettingDefinitions - 含四 Tab 与 chatPreset key - 非空', () => {
		const defs = tab.getSettingDefinitions();
		expect(defs.length).toBeGreaterThan(0);
		const json = JSON.stringify(defs);
		expect(json).toContain('chatPreset');
		expect(json).toContain('chatModel');
		expect(json).toContain('toolPermissions.');
	});

	it('getSettingDefinitions - agent Tab - 工具权限组可见且无 is-hidden', () => {
		setActiveTab(tab, 'agent');
		const group = findGroupWithControlKey(tab.getSettingDefinitions(), 'toolPermissions.search_vault');
		expect(group).toBeDefined();
		expect(group!.cls).toContain('ratel-settings-panel-agent');
		expect(group!.cls).not.toContain('is-hidden');
		expect(typeof group!.visible).toBe('function');
		expect((group!.visible as () => boolean)()).toBe(true);
	});

	it('getSettingDefinitions - chat Tab 时 - 工具权限组 visible 为 false(仍在定义中)', () => {
		setActiveTab(tab, 'chat');
		const group = findGroupWithControlKey(tab.getSettingDefinitions(), 'toolPermissions.search_vault');
		expect(group).toBeDefined();
		expect(group!.cls).toContain('ratel-settings-panel-agent');
		expect(group!.cls).not.toContain('is-hidden');
		// 关键路径:用 visible 谓词门控;定义始终返回,搜索激活时 visible 变 true
		expect(typeof group!.visible).toBe('function');
		expect((group!.visible as () => boolean)()).toBe(false);
	});

	it('getSettingDefinitions - advanced Tab - 含诊断 page 且可见', () => {
		setActiveTab(tab, 'advanced');
		const page = tab.getSettingDefinitions().find((d) => d.type === 'page');
		expect(page).toBeDefined();
		expect(typeof page!.visible).toBe('function');
		expect((page!.visible as () => boolean)()).toBe(true);
	});

	it('getSettingDefinitions - chat Tab 时 - 诊断 page visible 为 false', () => {
		setActiveTab(tab, 'chat');
		const page = tab.getSettingDefinitions().find((d) => d.type === 'page');
		expect(page).toBeDefined();
		expect((page!.visible as () => boolean)()).toBe(false);
	});
});

/** 测试用:写入私有 activeSettingsTab */
function setActiveTab(tab: RatelVaultSettingTab, id: string): void {
	(tab as unknown as { activeSettingsTab: string }).activeSettingsTab = id;
}

/** 在声明式定义中查找含指定 control.key 的 group */
function findGroupWithControlKey(
	defs: ReturnType<RatelVaultSettingTab['getSettingDefinitions']>,
	key: string,
): { cls?: string; visible?: unknown } | undefined {
	for (const d of defs) {
		if (d.type !== 'group' && d.type !== 'list') {
			continue;
		}
		const items = d.items ?? [];
		for (const item of items) {
			const control = (item as { control?: { key?: string } }).control;
			if (control?.key === key) {
				return d as { cls?: string; visible?: unknown };
			}
		}
	}
	return undefined;
}
