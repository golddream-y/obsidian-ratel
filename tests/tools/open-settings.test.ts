/**
 * @file tests/tools/open-settings.test.ts
 * @description open_settings 工具单测 — tab 白名单校验 / 省略默认 / 非法拒绝 / 打开失败降级
 * @module tests/tools/open-settings
 * @depends ../../src/tools/open-settings, ../helpers/make-tool-def
 */

import { describe, it, expect, vi } from 'vitest';
import { createOpenSettingsTool, VALID_TABS } from '../../src/tools/open-settings';
import { SETTINGS_UI_TABS } from '../../src/settings';
import { makeToolDef } from '../helpers/make-tool-def';
import type { WorkspacePort } from '../../src/ports/workspace';

function mockWorkspace(
	openPluginSettings = vi.fn().mockResolvedValue(true),
): WorkspacePort {
	return {
		getActiveFilePath: () => null,
		getActiveSelection: () => null,
		openNote: vi.fn(),
		openPluginSettings: openPluginSettings as WorkspacePort['openPluginSettings'],
	};
}

describe('open_settings', () => {
	it('合法 tab - 透传 openPluginSettings 且只读', async () => {
		const openPluginSettings = vi.fn().mockResolvedValue(true);
		const tool = createOpenSettingsTool(
			mockWorkspace(openPluginSettings),
			makeToolDef('open_settings'),
		);
		const result = (await tool.execute({ tab: 'advanced' })) as Record<string, unknown>;
		expect(openPluginSettings).toHaveBeenCalledWith('advanced');
		expect(result.opened).toBe(true);
		expect(result.tab).toBe('advanced');
		expect(tool.readOnly).toBe(true);
	});

	it('省略 tab - 传 undefined 并默认定位 chat', async () => {
		const openPluginSettings = vi.fn().mockResolvedValue(true);
		const tool = createOpenSettingsTool(
			mockWorkspace(openPluginSettings),
			makeToolDef('open_settings'),
		);
		const result = (await tool.execute({})) as Record<string, unknown>;
		expect(openPluginSettings).toHaveBeenCalledWith(undefined);
		expect(result.opened).toBe(true);
		expect(result.tab).toBe('chat');
	});

	it('非法 tab - 拒绝打开并提示合法值', async () => {
		const openPluginSettings = vi.fn();
		const tool = createOpenSettingsTool(
			mockWorkspace(openPluginSettings),
			makeToolDef('open_settings'),
		);
		const result = (await tool.execute({ tab: 'secrets' })) as Record<string, unknown>;
		expect(result.opened).toBe(false);
		expect(String(result.message)).toContain('chat');
		expect(String(result.message)).toContain('advanced');
		expect(openPluginSettings).not.toHaveBeenCalled();
	});

	it('tab 非字符串 - 按 undefined 处理不报错', async () => {
		const openPluginSettings = vi.fn().mockResolvedValue(true);
		const tool = createOpenSettingsTool(
			mockWorkspace(openPluginSettings),
			makeToolDef('open_settings'),
		);
		const result = (await tool.execute({ tab: 123 })) as Record<string, unknown>;
		expect(openPluginSettings).toHaveBeenCalledWith(undefined);
		expect(result.opened).toBe(true);
	});

	it('打开失败 - 返回 opened=false 与提示', async () => {
		const openPluginSettings = vi.fn().mockResolvedValue(false);
		const tool = createOpenSettingsTool(
			mockWorkspace(openPluginSettings),
			makeToolDef('open_settings'),
		);
		const result = (await tool.execute({ tab: 'agent' })) as Record<string, unknown>;
		expect(result.opened).toBe(false);
		expect(result.message).toBeTruthy();
		expect(result.tab).toBe('agent');
	});

	it('VALID_TABS - 与 SETTINGS_UI_TABS 对比 - 内容相等防白名单漂移', () => {
		expect([...VALID_TABS]).toEqual([...SETTINGS_UI_TABS]);
	});
});
