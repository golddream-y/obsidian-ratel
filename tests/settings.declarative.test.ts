/**
 * @file tests/settings.declarative.test.ts
 * @description 声明式 SettingTab 的 getControlValue 嵌套 key 读取与 getSettingDefinitions 渲染测试(写入/副作用用例已迁至 settings-apply.test.ts)
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

describe('RatelVaultSettingTab 嵌套 key 读取与声明式定义', () => {
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

// 关键路径:open_settings 工具参数来自 LLM 不可信输入,focusTab 三分支契约必须测试锁定
describe('RatelVaultSettingTab focusTab 三分支契约', () => {
	let plugin: RatelVaultPlugin;
	let tab: RatelVaultSettingTab;

	beforeEach(() => {
		plugin = makeMockPlugin(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
		tab = new RatelVaultSettingTab({} as App, plugin);
	});

	it('focusTab - 非法 tab - 返回 false 且当前 tab 不变', () => {
		setActiveTab(tab, 'agent');
		const ok = tab.focusTab('not-a-tab');
		expect(ok).toBe(false);
		expect(getActiveTab(tab)).toBe('agent');
	});

	it('focusTab - 省略 tab - 返回 true 且当前 tab 不变', () => {
		setActiveTab(tab, 'index');
		const ok = tab.focusTab();
		expect(ok).toBe(true);
		expect(getActiveTab(tab)).toBe('index');
	});

	it('focusTab - 合法 tab - 返回 true 且切换 activeSettingsTab', () => {
		setActiveTab(tab, 'chat');
		const ok = tab.focusTab('agent');
		expect(ok).toBe(true);
		expect(getActiveTab(tab)).toBe('agent');
		// 关键路径:visible 谓词断言真实门控行为,而非仅读私有字段
		const group = findGroupWithControlKey(
			tab.getSettingDefinitions(),
			'toolPermissions.search_vault',
		);
		expect(group).toBeDefined();
		expect((group!.visible as () => boolean)()).toBe(true);
	});
});

/** 测试用:写入私有 activeSettingsTab */
function setActiveTab(tab: RatelVaultSettingTab, id: string): void {
	(tab as unknown as { activeSettingsTab: string }).activeSettingsTab = id;
}

/** 测试用:读取私有 activeSettingsTab */
function getActiveTab(tab: RatelVaultSettingTab): string {
	return (tab as unknown as { activeSettingsTab: string }).activeSettingsTab;
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
