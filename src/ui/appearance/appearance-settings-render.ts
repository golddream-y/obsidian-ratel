/**
 * @file src/ui/appearance/appearance-settings-render.ts
 * @description 设置「外观」Tab 主体 — 预览卡 + 分段亮暗 + 强调色色块
 * @module ui/appearance/appearance-settings-render
 * @depends ./appearance-presets, ./apply-ratel-appearance, ./appearance-store, ../../i18n, ../../settings
 */

import { Notice } from 'obsidian';
import { tNow, type StringKey } from '../../i18n';
import type { RatelVaultSettingTab } from '../../settings';
import {
	APPEARANCE_PRESETS,
	type UiAccentId,
	type UiColorScheme,
} from './appearance-presets';
import { applyRatelAppearance } from './apply-ratel-appearance';
import { bumpAppearance } from './appearance-store';

const SCHEME_OPTIONS: ReadonlyArray<{ id: UiColorScheme; labelKey: StringKey }> = [
	{ id: 'auto', labelKey: 'settings.appearance.scheme.auto' },
	{ id: 'light', labelKey: 'settings.appearance.scheme.light' },
	{ id: 'dark', labelKey: 'settings.appearance.scheme.dark' },
];

const ACCENT_LABEL_KEYS: Record<UiAccentId, StringKey> = {
	follow: 'settings.appearance.accent.follow',
	copper: 'settings.appearance.accent.copper',
	red: 'settings.appearance.accent.red',
	purple: 'settings.appearance.accent.purple',
	indigo: 'settings.appearance.accent.indigo',
	blue: 'settings.appearance.accent.blue',
	teal: 'settings.appearance.accent.teal',
	green: 'settings.appearance.accent.green',
	orange: 'settings.appearance.accent.orange',
	pink: 'settings.appearance.accent.pink',
};

/**
 * 外观预览词标 — 复用 Chat 标题,末尾补句点以匹配设计稿。
 *
 * @returns 预览品牌文案(如 "Ratel.")
 */
function formatPreviewBrand(): string {
	const title = tNow('chat.header.title').trimEnd();
	return title.endsWith('.') ? title : `${title}.`;
}

/**
 * 将当前 scheme 映射为状态行文案 key。
 *
 * @param scheme - 配色方案
 * @returns i18n key
 */
function schemeStatusKey(scheme: UiColorScheme): StringKey {
	if (scheme === 'light') return 'settings.appearance.status.light';
	if (scheme === 'dark') return 'settings.appearance.status.dark';
	return 'settings.appearance.status.followScheme';
}

/**
 * 为 radiogroup 绑定方向键 / Home / End(roving tabindex 由 refresh 维护)。
 *
 * @param group - radiogroup 容器
 * @param getButtons - 按 DOM 顺序取 radio 按钮
 * @param onSelectIndex - 选中第 i 项(触发业务变更)
 */
function bindRadioGroupKeys(
	group: HTMLElement,
	getButtons: () => HTMLButtonElement[],
	onSelectIndex: (index: number) => void,
): void {
	group.addEventListener('keydown', (ev) => {
		const buttons = getButtons();
		if (buttons.length === 0) return;
		const current = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
		const from = current >= 0 ? current : 0;
		let next = from;
		if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
			next = (from + 1) % buttons.length;
		} else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
			next = (from - 1 + buttons.length) % buttons.length;
		} else if (ev.key === 'Home') {
			next = 0;
		} else if (ev.key === 'End') {
			next = buttons.length - 1;
		} else {
			return;
		}
		ev.preventDefault();
		onSelectIndex(next);
		buttons[next]?.focus();
	});
}

/**
 * 渲染设置「外观」Tab 主体(预览优先 + 分段 + 色块)。
 *
 * 设计要点:
 * - 预览根与 Chat/Memory 共用 {@link applyRatelAppearance},禁止第二套样式。
 * - 乐观更新:先改 settings + 预览 + bump,再 save;失败回滚并 Notice。
 * - 禁止用两个普通 dropdown 作为主控件。
 *
 * @param containerEl - 声明式 setting 的 settingEl
 * @param tab - SettingTab,提供 plugin.settings / saveSettings
 */
export function renderAppearanceSettings(
	containerEl: HTMLElement,
	tab: RatelVaultSettingTab,
): void {
	const plugin = tab.plugin;
	// 安全路径:用 Obsidian createEl/createDiv/createSpan,避免商店 prefer-create-el 告警。
	const root = containerEl.createDiv({ cls: 'ratel-appearance-settings' });

	const preview = root.createDiv({ cls: 'ratel-appearance-preview' });

	preview.createDiv({ cls: 'ratel-appearance-preview-brand', text: formatPreviewBrand() });

	const body = preview.createEl('p', { cls: 'ratel-appearance-preview-body' });
	body.appendText(tNow('settings.appearance.preview.body') + ' ');
	// 预览装饰:用 span,避免假控件进入 Tab 序
	body.createSpan({
		cls: 'ratel-cite',
		text: '[1]',
		attr: { 'aria-hidden': 'true' },
	});

	const cites = preview.createDiv({
		cls: 'ratel-cites-row',
		attr: { 'aria-hidden': 'true' },
	});
	const chip = cites.createSpan({ cls: 'ratel-cite-chip' });
	chip.createSpan({ cls: 'ratel-cite-chip-n', text: '1' });
	chip.createSpan({
		cls: 'ratel-cite-chip-path',
		text: tNow('settings.appearance.preview.citePath'),
	});

	const shell = preview.createDiv({ cls: 'ratel-appearance-preview-shell ratel-input-shell' });
	shell.createDiv({
		cls: 'ratel-appearance-preview-input',
		attr: { 'aria-hidden': 'true' },
	});
	shell.createSpan({
		cls: 'ratel-send',
		text: tNow('settings.appearance.preview.send'),
		attr: { 'aria-hidden': 'true' },
	});

	const status = preview.createDiv({ cls: 'ratel-appearance-preview-status' });

	root.createDiv({
		cls: 'ratel-appearance-control-label',
		text: tNow('settings.appearance.scheme.name'),
		attr: { id: 'ratel-appearance-scheme-label' },
	});

	const schemeRow = root.createDiv({
		cls: 'ratel-appearance-scheme',
		attr: {
			role: 'radiogroup',
			'aria-labelledby': 'ratel-appearance-scheme-label',
		},
	});

	root.createDiv({
		cls: 'ratel-appearance-control-label',
		text: tNow('settings.appearance.accent.name'),
		attr: { id: 'ratel-appearance-accent-label' },
	});

	const swatchRow = root.createDiv({
		cls: 'ratel-appearance-swatches',
		attr: {
			role: 'radiogroup',
			'aria-labelledby': 'ratel-appearance-accent-label',
		},
	});

	root.createEl('p', {
		cls: 'ratel-appearance-hint setting-item-description',
		text: tNow('settings.appearance.hint'),
	});

	const schemeButtons = new Map<UiColorScheme, HTMLButtonElement>();
	const schemeOrder: UiColorScheme[] = [];
	for (const opt of SCHEME_OPTIONS) {
		const btn = schemeRow.createEl('button', {
			cls: 'ratel-appearance-scheme-btn',
			text: tNow(opt.labelKey),
			attr: { type: 'button', role: 'radio' },
		});
		btn.dataset.scheme = opt.id;
		btn.onclick = () => void onSchemeChange(opt.id);
		schemeButtons.set(opt.id, btn);
		schemeOrder.push(opt.id);
	}

	const accentButtons = new Map<UiAccentId, HTMLButtonElement>();
	const accentOrder: UiAccentId[] = [];
	const followLabel = tNow('settings.appearance.accent.follow');
	const followBtn = swatchRow.createEl('button', {
		cls: 'ratel-appearance-swatch ratel-appearance-swatch-follow',
		text: followLabel,
		title: followLabel,
		attr: {
			type: 'button',
			role: 'radio',
			'aria-label': followLabel,
		},
	});
	followBtn.dataset.accent = 'follow';
	followBtn.onclick = () => void onAccentChange('follow');
	accentButtons.set('follow', followBtn);
	accentOrder.push('follow');

	for (const preset of APPEARANCE_PRESETS) {
		const label = tNow(ACCENT_LABEL_KEYS[preset.id]);
		const btn = swatchRow.createEl('button', {
			cls: 'ratel-appearance-swatch',
			title: label,
			attr: {
				type: 'button',
				role: 'radio',
				'aria-label': label,
			},
		});
		btn.dataset.accent = preset.id;
		btn.style.background = preset.hex;
		btn.onclick = () => void onAccentChange(preset.id);
		accentButtons.set(preset.id, btn);
		accentOrder.push(preset.id);
	}

	bindRadioGroupKeys(
		schemeRow,
		() => schemeOrder.map((id) => schemeButtons.get(id)!),
		(i) => void onSchemeChange(schemeOrder[i]!),
	);
	bindRadioGroupKeys(
		swatchRow,
		() => accentOrder.map((id) => accentButtons.get(id)!),
		(i) => void onAccentChange(accentOrder[i]!),
	);

	/**
	 * 根据当前 settings 刷新预览 dataset/CSS 变量与控件选中态。
	 */
	function refreshPreview(): void {
		const { uiColorScheme, uiAccent } = plugin.settings;
		applyRatelAppearance(preview, { uiColorScheme, uiAccent });
		status.textContent = `${tNow(schemeStatusKey(uiColorScheme))} · ${tNow(ACCENT_LABEL_KEYS[uiAccent])}`;

		for (const [id, btn] of schemeButtons) {
			const selected = id === uiColorScheme;
			btn.setAttribute('aria-checked', selected ? 'true' : 'false');
			btn.tabIndex = selected ? 0 : -1;
			btn.classList.toggle('is-selected', selected);
		}
		for (const [id, btn] of accentButtons) {
			const selected = id === uiAccent;
			btn.setAttribute('aria-checked', selected ? 'true' : 'false');
			btn.tabIndex = selected ? 0 : -1;
			btn.classList.toggle('is-selected', selected);
		}
	}

	/**
	 * 乐观切换颜色模式:先预览+bump,再落盘;失败回滚。
	 *
	 * @param scheme - 新配色方案
	 */
	async function onSchemeChange(scheme: UiColorScheme): Promise<void> {
		if (plugin.settings.uiColorScheme === scheme) return;
		const prev = plugin.settings.uiColorScheme;
		plugin.settings.uiColorScheme = scheme;
		refreshPreview();
		bumpAppearance();
		try {
			await plugin.saveSettings();
		} catch (err) {
			plugin.settings.uiColorScheme = prev;
			refreshPreview();
			bumpAppearance();
			devNoticeSaveFailed(err);
		}
	}

	/**
	 * 乐观切换强调色:先预览+bump,再落盘;失败回滚。
	 *
	 * @param accent - 新强调色 ID
	 */
	async function onAccentChange(accent: UiAccentId): Promise<void> {
		if (plugin.settings.uiAccent === accent) return;
		const prev = plugin.settings.uiAccent;
		plugin.settings.uiAccent = accent;
		refreshPreview();
		bumpAppearance();
		try {
			await plugin.saveSettings();
		} catch (err) {
			plugin.settings.uiAccent = prev;
			refreshPreview();
			bumpAppearance();
			devNoticeSaveFailed(err);
		}
	}

	refreshPreview();
}

/**
 * 保存失败时提示用户(可再点同一选项重试,因已回滚)。
 *
 * @param err - 原始错误
 */
function devNoticeSaveFailed(err: unknown): void {
	const detail = err instanceof Error ? err.message : String(err);
	new Notice(`${tNow('settings.appearance.saveFailed')}${detail ? `: ${detail}` : ''}`);
}
