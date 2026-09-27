/**
 * @file src/ui/chat/open-ratel-settings-tab.ts
 * @description 打开 Obsidian 设置并定位到 Ratel Vault 插件页
 * @module ui/chat/open-ratel-settings-tab
 * @depends obsidian
 */

import type { App } from 'obsidian';

/**
 * 打开 Ratel 设置 tab(与 ModelInfoModal 跳转一致)。
 *
 * @param app - Obsidian App
 */
export function openRatelVaultSettingsTab(app: App): void {
	// 关键路径:Obsidian App.setting 不是公开类型,需 unknown 中转。
	const appWithSetting = app as unknown as {
		setting: {
			open: () => void;
			openTabById: (id: string) => void;
		};
	};
	appWithSetting.setting.open();
	appWithSetting.setting.openTabById('ratel-vault');
}
