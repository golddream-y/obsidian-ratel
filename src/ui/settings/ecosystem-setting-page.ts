/**
 * @file src/ui/settings/ecosystem-setting-page.ts
 * @description 对话里改其他插件二级页声明式定义 — 代装社区插件开关(ADR-018 R2)
 * @module ui/settings/ecosystem-setting-page
 * @depends obsidian, i18n
 */

import type { SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
import { tNow } from '../../i18n';

/**
 * 构建对话里改其他插件二级页 — 控件从「高级」主页原样搬入(S-CHAT-SETUP CS-07)。
 *
 * 设计要点:
 * - 声明式 `items` 子页,返回按钮由设置框架自带
 * - 页内仅一个开关(ecosystemWriteEnabled),控件定义与原高级主页完全一致
 *
 * @param isVisible - 入口 visible 谓词(由 SettingTab 按顶栏 Tab 态给出)
 * @returns 完整的 `SettingDefinitionPage` 定义
 */
export function buildEcosystemSettingPage(
	isVisible: () => boolean,
): SettingDefinitionPage {
	const items: SettingDefinitionItem[] = [
		{
			name: tNow('settings.ecosystem.writeEnabled.name'),
			desc: tNow('settings.ecosystem.writeEnabled.desc'),
			control: { type: 'toggle', key: 'ecosystemWriteEnabled' },
		},
	];

	return {
		type: 'page',
		name: tNow('settings.ecosystem.page.name'),
		desc: tNow('settings.ecosystem.page.desc'),
		visible: isVisible,
		items,
	};
}
