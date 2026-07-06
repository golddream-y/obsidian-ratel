/**
 * @file src/ui/secret-hint.ts
 * @description 设置页密钥说明块 — 展示固定密钥名 + 配置状态,替代明文密码框
 * @module ui/secret-hint
 * @depends obsidian, ../secrets/ratel-secrets, ../../i18n
 */

import { Setting } from 'obsidian';
// 关键路径:renderSecretHint 由 settings render wrapper 调用,每次重渲染时 tNow 即可
import { tNow } from '../../i18n';

/**
 * 渲染需要钥匙串密钥的说明块。
 *
 * 展示固定密钥名(带复制按钮)与配置状态(✅/⚠️)。
 * 不显示 Key 内容或前缀,仅展示是否已配置。
 *
 * @param containerEl - 设置面板容器
 * @param opts.secretId - RATEL_SECRET_IDS 中的密钥名
 * @param opts.hasKey - 钥匙串中是否已有该密钥
 * @param opts.note - 可选附加说明(如「未配置密钥时 Rerank 自动关闭」),追加到 desc 末尾
 */
export function renderSecretHint(
	containerEl: HTMLElement,
	opts: { secretId: string; hasKey: boolean; note?: string },
): void {
	// 关键路径:baseDesc 用 tNow 带 secretId 占位符替换,语言切换后立即生效
	const baseDesc = tNow('settings.advanced.secretHint.hint', { secretId: opts.secretId });
	new Setting(containerEl)
		.setName(tNow('settings.advanced.secretHint.title'))
		.setDesc(opts.note ? `${baseDesc}${opts.note}` : baseDesc)
		.addExtraButton((btn) => {
			btn.setIcon('copy').setTooltip(tNow('settings.advanced.secretHint.copyTooltip')).onClick(() => {
				void navigator.clipboard.writeText(opts.secretId);
			});
		});
	const status = containerEl.createDiv({ cls: 'ratel-secret-status' });
	status.setText(
		opts.hasKey
			? tNow('settings.advanced.secretHint.configured')
			: tNow('settings.advanced.secretHint.notConfigured'),
	);
}

/**
 * 渲染无需 Key 的说明块。
 *
 * @param containerEl - 设置面板容器
 * @param message - 说明文案(如"当前为内置本地 Embedding 模型,无需 API Key")
 */
export function renderNoKeyNeeded(containerEl: HTMLElement, message: string): void {
	new Setting(containerEl)
		.setName(tNow('settings.advanced.secretHint.title'))
		.setDesc(message);
}
