/**
 * @file src/ui/settings/chat-profiles-render.ts
 * @description 设置页「已保存的配置」列表 — 切换、改名、删除、另存
 * @module ui/settings/chat-profiles-render
 * @depends obsidian, ../../settings/chat-profiles, ../../secrets/ratel-secrets, ../../i18n
 */

import { App, Modal, Notice, Setting, SettingGroup } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import type { ChatProfile } from '../../settings/chat-profiles';
import {
	deleteChatProfile,
	saveCurrentAsProfile,
	switchChatProfile,
} from '../../settings/chat-profiles';
import {
	chatProfileSecretId,
	deleteChatProfileSecret,
	requiresChatApiKey,
	resolveChatApiKey,
	setChatProfileSecret,
} from '../../secrets/ratel-secrets';
import { tNow } from '../../i18n';
import { DEFAULT_MODEL_REGISTRY_URL } from '../../ui/tokens/model-context-registry';
import { applyModelContextWindow } from '../../ui/tokens/apply-model-context';

/**
 * 简单文本输入 Modal — 用于改名 / 另存为名称。
 */
class TextPromptModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private placeholder: string,
		private initial: string,
		private onSubmit: (value: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.title);
		let value = this.initial;
		new Setting(contentEl)
			.addText((text) => {
				text.setPlaceholder(this.placeholder);
				text.setValue(this.initial);
				text.inputEl.addEventListener('input', () => {
					value = text.getValue();
				});
				setTimeout(() => text.inputEl.focus(), 0);
			})
			.addButton((btn) => {
				btn.setButtonText(tNow('settings.chatProfiles.promptConfirm'));
				btn.setCta();
				btn.onClick(() => {
					const trimmed = value.trim();
					if (!trimmed) return;
					this.onSubmit(trimmed);
					this.close();
				});
			});
	}
}

/**
 * 渲染已保存配置列表(声明式 render 回调)。
 *
 * @param app - Obsidian App
 * @param plugin - 插件实例
 * @returns SettingDefinitionRender 的 render 函数
 */
export function renderChatProfiles(
	app: App,
	plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		const container = setting.settingEl;
		container.empty();
		const root = container.createDiv({ cls: 'ratel-chat-profiles-list' });

		const profiles = plugin.settings.chatProfiles ?? [];
		const activeId = plugin.settings.activeChatProfileId;

		for (const profile of profiles) {
			renderProfileRow(app, plugin, root, profile, profile.id === activeId);
		}

		new Setting(root)
			.setName(tNow('settings.chatProfiles.saveAs'))
			.addButton((btn) => {
				btn.setButtonText(tNow('settings.chatProfiles.saveAsAction'));
				btn.onClick(() => {
					new TextPromptModal(
						app,
						tNow('settings.chatProfiles.saveAsPromptTitle'),
						tNow('settings.chatProfiles.saveAsPromptPlaceholder'),
						'',
						async (name) => {
							// 关键路径:另存前先读源套密钥;saveCurrentAsProfile 会把 active 切到新套
							const sourceProfileId = plugin.settings.activeChatProfileId;
							const key = resolveChatApiKey(app, {
								chatApiBase: plugin.settings.chatApiBase,
								chatProfiles: plugin.settings.chatProfiles,
								activeChatProfileId: sourceProfileId,
							});
							const created = saveCurrentAsProfile(plugin.settings, name);
							if (key) {
								setChatProfileSecret(app, created.id, key);
							}
							await plugin.saveSettings();
							new Notice(tNow('settings.chatProfiles.saveAsDone'), 3000);
						},
					).open();
				});
			});
	};
}

/**
 * 渲染单套配置行。
 */
function renderProfileRow(
	app: App,
	plugin: RatelVaultPlugin,
	root: HTMLElement,
	profile: ChatProfile,
	isActive: boolean,
): void {
	const row = root.createDiv({ cls: 'ratel-chat-profile-row' });
	const summary = `${profile.name} · ${profile.model} · ${profile.apiBase}`;
	const nameSuffix = isActive ? ` (${tNow('settings.chatProfiles.activeMark')})` : '';

	new Setting(row)
		.setName(summary + nameSuffix)
		.addButton((btn) => {
			btn.setButtonText(tNow('settings.chatProfiles.setActive'));
			btn.setDisabled(isActive);
			btn.onClick(async () => {
				if (isActive) return;
				switchChatProfile(plugin.settings, profile.id);
				const registryUrl = plugin.settings.modelRegistryUrl || DEFAULT_MODEL_REGISTRY_URL;
				const result = await applyModelContextWindow({
					model: profile.model,
					registry: plugin.modelContextRegistry,
					registryUrl,
					settings: plugin.settings,
				});
				if (!result.applied) {
					new Notice(tNow('settings.notice.contextLengthUnknown', { model: profile.model }), 5000);
				} else {
					const activeProfile = plugin.settings.chatProfiles.find((p) => p.id === profile.id);
					if (activeProfile) {
						activeProfile.contextLengthPreset = plugin.settings.contextLengthPreset;
						activeProfile.chatModelMaxTokens = plugin.settings.chatModelMaxTokens;
					}
				}
				await plugin.saveSettings();
				plugin.rebuildLLM();
				new Notice(tNow('settings.chatProfiles.switched', { name: profile.name }), 3000);
			});
		})
		.addButton((btn) => {
			btn.setButtonText(tNow('settings.chatProfiles.rename'));
			btn.onClick(() => {
				new TextPromptModal(
					app,
					tNow('settings.chatProfiles.renamePromptTitle'),
					tNow('settings.chatProfiles.renamePromptPlaceholder'),
					profile.name,
					async (name) => {
						profile.name = name;
						await plugin.saveSettings();
					},
				).open();
			});
		})
		.addButton((btn) => {
			btn.setButtonText(tNow('settings.chatProfiles.delete'));
			btn.setDisabled(isActive);
			btn.setWarning();
			btn.onClick(async () => {
				if (isActive) {
					new Notice(tNow('settings.chatProfiles.deleteActiveBlocked'), 5000);
					return;
				}
				try {
					deleteChatProfile(plugin.settings, profile.id);
				} catch {
					new Notice(tNow('settings.chatProfiles.deleteActiveBlocked'), 5000);
					return;
				}
				deleteChatProfileSecret(app, profile.id);
				await plugin.saveSettings();
				new Notice(tNow('settings.chatProfiles.deleted', { name: profile.name }), 3000);
			});
		});

	if (requiresChatApiKey({ chatApiBase: profile.apiBase })) {
		new Setting(row)
			.setName(tNow('settings.chatProfiles.apiKey.name'))
			.setDesc(tNow('settings.chatProfiles.apiKey.desc', { id: chatProfileSecretId(profile.id) }))
			.addText((text) => {
				text.inputEl.type = 'password';
				text.setPlaceholder(tNow('settings.chatProfiles.apiKey.placeholder'));
				text.inputEl.addEventListener('change', () => {
					const trimmed = text.getValue().trim();
					if (!trimmed) return;
					setChatProfileSecret(app, profile.id, trimmed);
					text.setValue('');
					new Notice(tNow('settings.chatProfiles.apiKey.saved'), 3000);
				});
			});
	}
}
