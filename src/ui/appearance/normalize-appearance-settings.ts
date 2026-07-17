/**
 * @file src/ui/appearance/normalize-appearance-settings.ts
 * @description 外观设置字段归一化 — 非法/缺失回落 auto/follow
 * @module ui/appearance/normalize-appearance-settings
 * @depends ../../settings, ./appearance-presets
 */

import type { RatelVaultSettings } from '../../settings';
import { isUiAccentId, isUiColorScheme } from './appearance-presets';

/**
 * 将外观相关设置归一为合法值(原地修改)。
 *
 * 旧版 data.json 缺字段或写入非法值时,回落为 `uiColorScheme: 'auto'`、`uiAccent: 'follow'`。
 *
 * @param settings - 已与 DEFAULT 合并后的设置对象
 */
export function normalizeAppearanceSettings(settings: RatelVaultSettings): void {
	if (!isUiColorScheme(settings.uiColorScheme)) {
		settings.uiColorScheme = 'auto';
	}
	if (!isUiAccentId(settings.uiAccent)) {
		settings.uiAccent = 'follow';
	}
}
