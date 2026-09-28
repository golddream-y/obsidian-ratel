/**
 * @file src/ui/settings/chat-profiles-render.ts
 * @description 设置页「已保存的配置」列表 — 切换、当前套展开区(名称/提供商/模型名/窗口)、另存、删除
 * @module ui/settings/chat-profiles-render
 * @depends obsidian, ../../settings/chat-profiles, ../../settings/settings-apply, ../../secrets/ratel-secrets, ../../i18n
 */

import { App, Modal, Notice, Setting, SettingGroup } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import type { ChatProfile } from '../../settings/chat-profiles';
import {
	deleteChatProfile,
	inferChatProvider,
	saveCurrentAsProfile,
	switchChatProfile,
	syncChatWindow,
} from '../../settings/chat-profiles';
import { applySettingValue } from '../../settings/settings-apply';
import {
	chatProfileSecretId,
	deleteChatProfileSecret,
	requiresChatApiKey,
	resolveChatApiKey,
	setChatProfileSecret,
} from '../../secrets/ratel-secrets';
import { tNow } from '../../i18n';
import { CUSTOM_TOKEN_MAX, CUSTOM_TOKEN_MIN } from '../../ui/tokens/context-length-presets';

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
 * 设计要点(S-CHAT-SETUP):
 * - 只有当前套(activeChatProfileId 指向)在行下展开编辑区,未选中的行不展开;
 * - 编辑区:名称、提供商(由地址推断,不另存字段)、模型名、上下文窗口一行、密钥;
 * - 所有写入统一走 applySettingValue,与 update_app_config 工具同路径。
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
			const isActive = profile.id === activeId;
			renderProfileRow(app, plugin, root, profile, isActive);
			if (isActive) {
				renderProfileDetail(app, plugin, root, profile);
			}
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
 * 渲染单套配置行。当前套不放按钮(在下方展开区编辑);其余套可设为当前 / 改名 / 删除。
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
	const rowSetting = new Setting(row).setName(summary + nameSuffix);
	if (isActive) return;

	rowSetting
		.addButton((btn) => {
			btn.setButtonText(tNow('settings.chatProfiles.setActive'));
			btn.onClick(async () => {
				switchChatProfile(plugin.settings, profile.id);
				// S-CHAT-SETUP:切换后按该套模型重查窗口;查不到清空旧上限,不静默沿用
				const catalog = plugin.modelsDevCatalog ? await plugin.modelsDevCatalog.ensureCatalog() : null;
				const result = await syncChatWindow(plugin.settings, {
					catalog,
					clearOnMiss: true,
				});
				if (!result.applied && !result.skipped) {
					new Notice(tNow('settings.notice.contextLengthUnknown', { model: profile.model }), 5000);
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
			btn.setWarning();
			btn.onClick(async () => {
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
}

/**
 * 渲染当前套展开区:名称、提供商、地址(仅自定义)、密钥、模型名、上下文窗口一行。
 */
function renderProfileDetail(
	app: App,
	plugin: RatelVaultPlugin,
	root: HTMLElement,
	profile: ChatProfile,
): void {
	const detail = root.createDiv({ cls: 'ratel-chat-profile-detail' });

	new Setting(detail)
		.setName(tNow('settings.chatProfiles.detail.title', { name: profile.name }))
		.setHeading();

	// 名称 — 只改 profile.name,不涉及四字段
	new Setting(detail)
		.setName(tNow('settings.chatProfiles.name.name'))
		.addText((text) => {
			text.setValue(profile.name);
			text.inputEl.addEventListener('change', () => {
				void (async () => {
					const trimmed = text.getValue().trim();
					if (!trimmed || trimmed === profile.name) return;
					profile.name = trimmed;
					await plugin.saveSettings();
				})();
			});
		});

	// 提供商 — 由地址推断;DeepSeek/Ollama 走预设写入,自定义清空地址由用户填写
	const provider = inferChatProvider(plugin.settings.chatApiBase);
	new Setting(detail)
		.setName(tNow('settings.chatProfiles.provider.name'))
		.addDropdown((drop) => {
			drop.addOptions({
				deepseek: tNow('settings.chatPreset.deepseek'),
				ollama: tNow('settings.chatPreset.ollama'),
				custom: tNow('settings.chatPreset.custom'),
			});
			drop.setValue(provider);
			drop.onChange(async (value) => {
				await applySettingValue(plugin, 'chatPreset', value);
				await plugin.saveSettings();
			});
		});

	// 地址 — 仅自定义时显示(官方 DeepSeek / Ollama 地址由预设写死)
	if (provider === 'custom') {
		new Setting(detail)
			.setName(tNow('settings.chatProfiles.apiBase.name'))
			.addText((text) => {
				text.setPlaceholder('https://your-endpoint/v1');
				text.setValue(plugin.settings.chatApiBase);
				text.inputEl.addEventListener('change', () => {
					void (async () => {
						const trimmed = text.getValue().trim();
						if (!trimmed) return;
						await applySettingValue(plugin, 'chatApiBase', trimmed);
						await plugin.saveSettings();
					})();
				});
			});
	}

	// 密钥 — 仅当前套展开区;本地 Ollama 免密钥,不进 data.json
	if (requiresChatApiKey({ chatApiBase: plugin.settings.chatApiBase })) {
		new Setting(detail)
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

	// 模型名 — 改后按映射表重查窗口(见 applySettingValue chatModel 分支)
	new Setting(detail)
		.setName(tNow('settings.chatProfiles.model.name'))
		.addText((text) => {
			text.setValue(plugin.settings.chatModel);
			text.inputEl.addEventListener('change', () => {
				void (async () => {
					const trimmed = text.getValue().trim();
					if (!trimmed) return;
					await applySettingValue(plugin, 'chatModel', trimmed);
					await plugin.saveSettings();
				})();
			});
		});

	renderProfileWindow(plugin, detail, profile);
}

/**
 * 渲染上下文窗口一行(当前套展开区末行)。
 *
 * 三态:
 * - windowUserSet:用户改小过 — 「这一套自己的上限是 N」+ 数字框;
 * - 查表命中 — 「这个模型的窗口是 N」+「改得更小」按钮(不出现档位下拉);
 * - 查不到 — 「未查到 X 的窗口」+ 数字框,不静默沿用上一个模型的上限。
 */
function renderProfileWindow(
	plugin: RatelVaultPlugin,
	detail: HTMLElement,
	profile: ChatProfile,
): void {
	const setting = new Setting(detail).setName(tNow('settings.chatProfiles.window.heading'));

	if (profile.windowUserSet) {
		setting.setDesc(
			tNow('settings.chatProfiles.window.userSet', {
				tokens: plugin.settings.chatModelMaxTokens.toLocaleString(),
			}) + '\n' + tNow('settings.chatProfiles.window.userSetHint'),
		);
		addWindowNumberInput(setting, plugin);
		return;
	}

	// 查表是异步的:先渲染 loading,结果回来后原位补 desc 与控件
	setting.setDesc(tNow('settings.chatProfiles.window.loading'));
	void (async () => {
		const catalog = plugin.modelsDevCatalog ? await plugin.modelsDevCatalog.ensureCatalog() : null;
		const result = await syncChatWindow(plugin.settings, {
			catalog,
			// 仅展示:查不到保留旧值(不落盘),避免打开设置就清空
			clearOnMiss: false,
		});
		// 关键路径:查到且值变化才落盘;saveSettings 会触发整页重渲染,本元素随之重建
		if (result.changed) {
			await plugin.saveSettings();
			return;
		}
		if (result.tokens != null) {
			const found = result.tokens;
			setting.setDesc(
				tNow('settings.chatProfiles.window.found', { tokens: found.toLocaleString() }) +
					'\n' +
					tNow('settings.chatProfiles.window.foundHint'),
			);
			setting.addButton((btn) => {
				btn.setButtonText(tNow('settings.chatProfiles.window.shrink'));
				btn.onClick(async () => {
					await applySettingValue(plugin, 'chatModelMaxTokens', Math.floor(found / 2));
					await plugin.saveSettings();
				});
			});
		} else {
			setting.setDesc(
				tNow('settings.chatProfiles.window.unknown', { model: plugin.settings.chatModel }) +
					'\n' +
					tNow('settings.chatProfiles.window.unknownHint'),
			);
			addWindowNumberInput(setting, plugin);
		}
	})();
}

/** 窗口数字框 — min/max 与旧高级页一致,写入走 chatModelMaxTokens 分支(含大于查到值的钳制) */
function addWindowNumberInput(setting: Setting, plugin: RatelVaultPlugin): void {
	setting.addText((text) => {
		text.inputEl.type = 'number';
		text.inputEl.min = String(CUSTOM_TOKEN_MIN);
		text.inputEl.max = String(CUSTOM_TOKEN_MAX);
		// 关键路径:查不到时可能已被清成 0,预填空而非 0,引导用户填写
		const current = plugin.settings.chatModelMaxTokens;
		if (current > 0) {
			text.setValue(String(current));
		}
		text.inputEl.addEventListener('change', () => {
			void (async () => {
				const n = Number.parseInt(text.getValue(), 10);
				if (!Number.isFinite(n) || n <= 0) return;
				await applySettingValue(plugin, 'chatModelMaxTokens', n);
				await plugin.saveSettings();
			})();
		});
	});
}
