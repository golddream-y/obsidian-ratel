/**
 * @file src/ui/components/secret-hint.ts
 * @description 设置页密钥说明块 — checklist + 固定密钥名 + 配置状态,替代明文密码框
 * @module ui/components/secret-hint
 * @depends obsidian, ../../i18n
 */

import { Setting } from 'obsidian';
// 关键路径:renderSecretHint 由 settings render wrapper 调用,每次重渲染时 tNow 即可
import { tNow } from '../../i18n';

/**
 * 渲染需要钥匙串密钥的说明块(checklist)。
 *
 * 展示三步清单:打开钥匙串 → 添加同名密钥(可复制) → 配置状态(✅/⚠️)。
 * 不显示 Key 内容或前缀,仅展示是否已配置。
 *
 * @param containerEl - 设置面板容器
 * @param opts.secretId - RATEL_SECRET_IDS 中的密钥名
 * @param opts.hasKey - 钥匙串中是否已有该密钥
 * @param opts.note - 可选附加说明(如「未配置密钥时 Rerank 自动关闭」),追加到末尾
 */
export function renderSecretHint(
	containerEl: HTMLElement,
	opts: { secretId: string; hasKey: boolean; note?: string },
): void {
	// 修复:声明式 SettingTab.update() 会再次调用 render,必须先清空再画,
	// 否则每敲一键追加一块,Obsidian .setting-item 横向 flex 会变成窄列墙。
	containerEl.empty();
	const wrap = containerEl.createDiv({ cls: 'ratel-secret-hint' });

	new Setting(wrap)
		.setName(tNow('settings.advanced.secretHint.title'))
		.setDesc(tNow('settings.advanced.secretHint.privacy'))
		.addExtraButton((btn) => {
			btn
				.setIcon('copy')
				.setTooltip(tNow('settings.advanced.secretHint.copyTooltip'))
				.onClick(() => {
					void navigator.clipboard.writeText(opts.secretId);
				});
		});

	const list = wrap.createEl('ol', { cls: 'ratel-secret-checklist' });
	list.createEl('li', { text: tNow('settings.advanced.secretHint.stepOpen') });

	const idLi = list.createEl('li');
	idLi.appendText(tNow('settings.advanced.secretHint.stepAddPrefix'));
	idLi.createEl('code', {
		cls: 'ratel-secret-checklist-id',
		text: opts.secretId,
	});
	idLi.appendText(tNow('settings.advanced.secretHint.stepAddSuffix'));

	list.createEl('li', {
		text: opts.hasKey
			? tNow('settings.advanced.secretHint.configured')
			: tNow('settings.advanced.secretHint.notConfigured'),
	});

	if (opts.note) {
		wrap.createDiv({ cls: 'setting-item-description', text: opts.note });
	}
}

/**
 * 渲染无需 Key 的说明块。
 *
 * @param containerEl - 设置面板容器
 * @param message - 说明文案(如"当前为内置本地 Embedding 模型,无需 API Key")
 */
export function renderNoKeyNeeded(containerEl: HTMLElement, message: string): void {
	// 修复:与 renderSecretHint 相同 — update() 重入时先清空
	containerEl.empty();
	new Setting(containerEl)
		.setName(tNow('settings.advanced.secretHint.title'))
		.setDesc(message);
}
