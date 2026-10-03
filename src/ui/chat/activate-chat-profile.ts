/**
 * @file src/ui/chat/activate-chat-profile.ts
 * @description 将指定套对话配置设为当前 — 与设置页「设为当前」同序
 * @module ui/chat/activate-chat-profile
 * @depends obsidian, ../../settings/chat-profiles, ../../settings/settings-apply
 */

import { Notice } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { profileSelectNeedsSwitch, switchChatProfile, syncChatWindow } from '../../settings/chat-profiles';
import { tNow } from '../../i18n';

/**
 * 切换 active 套配置:写回当前四字段、按映射表同步窗口、持久化并重建 LLM。
 *
 * 关键路径:S-CHAT-SETUP — 与设置页「设为当前」共用 syncChatWindow:
 * 活跃套 windowUserSet 时跳过查表(用户改小过的窗口不被覆盖),查不到清空旧上限。
 *
 * @param plugin - 插件实例
 * @param profileId - 目标套 id(须存在于 chatProfiles)
 */
export async function activateChatProfile(plugin: RatelVaultPlugin, profileId: string): Promise<void> {
	const profile = plugin.settings.chatProfiles.find((p) => p.id === profileId);
	if (!profile) return;
	if (!profileSelectNeedsSwitch(plugin.settings, profileId)) return;
	const alreadyActive = profileId === plugin.settings.activeChatProfileId;

	switchChatProfile(plugin.settings, profileId);
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
	if (!alreadyActive) {
		new Notice(tNow('settings.chatProfiles.switched', { name: profile.name }), 3000);
	}
}
