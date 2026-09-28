/**
 * @file src/ui/settings/model-registry-setting-page.ts
 * @description 模型映射表二级页声明式定义 — 映射表地址与恢复默认
 * @module ui/settings/model-registry-setting-page
 * @depends obsidian, settings, i18n, ui/tokens/model-context-registry
 */

import type { SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
// 关键路径:仅作类型标注使用,避免运行时循环依赖(settings.ts 反向导入本模块)
import type { RatelVaultSettingTab } from '../../settings';
import { tNow } from '../../i18n';
import { DEFAULT_MODEL_REGISTRY_URL } from '../tokens/model-context-registry';

/**
 * 构建模型映射表二级页 — 控件从「高级」主页原样搬入(S-CHAT-SETUP CS-07)。
 *
 * 设计要点:
 * - 声明式 `items` 子页,返回按钮由设置框架自带
 * - 恢复默认按钮沿用原行为:清空 URL 落盘后 update() 重渲染
 *
 * @param tab - 设置面板实例(恢复默认后调 update() 刷新)
 * @param isVisible - 入口 visible 谓词(由 SettingTab 按顶栏 Tab 态给出)
 * @returns 完整的 `SettingDefinitionPage` 定义
 */
export function buildModelRegistrySettingPage(
	tab: RatelVaultSettingTab,
	isVisible: () => boolean,
): SettingDefinitionPage {
	const items: SettingDefinitionItem[] = [
		{
			name: tNow('settings.advanced.registryUrl.name'),
			desc: tNow('settings.advanced.registryUrl.desc'),
			control: {
				type: 'text',
				key: 'modelRegistryUrl',
				placeholder: DEFAULT_MODEL_REGISTRY_URL,
			},
		},
		{
			name: tNow('settings.advanced.resetButton'),
			action: () => {
				tab.plugin.settings.modelRegistryUrl = '';
				void tab.plugin.saveSettings().then(() => tab.update());
			},
		},
	];

	return {
		type: 'page',
		name: tNow('settings.advanced.registryPage.name'),
		desc: tNow('settings.advanced.registryPage.desc'),
		visible: isVisible,
		items,
	};
}
