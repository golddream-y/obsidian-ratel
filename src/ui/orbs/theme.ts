/**
 * @file src/ui/orbs/theme.ts
 * @description Orb 明暗与 reduced-motion 解析（Obsidian body.theme-dark / theme-light）
 * @module ui/orbs/theme
 * @depends ./types
 */

import type { OrbTheme } from './types';

/**
 * 解析当前是否应按「深色底 + 浅色墨点」绘制。
 *
 * @param theme - auto | dark | light
 * @returns true = 深色背景用浅墨
 */
export function resolveOrbDark(theme: OrbTheme): boolean {
	if (theme === 'dark') return true;
	if (theme === 'light') return false;
	const body = typeof document !== 'undefined' ? document.body : null;
	if (body?.classList.contains('theme-dark')) return true;
	if (body?.classList.contains('theme-light')) return false;
	if (typeof matchMedia === 'undefined') return true;
	return matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 是否应静止一帧（无障碍）。
 */
export function prefersOrbReducedMotion(): boolean {
	if (typeof matchMedia === 'undefined') return false;
	return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
