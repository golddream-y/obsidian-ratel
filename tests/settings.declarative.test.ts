/**
 * @file tests/settings.declarative.test.ts
 * @description 声明式 SettingTab 的 getControlValue 嵌套 key 读取与 getSettingDefinitions 渲染测试(写入/副作用用例已迁至 settings-apply.test.ts)
 * @module tests/settings.declarative
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from 'obsidian';
import { RatelVaultSettingTab, DEFAULT_SETTINGS } from '../src/settings';
import { setLang, tNow } from '../src/i18n';
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

	it('getSettingDefinitions - 对话组保留 chatProfiles render - 场景预设/模型名/地址/窗口不再单独成控件', () => {
		const defs = tab.getSettingDefinitions();
		expect(defs.length).toBeGreaterThan(0);
		const json = JSON.stringify(defs);
		// S-CHAT-SETUP:上述字段由「已保存的配置」展开区(render 回调)承接,不再有独立 control key
		expect(json).not.toContain('"chatPreset"');
		expect(json).not.toContain('"chatModel"');
		expect(json).not.toContain('"chatApiBase"');
		expect(json).not.toContain('"contextLengthPreset"');
		expect(json).not.toContain('"chatModelMaxTokens"');
		expect(json).toContain('toolPermissions.');
	});

	it('getSettingDefinitions - agent Tab - 工具权限收进二级页:入口可见、主页组不再有控件', () => {
		setActiveTab(tab, 'agent');
		const defs = tab.getSettingDefinitions();
		const page = findPageWithControlKey(defs, 'toolPermissions.search_vault');
		expect(page).toBeDefined();
		// S-CHAT-SETUP CS-07:工具权限组从「记忆与权限」主页搬进二级页,主页只留入口
		expect(findGroupWithControlKey(defs, 'toolPermissions.search_vault')).toBeUndefined();
		expect(typeof page!.visible).toBe('function');
		expect((page!.visible as () => boolean)()).toBe(true);
		// 关键路径:页内字段不减 — 权限档位下拉仍在(每个工具允许/询问/拒绝)
		const level = findControlByKey(defs, 'toolPermissionLevel');
		expect(level).toBeDefined();
	});

	it('getSettingDefinitions - chat Tab 时 - 工具权限二级页 visible 为 false(仍在定义中)', () => {
		setActiveTab(tab, 'chat');
		const page = findPageWithControlKey(tab.getSettingDefinitions(), 'toolPermissions.search_vault');
		expect(page).toBeDefined();
		// 关键路径:用 visible 谓词门控;定义始终返回,搜索激活时 visible 变 true
		expect(typeof page!.visible).toBe('function');
		expect((page!.visible as () => boolean)()).toBe(false);
	});

	it('getSettingDefinitions - agent Tab - 目标/记忆开关/日记/库外留在主页,不进二级页', () => {
		setActiveTab(tab, 'agent');
		const defs = tab.getSettingDefinitions();
		for (const key of ['goalMaxRounds', 'memoryEnabled', 'memoryAutoWrite', 'dailyNoteFolder', 'hostAccessEnabled']) {
			expect(findGroupWithControlKey(defs, key), `${key} 应留在记忆与权限主页 group`).toBeDefined();
		}
	});

	it('getSettingDefinitions - advanced Tab - 映射表/生态/记忆上限/开发者各自二级页可见,主页组不再有这些控件', () => {
		setActiveTab(tab, 'advanced');
		const defs = tab.getSettingDefinitions();
		for (const key of ['modelRegistryUrl', 'ecosystemWriteEnabled', 'memoryStorageLimitMB', 'debugLog']) {
			const page = findPageWithControlKey(defs, key);
			expect(page, `${key} 应收进二级页`).toBeDefined();
			expect((page!.visible as () => boolean)()).toBe(true);
		}
		// 提示词覆盖页的 items 全是 render 行,没有 control key,按页名识别入口
		// 关键路径:union 上先 cast 再访问 type(既有 findControlByKey 同款访问方式)
		const promptPage = defs.find(
			(d) =>
				(d as { type?: string }).type === 'page' &&
				(d as { name?: string }).name === tNow('settings.promptOverrides.page.name'),
		);
		expect(promptPage).toBeDefined();
		// S-CHAT-SETUP CS-05/CS-07:高级主页不再铺这些控件
		for (const key of [
			'modelRegistryUrl',
			'ecosystemWriteEnabled',
			'memoryStorageLimitMB',
			'memoryInjectLimitKB',
			'memoryDynamicLimitKB',
			'memoryContextTotalLimitKB',
			'memoryTopicsAutoInjectK',
			'debugLog',
			'crashBreadcrumbs',
			'agentMaxSteps',
			'skillScriptTimeout',
		]) {
			expect(findGroupWithControlKey(defs, key), `${key} 不应留在高级主页 group`).toBeUndefined();
		}
	});

	it('getSettingDefinitions - agent Tab 时 - 高级二级页入口 visible 为 false', () => {
		setActiveTab(tab, 'agent');
		const page = findPageWithControlKey(tab.getSettingDefinitions(), 'modelRegistryUrl');
		expect(page).toBeDefined();
		expect((page!.visible as () => boolean)()).toBe(false);
	});

	it('getSettingDefinitions - advanced Tab - 诊断 page 仍走 imperative 工厂且可见', () => {
		setActiveTab(tab, 'advanced');
		const page = findDiagnosticsPage(tab.getSettingDefinitions());
		expect(page).toBeDefined();
		expect(typeof (page as { page?: unknown }).page).toBe('function');
		expect(typeof page!.visible).toBe('function');
		expect((page!.visible as () => boolean)()).toBe(true);
	});

	it('getSettingDefinitions - chat Tab 时 - 诊断 page visible 为 false', () => {
		setActiveTab(tab, 'chat');
		const page = findDiagnosticsPage(tab.getSettingDefinitions());
		expect(page).toBeDefined();
		expect((page!.visible as () => boolean)()).toBe(false);
	});

	it('getSettingDefinitions - advanced Tab - skillScriptTimeout slider 绑 ms 且 displayFormat 显示秒', () => {
		setLang('zh');
		setActiveTab(tab, 'advanced');
		const control = findControlByKey(tab.getSettingDefinitions(), 'skillScriptTimeout') as {
			type: string;
			min: number;
			max: number;
			step: number;
			displayFormat?: (value: number) => string;
		};
		expect(control).toBeDefined();
		expect(control.type).toBe('slider');
		// 关键路径:存储单位是 ms(默认 30_000),滑块范围 5s-120s、步进 5s
		expect(control.min).toBe(5000);
		expect(control.max).toBe(120000);
		expect(control.step).toBe(5000);
		// 关键路径:displayFormat 把 ms 换算为秒显示(用户心智单位),随当前语言出单位文案
		expect(typeof control.displayFormat).toBe('function');
		expect(control.displayFormat!(30_000)).toBe('30 秒');
		expect(control.displayFormat!(5000)).toBe('5 秒');
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
		const page = findPageWithControlKey(
			tab.getSettingDefinitions(),
			'toolPermissions.search_vault',
		);
		expect(page).toBeDefined();
		expect((page!.visible as () => boolean)()).toBe(true);
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

/** 在声明式定义中查找含指定 control.key 的 item 的 control 对象(主页 group 与二级页 items 都搜) */
function findControlByKey(
	defs: ReturnType<RatelVaultSettingTab['getSettingDefinitions']>,
	key: string,
): { type?: string; key?: string } | undefined {
	for (const d of defs) {
		// 关键路径:SettingDefinitionItem 是 union,普通 item 无 type/items 字段;
		// cast 为宽松形状绕过窄化(既有 findGroupWithControlKey 同款访问方式)
		const def = d as { type?: string; items?: Array<{ control?: { key?: string } }> };
		if (def.type !== 'group' && def.type !== 'list' && def.type !== 'page') {
			continue;
		}
		for (const item of def.items ?? []) {
			if (item.control?.key === key) {
				return item.control as { type?: string; key?: string };
			}
		}
	}
	return undefined;
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

/** 在声明式定义的二级页(type: 'page')items 中查找含指定 control.key 的 page */
function findPageWithControlKey(
	defs: ReturnType<RatelVaultSettingTab['getSettingDefinitions']>,
	key: string,
): { visible?: unknown; items?: Array<{ control?: { key?: string } }> } | undefined {
	for (const d of defs) {
		// 关键路径:SettingDefinitionItem 是 union,先 cast 再访问 type/items(既有 findControlByKey 同款)
		const page = d as { type?: string; visible?: unknown; items?: Array<{ control?: { key?: string } }> };
		if (page.type !== 'page') {
			continue;
		}
		for (const item of page.items ?? []) {
			if (item.control?.key === key) {
				return page;
			}
		}
	}
	return undefined;
}

/** 查找诊断二级页 — 唯一带 imperative page 工厂的那个(区别于 items 声明式子页) */
function findDiagnosticsPage(
	defs: ReturnType<RatelVaultSettingTab['getSettingDefinitions']>,
): { visible?: unknown; page?: unknown } | undefined {
	// 关键路径:union 上先 cast 再访问 type(既有 findControlByKey 同款访问方式)
	return defs.find(
		(d) =>
			(d as { type?: string }).type === 'page' &&
			typeof (d as { page?: unknown }).page === 'function',
	) as { visible?: unknown; page?: unknown } | undefined;
}
