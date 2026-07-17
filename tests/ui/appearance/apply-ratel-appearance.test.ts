/**
 * @file tests/ui/appearance/apply-ratel-appearance.test.ts
 * @description applyRatelAppearance dataset 与强调色 CSS 变量测试
 * @module tests/ui/appearance/apply-ratel-appearance.test
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
	applyRatelAppearance,
	RATEL_APPEARANCE_ROOT_CLASS,
} from '../../../src/ui/appearance/apply-ratel-appearance';

describe('applyRatelAppearance', () => {
	it('apply - teal + dark - 写入 dataset、class 与预设 hex 变量', () => {
		const el = document.createElement('div');
		applyRatelAppearance(el, { uiColorScheme: 'dark', uiAccent: 'teal' });
		expect(el.classList.contains(RATEL_APPEARANCE_ROOT_CLASS)).toBe(true);
		expect(el.dataset.ratelScheme).toBe('dark');
		expect(el.dataset.ratelAccent).toBe('teal');
		expect(el.style.getPropertyValue('--interactive-accent').trim()).toBe('#009688');
		expect(el.style.getPropertyValue('--ratel-cite').trim()).toBe('#009688');
		expect(el.style.getPropertyValue('--interactive-accent-hover')).toContain('#009688');
		expect(el.style.getPropertyValue('--text-on-accent').trim()).toBe('#ffffff');
	});

	it('apply - copper - 写入原型铜调与深色 on-accent', () => {
		const el = document.createElement('div');
		applyRatelAppearance(el, { uiColorScheme: 'dark', uiAccent: 'copper' });
		expect(el.dataset.ratelAccent).toBe('copper');
		expect(el.style.getPropertyValue('--interactive-accent').trim()).toBe('#c9956c');
		expect(el.style.getPropertyValue('--text-on-accent').trim()).toBe('#12110f');
	});

	it('apply - auto + follow - 清除 dataset 与强调色变量', () => {
		const el = document.createElement('div');
		applyRatelAppearance(el, { uiColorScheme: 'light', uiAccent: 'blue' });
		applyRatelAppearance(el, { uiColorScheme: 'auto', uiAccent: 'follow' });
		expect(el.dataset.ratelScheme).toBeUndefined();
		expect(el.dataset.ratelAccent).toBeUndefined();
		expect(el.classList.contains(RATEL_APPEARANCE_ROOT_CLASS)).toBe(true);
		expect(el.style.getPropertyValue('--interactive-accent')).toBe('');
		expect(el.style.getPropertyValue('--ratel-cite')).toBe('');
	});
});
