/**
 * @file src/ui/settings/secret-hint-render.ts
 * @description secret hint 的 SettingDefinitionRender wrapper
 * @module ui/settings/secret-hint-render
 * @depends obsidian, ../../secrets/ratel-secrets, ../components/secret-hint
 */

import { App, Setting, SettingGroup } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { renderSecretHint, renderNoKeyNeeded } from '../components/secret-hint';
import {
	getChatSecretId,
	getEmbedSecretId,
	getRerankSecretId,
	hasChatApiKey,
	hasEmbedApiKey,
	hasRerankApiKey,
} from '../../secrets/ratel-secrets';

/**
 * 渲染 Chat API Key hint(声明式 render 回调)。
 *
 * @param app - Obsidian App
 * @param plugin - 插件实例
 * @returns SettingDefinitionRender 的 render 函数
 */
export function renderChatSecretHint(
	app: App,
	plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		const secretId = getChatSecretId(plugin.settings);
		if (secretId) {
			renderSecretHint(setting.settingEl, {
				secretId,
				hasKey: hasChatApiKey(app, plugin.settings),
			});
		} else {
			renderNoKeyNeeded(setting.settingEl, '当前为本地 Ollama,无需 API Key。');
		}
	};
}

/**
 * 渲染 Embedding API Key hint(声明式 render 回调)。
 */
export function renderEmbedSecretHint(
	app: App,
	plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		const secretId = getEmbedSecretId(plugin.settings);
		if (secretId) {
			renderSecretHint(setting.settingEl, {
				secretId,
				hasKey: hasEmbedApiKey(app, plugin.settings),
			});
		} else {
			renderNoKeyNeeded(setting.settingEl, '当前为本地 Ollama Embedding,无需 API Key。');
		}
	};
}

/**
 * 渲染 Rerank API Key hint(声明式 render 回调)。
 *
 * 关键路径:Rerank 密钥固定为 ratel-rerank-bailian,不依赖 settings(与 chat/embed 不同)。
 * 保留 `_plugin` 参数以与 renderChatSecretHint / renderEmbedSecretHint 保持一致的 (app, plugin) 调用签名。
 */
export function renderRerankSecretHint(
	app: App,
	_plugin: RatelVaultPlugin,
): (setting: Setting, group: SettingGroup) => void {
	return (setting) => {
		renderSecretHint(setting.settingEl, {
			secretId: getRerankSecretId(),
			hasKey: hasRerankApiKey(app),
			note: '未配置密钥时 Rerank 自动关闭。',
		});
	};
}
