/**
 * @file tests/ui/appearance/appearance-settings-render.test.ts
 * @description 外观 Tab 预览/分段/色块渲染测试
 * @module tests/ui/appearance/appearance-settings-render.test
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderAppearanceSettings } from '../../../src/ui/appearance/appearance-settings-render';
import { RATEL_APPEARANCE_ROOT_CLASS } from '../../../src/ui/appearance/apply-ratel-appearance';
import { appearanceRevision } from '../../../src/ui/appearance/appearance-store';
import type { RatelVaultSettingTab } from '../../../src/settings';
import type { UiAccentId, UiColorScheme } from '../../../src/ui/appearance/appearance-presets';

function makeTab(
	scheme: UiColorScheme = 'auto',
	accent: UiAccentId = 'follow',
	saveImpl: () => Promise<void> = async () => {},
): {
	tab: RatelVaultSettingTab;
	saveSettings: ReturnType<typeof vi.fn>;
	settings: { uiColorScheme: UiColorScheme; uiAccent: UiAccentId };
} {
	const settings = { uiColorScheme: scheme, uiAccent: accent };
	const saveSettings = vi.fn(saveImpl);
	const tab = {
		plugin: { settings, saveSettings },
	} as unknown as RatelVaultSettingTab;
	return { tab, saveSettings, settings };
}

describe('renderAppearanceSettings', () => {
	beforeEach(() => {
		appearanceRevision.set(0);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('render - 默认 - 预览根挂载外观 class 且无强制 dataset', () => {
		const root = document.createElement('div');
		const { tab } = makeTab();
		renderAppearanceSettings(root, tab);

		const wrap = root.querySelector('.ratel-appearance-settings');
		expect(wrap).toBeTruthy();
		const preview = root.querySelector('.ratel-appearance-preview') as HTMLElement;
		expect(preview).toBeTruthy();
		expect(preview.classList.contains(RATEL_APPEARANCE_ROOT_CLASS)).toBe(true);
		expect(preview.dataset.ratelScheme).toBeUndefined();
		expect(preview.dataset.ratelAccent).toBeUndefined();
		expect(root.querySelectorAll('.ratel-appearance-scheme button[role="radio"]').length).toBe(3);
		expect(root.querySelectorAll('.ratel-appearance-swatch').length).toBe(10);
		expect(root.querySelector('.ratel-appearance-hint')).toBeTruthy();
	});

	it('scheme click - 选浅色 - 乐观写入并 save', async () => {
		const root = document.createElement('div');
		const { tab, saveSettings, settings } = makeTab('auto', 'follow');
		renderAppearanceSettings(root, tab);

		const lightBtn = Array.from(
			root.querySelectorAll<HTMLButtonElement>('.ratel-appearance-scheme button'),
		).find((b) => b.dataset.scheme === 'light');
		expect(lightBtn).toBeTruthy();
		lightBtn!.click();
		await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());

		expect(settings.uiColorScheme).toBe('light');
		const preview = root.querySelector('.ratel-appearance-preview') as HTMLElement;
		expect(preview.dataset.ratelScheme).toBe('light');
		expect(lightBtn!.getAttribute('aria-checked')).toBe('true');
		expect(lightBtn!.tabIndex).toBe(0);
	});

	it('accent click - 选 teal - 写入 settings 与 CSS 变量', async () => {
		const root = document.createElement('div');
		const { tab, saveSettings, settings } = makeTab('dark', 'follow');
		renderAppearanceSettings(root, tab);

		const teal = root.querySelector<HTMLButtonElement>(
			'.ratel-appearance-swatch[data-accent="teal"]',
		);
		expect(teal).toBeTruthy();
		teal!.click();
		await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());

		expect(settings.uiAccent).toBe('teal');
		const preview = root.querySelector('.ratel-appearance-preview') as HTMLElement;
		expect(preview.dataset.ratelAccent).toBe('teal');
		expect(preview.style.getPropertyValue('--interactive-accent').trim()).toBe('#009688');
		expect(teal!.classList.contains('is-selected')).toBe(true);
		expect(teal!.getAttribute('aria-checked')).toBe('true');
	});

	it('accent click - save 失败 - 回滚 settings 与预览', async () => {
		const root = document.createElement('div');
		const { tab, saveSettings, settings } = makeTab('auto', 'follow', async () => {
			throw new Error('disk full');
		});
		renderAppearanceSettings(root, tab);

		const teal = root.querySelector<HTMLButtonElement>(
			'.ratel-appearance-swatch[data-accent="teal"]',
		);
		teal!.click();
		await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());
		// 微任务回滚完成
		await Promise.resolve();
		await Promise.resolve();

		expect(settings.uiAccent).toBe('follow');
		const preview = root.querySelector('.ratel-appearance-preview') as HTMLElement;
		expect(preview.dataset.ratelAccent).toBeUndefined();
		expect(preview.style.getPropertyValue('--interactive-accent')).toBe('');
		const follow = root.querySelector<HTMLButtonElement>(
			'.ratel-appearance-swatch[data-accent="follow"]',
		);
		expect(follow!.getAttribute('aria-checked')).toBe('true');
	});

	it('scheme radiogroup - ArrowRight - 选中下一项', async () => {
		const root = document.createElement('div');
		const { tab, saveSettings, settings } = makeTab('auto', 'follow');
		renderAppearanceSettings(root, tab);

		const schemeRow = root.querySelector('.ratel-appearance-scheme') as HTMLElement;
		schemeRow.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
		);
		await vi.waitFor(() => expect(saveSettings).toHaveBeenCalled());
		expect(settings.uiColorScheme).toBe('light');
	});
});
