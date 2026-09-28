/**
 * @file src/ui/settings/memory-limits-setting-page.ts
 * @description 记忆上限二级页声明式定义 — 磁盘/注入/动态段/上下文合计/相关主题条数
 * @module ui/settings/memory-limits-setting-page
 * @depends obsidian, i18n
 */

import type { SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
import { tNow } from '../../i18n';

/**
 * 构建记忆上限二级页 — 控件从「高级」主页原样搬入(S-CHAT-SETUP CS-07)。
 *
 * 设计要点:
 * - 声明式 `items` 子页,返回按钮由设置框架自带
 * - 5 个数字控件的 min/max 与原高级主页完全一致,默认值不动
 *
 * @param isVisible - 入口 visible 谓词(由 SettingTab 按顶栏 Tab 态给出)
 * @returns 完整的 `SettingDefinitionPage` 定义
 */
export function buildMemoryLimitsSettingPage(
	isVisible: () => boolean,
): SettingDefinitionPage {
	const items: SettingDefinitionItem[] = [
		{
			name: tNow('memory.settings.storageLimit.name'),
			desc: tNow('memory.settings.storageLimit.desc'),
			control: { type: 'number', key: 'memoryStorageLimitMB', min: 1, max: 1000 },
		},
		{
			name: tNow('memory.settings.injectLimit.name'),
			desc: tNow('memory.settings.injectLimit.desc'),
			control: { type: 'number', key: 'memoryInjectLimitKB', min: 1, max: 500 },
		},
		{
			name: tNow('memory.settings.dynamicLimit.name'),
			desc: tNow('memory.settings.dynamicLimit.desc'),
			control: { type: 'number', key: 'memoryDynamicLimitKB', min: 1, max: 500 },
		},
		{
			name: tNow('memory.settings.contextTotalLimit.name'),
			desc: tNow('memory.settings.contextTotalLimit.desc'),
			control: { type: 'number', key: 'memoryContextTotalLimitKB', min: 1, max: 500 },
		},
		{
			name: tNow('memory.settings.topicsAutoInject.name'),
			desc: tNow('memory.settings.topicsAutoInject.desc'),
			control: { type: 'number', key: 'memoryTopicsAutoInjectK', min: 0, max: 10 },
		},
	];

	return {
		type: 'page',
		name: tNow('memory.settings.limitsPage.name'),
		desc: tNow('memory.settings.limitsPage.desc'),
		visible: isVisible,
		items,
	};
}
