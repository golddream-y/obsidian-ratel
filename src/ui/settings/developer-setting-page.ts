/**
 * @file src/ui/settings/developer-setting-page.ts
 * @description 开发者二级页声明式定义 — 调试日志/崩溃记录/单轮最大步数/技能脚本超时
 * @module ui/settings/developer-setting-page
 * @depends obsidian, i18n
 */

import type { SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
import { tNow } from '../../i18n';

/**
 * 构建开发者二级页 — 控件从「高级」主页原样搬入(S-CHAT-SETUP CS-07)。
 *
 * 设计要点:
 * - 声明式 `items` 子页,返回按钮由设置框架自带
 * - skillScriptTimeout 滑块沿用 ms 存储 + displayFormat 秒显示,范围/步进与原主页一致
 *
 * @param isVisible - 入口 visible 谓词(由 SettingTab 按顶栏 Tab 态给出)
 * @returns 完整的 `SettingDefinitionPage` 定义
 */
export function buildDeveloperSettingPage(
	isVisible: () => boolean,
): SettingDefinitionPage {
	const items: SettingDefinitionItem[] = [
		{
			name: tNow('settings.developer.debugLog.name'),
			control: { type: 'toggle', key: 'debugLog' },
		},
		{
			name: tNow('settings.developer.crashBreadcrumbs.name'),
			desc: tNow('settings.developer.crashBreadcrumbs.desc'),
			control: { type: 'toggle', key: 'crashBreadcrumbs' },
		},
		{
			name: tNow('settings.developer.agentMaxSteps.name'),
			desc: tNow('settings.developer.agentMaxSteps.desc'),
			control: {
				type: 'slider',
				key: 'agentMaxSteps',
				min: 5,
				max: 200,
				step: 5,
			},
		},
		{
			name: tNow('settings.skill.scriptTimeout.name'),
			desc: tNow('settings.skill.scriptTimeout.desc'),
			control: {
				type: 'slider',
				key: 'skillScriptTimeout',
				// 关键路径:存储单位是 ms,但用户心智是秒 — 滑块范围 5s-120s。
				// displayFormat(Obsidian 1.13.1 API)把 ms 值换算为秒显示;
				// 1.13.0 上该字段被忽略,降级显示 ms 裸值,滑块功能不受损。
				displayFormat: (ms) => `${ms / 1000} ${tNow('settings.skill.scriptTimeout.unit')}`,
				min: 5000,
				max: 120000,
				step: 5000,
			},
		},
	];

	return {
		type: 'page',
		name: tNow('settings.developer.page.name'),
		desc: tNow('settings.developer.page.desc'),
		visible: isVisible,
		items,
	};
}
