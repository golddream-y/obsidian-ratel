/**
 * @file src/ui/settings/prompt-override-render.ts
 * @description prompt override section 的 SettingDefinitionRender wrapper
 * @module ui/settings/prompt-override-render
 * @depends obsidian, ../../main, ../../settings, ../../prompts, ../../logging/dev-logger
 */

import { Setting, SettingGroup, ToggleComponent, Modal } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import type { RatelVaultSettingTab } from '../../settings';
import type { SectionMeta } from '../../prompts/types';
import { ZH_DEFAULTS } from '../../prompts/defaults/zh';
import { validatePlaceholders } from '../../prompts/interpolate';
import { composeAgentSystem } from '../../prompts/composer';
import { devLogger } from '../../logging/dev-logger';
// 关键路径:声明式 render 每次调用时重新求值 tNow,语言切换后立即生效
import { tNow } from '../../i18n';

/**
 * 渲染单个 prompt override section(声明式 render 回调)。
 *
 * 关键路径:每个 section 含:
 * - 提示文案(section label / zone / description / 占位符列表)
 * - "使用自定义" toggle — 开启时显示 textarea,关闭时删除 override
 * - textarea — 校验占位符缺失,显示 warn 行
 * - "恢复本段默认" 按钮 — 删除 override 并刷新
 *
 * @param tab - SettingTab 实例,用于触发 update() 重渲染
 * @param plugin - 插件实例
 * @param meta - section 元信息(来自 listEditableSections)
 * @returns SettingDefinitionRender 的 render 函数
 */
export function renderPromptOverrideSection(
	tab: RatelVaultSettingTab,
	plugin: RatelVaultPlugin,
	meta: SectionMeta,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		const container = setting.settingEl;
		// 修复:update() 重入时先清空,避免自定义 DOM 横向堆叠
		container.empty();
		const useCustom = plugin.settings.promptOverrides[meta.id] !== undefined;

		// section 标题行
		const heading = container.createDiv({ cls: 'ratel-prompt-section-row' });
		new Setting(heading).setName(`${meta.label} (${meta.zone})`).setHeading();
		heading.createEl('p', { text: meta.description, cls: 'setting-item-description' });

		if (meta.placeholders.length > 0) {
			heading.createEl('p', {
				text: tNow('settings.promptOverrides.placeholderHint', {
					placeholders: meta.placeholders.map((p) => `{{${p}}}`).join(', '),
				}),
				cls: 'ratel-prompt-placeholder-hint',
			});
		}

		// 使用自定义 toggle
		new Setting(container)
			.setName(tNow('settings.promptOverrides.useCustom'))
			.addToggle((toggle: ToggleComponent) => {
				toggle.setValue(useCustom);
				toggle.onChange(async (on) => {
					if (!on) {
						delete plugin.settings.promptOverrides[meta.id];
					} else {
						// 关键路径:首次开启时用当前默认值填充,避免空 textarea 让用户从头写。
						plugin.settings.promptOverrides[meta.id] =
							plugin.settings.promptOverrides[meta.id] ?? ZH_DEFAULTS[meta.id];
					}
					await plugin.saveSettings();
					plugin.syncToolDefinitions();
					// 关键路径:刷新当前 section 的可见状态(toggle off 时隐藏 textarea)
					// 通过 SettingTab 实例方法 update() 触发 declarative 重渲染(非 app.setting.update())。
					tab.update();
				});
			});

		if (useCustom) {
			const ta = container.createEl('textarea', { cls: 'ratel-prompt-override-textarea' });
			ta.value = plugin.settings.promptOverrides[meta.id] ?? ZH_DEFAULTS[meta.id] ?? '';
			ta.rows = 8;
			ta.onchange = async () => {
				const value = ta.value;
				const missing = validatePlaceholders(value, meta.placeholders);
				const warnEl = container.querySelector('.ratel-prompt-warn');
				if (missing.length > 0) {
					const warnText = tNow('settings.promptOverrides.missingPlaceholder', {
						placeholders: missing.join(', '),
					});
					if (!warnEl) {
						container.createEl('p', {
							cls: 'ratel-prompt-warn',
							text: warnText,
						});
					} else {
						(warnEl as HTMLElement).textContent = warnText;
					}
					devLogger.warn('agent', `override ${meta.id} 缺少占位符`, missing);
				} else if (warnEl) {
					warnEl.remove();
				}
				plugin.settings.promptOverrides[meta.id] = value;
				await plugin.saveSettings();
			};

			new Setting(container).setName(tNow('settings.promptOverrides.resetButton')).addButton((btn) =>
				btn.setButtonText(tNow('settings.promptOverrides.resetButton')).onClick(async () => {
					delete plugin.settings.promptOverrides[meta.id];
					await plugin.saveSettings();
					tab.update();
				}),
			);
		}
	};
}

/**
 * 渲染 "预览 RAG 系统提示词" 按钮(声明式 render 回调)。
 *
 * 关键路径:点击后弹出 Modal,显示用当前工具列表 + overrides 合成的完整 prompt。
 */
export function renderPromptPreviewButton(
	plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		setting.settingEl.empty();
		new Setting(setting.settingEl)
			.setName(tNow('settings.promptOverrides.previewButton'))
			.setDesc(tNow('settings.promptOverrides.previewDesc'))
			.addButton((btn) =>
				btn.setButtonText(tNow('settings.promptOverrides.previewButton')).onClick(() => {
					const preview = composeAgentSystem(
						'rag',
						{ tools: plugin.tools.definitions() },
						plugin.settings.promptOverrides,
					);
					const modal = new Modal(plugin.app);
					modal.titleEl.setText(tNow('settings.promptOverrides.previewModal.title'));
					const pre = modal.contentEl.createEl('pre', { text: preview });
					pre.setCssProps({
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
						fontFamily: 'var(--font-monospace)',
						fontSize: 'var(--font-smaller)',
						margin: '0',
					});
					modal.open();
				}),
			);
	};
}
