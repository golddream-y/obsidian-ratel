/**
 * @file src/ui/chat/activate-chat-profile.ts
 * @description 将指定套对话配置设为当前 — 与设置页「设为当前」同序
 * @module ui/chat/activate-chat-profile
 * @depends obsidian, ../../settings/chat-profiles, ../tokens/apply-model-context, ../tokens/model-context-registry
 */

import { Notice } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { switchChatProfile } from '../../settings/chat-profiles';
import { tNow } from '../../i18n';
import { DEFAULT_MODEL_REGISTRY_URL } from '../tokens/model-context-registry';
import { applyModelContextWindow } from '../tokens/apply-model-context';

/**
 * 切换 active 套配置:写回当前四字段、探测窗口、持久化并重建 LLM。
 *
 * @param plugin - 插件实例
 * @param profileId - 目标套 id(须存在于 chatProfiles)
 */
export async function activateChatProfile(plugin: RatelVaultPlugin, profileId: string): Promise<void> {
	const profile = plugin.settings.chatProfiles.find((p) => p.id === profileId);
	if (!profile) return;
	if (profileId === plugin.settings.activeChatProfileId) return;

	switchChatProfile(plugin.settings, profileId);
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
		const activeProfile = plugin.settings.chatProfiles.find((p) => p.id === profileId);
		if (activeProfile) {
			activeProfile.contextLengthPreset = plugin.settings.contextLengthPreset;
			activeProfile.chatModelMaxTokens = plugin.settings.chatModelMaxTokens;
		}
	}
	await plugin.saveSettings();
	plugin.rebuildLLM();
	new Notice(tNow('settings.chatProfiles.switched', { name: profile.name }), 3000);
}
