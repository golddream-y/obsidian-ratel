/**
 * @file src/ui/settings/prompt-overrides-setting-page.ts
 * @description 提示词覆盖二级页声明式定义 — 按段编辑、预览、恢复本段默认
 * @module ui/settings/prompt-overrides-setting-page
 * @depends obsidian, settings, i18n, prompts, ui/settings/prompt-override-render
 */

import type { SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
// 关键路径:仅作类型标注使用,避免运行时循环依赖(settings.ts 反向导入本模块)
import type { RatelVaultSettingTab } from '../../settings';
import { tNow } from '../../i18n';
import { listEditableSections } from '../../prompts';
import {
	renderPromptOverrideSection,
	renderPromptPreviewButton,
} from './prompt-override-render';

/**
 * 构建提示词覆盖二级页 — 控件从「高级」主页原样搬入(S-CHAT-SETUP CS-07)。
 *
 * 设计要点:
 * - 声明式 `items` 子页,返回按钮由设置框架自带
 * - 每个 section 用 render 行(toggle + textarea + warn + 恢复按钮),渲染逻辑仍在 prompt-override-render
 * - 嵌套 key(`promptOverrides.<sectionId>`)仍由 SettingTab 的 getControlValue/setControlValue 分发
 *
 * @param tab - 设置面板实例(段落 render 回调需要 tab 上下文)
 * @param isVisible - 入口 visible 谓词(由 SettingTab 按顶栏 Tab 态给出)
 * @returns 完整的 `SettingDefinitionPage` 定义
 */
export function buildPromptOverridesSettingPage(
	tab: RatelVaultSettingTab,
	isVisible: () => boolean,
): SettingDefinitionPage {
	// 关键路径:说明段用 SettingDefinitionEmpty(只有 name + desc)
	const items: SettingDefinitionItem[] = [
		{
			name: tNow('settings.promptOverrides.instructions'),
			desc: tNow('settings.promptOverrides.instructionsDesc'),
		},
	];

	for (const meta of listEditableSections()) {
		items.push({
			name: `${meta.label} (${meta.zone})`,
			desc: meta.description,
			render: renderPromptOverrideSection(tab, tab.plugin, meta),
		});
	}

	items.push({
		name: tNow('settings.promptOverrides.previewButton'),
		desc: tNow('settings.promptOverrides.previewDesc'),
		render: renderPromptPreviewButton(tab.plugin),
	});

	return {
		type: 'page',
		name: tNow('settings.promptOverrides.page.name'),
		desc: tNow('settings.promptOverrides.page.desc'),
		visible: isVisible,
		items,
	};
}
