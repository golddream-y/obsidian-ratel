/**
 * @file src/ui/chat/activate-chat-profile.ts
 * @description 将指定套对话配置设为当前 — 顶栏菜单与设置页「设为当前」共用
 * @module ui/chat/activate-chat-profile
 * @depends obsidian, ../../settings/chat-profiles, ../../settings/settings-apply, ../../i18n
 */

import { Notice } from 'obsidian';
import type RatelVaultPlugin from '../../main';
import { profileSelectNeedsSwitch, switchChatProfile, syncChatWindow } from '../../settings/chat-profiles';
import { tNow } from '../../i18n';

/** activateChatProfile 的调用方本地选项,均可选;不传即顶栏菜单的默认行为。 */
export interface ActivateChatProfileOptions {
	/** 透传 saveSettings;设置页在 Modal 内切换时传 false,避免设置页重绘抖动 */
	refreshSettingsTab?: boolean;
	/** 切换落库后的本地钩子;设置页用于 renderPage()。在 switched Notice 之后执行 */
	onActivated?: () => void;
}

/**
 * 切换 active 套配置:写回当前四字段、按映射表同步窗口、持久化并重建 LLM。
 *
 * 顶栏菜单与设置页「设为当前」共用本函数,两条路径步骤同序:
 * switchChatProfile → ensureCatalog → syncChatWindow → saveSettings → rebuildLLM → Notice。
 *
 * 关键路径:S-CHAT-SETUP — 与设置页「设为当前」共用 syncChatWindow:
 * 活跃套 windowUserSet 时跳过查表(用户改小过的窗口不被覆盖),查不到清空旧上限。
 *
 * @param plugin - 插件实例
 * @param profileId - 目标套 id(须存在于 chatProfiles)
 * @param options - 调用方本地选项;refreshSettingsTab 透传 saveSettings,onActivated 在 Notice 后执行
 */
export async function activateChatProfile(
	plugin: RatelVaultPlugin,
	profileId: string,
	options?: ActivateChatProfileOptions,
): Promise<void> {
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
	// 关键路径:设置页在 Modal 内切套时抑制设置 Tab 整体重绘,本地改由 onActivated 重绘当前页。
	const saveOptions = options?.refreshSettingsTab === false ? { refreshSettingsTab: false } : undefined;
	await plugin.saveSettings(saveOptions);
	plugin.rebuildLLM();
	if (!alreadyActive) {
		new Notice(tNow('settings.chatProfiles.switched', { name: profile.name }), 3000);
	}
	// 钩子固定在 switched Notice 之后:设置页先让用户看到切换提示,再重绘本页(按钮随之消失)。
	options?.onActivated?.();
}
