/**
 * @file src/ui/appearance/apply-ratel-appearance.ts
 * @description 在 Ratel 视图根上挂载外观 dataset 与强调色 CSS 变量(供 CSS / 继承消费)
 * @module ui/appearance/apply-ratel-appearance
 */

import {
	APPEARANCE_PRESETS,
	hexForAccent,
	type UiAccentId,
	type UiColorScheme,
} from './appearance-presets';

export const RATEL_APPEARANCE_ROOT_CLASS = 'ratel-appearance-root';

/** 由预设表写入的强调色变量 — follow 时全部 removeProperty */
const ACCENT_CSS_VARS = [
	'--interactive-accent',
	'--interactive-accent-hover',
	'--text-accent',
	'--ratel-cite',
	'--text-on-accent',
] as const;

/**
 * 将亮暗/强调色选择写到根节点。
 *
 * - auto/follow:清除对应 data 属性,交还 Obsidian 继承(暗色 surface 由 styles.css 在 theme-dark 下补 atelier)
 * - 强调色 hex 只来自 {@link hexForAccent}(预设表唯一事实源),经 inline CSS 变量注入
 *
 * @param root - Ratel 视图根元素
 * @param opts - 外观选项:配色方案与强调色
 */
export function applyRatelAppearance(
	root: HTMLElement,
	opts: { uiColorScheme: UiColorScheme; uiAccent: UiAccentId },
): void {
	root.classList.add(RATEL_APPEARANCE_ROOT_CLASS);
	if (opts.uiColorScheme === 'auto') {
		delete root.dataset.ratelScheme;
	} else {
		root.dataset.ratelScheme = opts.uiColorScheme;
	}

	const hex = hexForAccent(opts.uiAccent);
	if (hex == null) {
		delete root.dataset.ratelAccent;
		for (const name of ACCENT_CSS_VARS) {
			root.style.removeProperty(name);
		}
	} else {
		root.dataset.ratelAccent = opts.uiAccent;
		// 关键路径:hover 用 color-mix 略提亮,避免再维护第二份 hex 表
		const hover = `color-mix(in srgb, ${hex} 85%, white)`;
		const onAccent =
			APPEARANCE_PRESETS.find((p) => p.id === opts.uiAccent)?.onAccent ?? '#ffffff';
		root.style.setProperty('--interactive-accent', hex);
		root.style.setProperty('--interactive-accent-hover', hover);
		root.style.setProperty('--text-accent', hex);
		root.style.setProperty('--ratel-cite', hex);
		root.style.setProperty('--text-on-accent', onAccent);
	}
}
