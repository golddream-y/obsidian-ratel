/**
 * @file src/ui/appearance/appearance-presets.ts
 * @description Material 强调色预设与外观字段类型
 * @module ui/appearance/appearance-presets
 */

export type UiColorScheme = 'auto' | 'light' | 'dark';

export type UiAccentId =
	| 'follow'
	| 'copper'
	| 'red'
	| 'purple'
	| 'indigo'
	| 'blue'
	| 'teal'
	| 'green'
	| 'orange'
	| 'pink';

export interface AppearancePreset {
	id: Exclude<UiAccentId, 'follow'>;
	/** Material Design 500;copper 为原型 Quiet atelier 品牌色 */
	hex: string;
	materialName: string;
	/**
	 * 按钮上文字色。浅/亮强调色用深墨;其余默认白。
	 * 未设时 apply 层回落 `#ffffff`。
	 */
	onAccent?: string;
}

export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
	{ id: 'copper', hex: '#c9956c', materialName: 'Copper', onAccent: '#12110f' },
	{ id: 'red', hex: '#F44336', materialName: 'Red' },
	{ id: 'purple', hex: '#9C27B0', materialName: 'Purple' },
	{ id: 'indigo', hex: '#3F51B5', materialName: 'Indigo' },
	{ id: 'blue', hex: '#2196F3', materialName: 'Blue' },
	{ id: 'teal', hex: '#009688', materialName: 'Teal' },
	{ id: 'green', hex: '#4CAF50', materialName: 'Green' },
	{ id: 'orange', hex: '#FF9800', materialName: 'Orange', onAccent: '#12110f' },
	{ id: 'pink', hex: '#E91E63', materialName: 'Pink' },
] as const;

const ACCENT_SET = new Set<string>(['follow', ...APPEARANCE_PRESETS.map((p) => p.id)]);
const SCHEME_SET = new Set<string>(['auto', 'light', 'dark']);

/**
 * 判断未知值是否为合法的强调色 ID。
 *
 * @param v - 待校验值
 * @returns 是否为 {@link UiAccentId}
 */
export function isUiAccentId(v: unknown): v is UiAccentId {
	return typeof v === 'string' && ACCENT_SET.has(v);
}

/**
 * 判断未知值是否为合法的外观配色方案。
 *
 * @param v - 待校验值
 * @returns 是否为 {@link UiColorScheme}
 */
export function isUiColorScheme(v: unknown): v is UiColorScheme {
	return typeof v === 'string' && SCHEME_SET.has(v);
}

/**
 * 按强调色 ID 返回 Material 500 十六进制色值；`follow` 表示跟随 Obsidian 主题，返回 `null`。
 *
 * @param id - 强调色 ID
 * @returns 对应 hex，或 `follow` 时为 `null`
 */
export function hexForAccent(id: UiAccentId): string | null {
	if (id === 'follow') return null;
	return APPEARANCE_PRESETS.find((p) => p.id === id)?.hex ?? null;
}
