/**
 * @file src/ui/secret-hint.ts
 * @description 设置页密钥说明块 — 展示固定密钥名 + 配置状态,替代明文密码框
 * @module ui/secret-hint
 * @depends obsidian, ../secrets/ratel-secrets
 */

import { Setting } from 'obsidian';

/**
 * 渲染需要钥匙串密钥的说明块。
 *
 * 展示固定密钥名(带复制按钮)与配置状态(✅/⚠️)。
 * 不显示 Key 内容或前缀,仅展示是否已配置。
 *
 * @param containerEl - 设置面板容器
 * @param opts.secretId - RATEL_SECRET_IDS 中的密钥名
 * @param opts.hasKey - 钥匙串中是否已有该密钥
 */
export function renderSecretHint(
	containerEl: HTMLElement,
	opts: { secretId: string; hasKey: boolean },
): void {
	new Setting(containerEl)
		.setName('API 密钥')
		.setDesc(
			`请在 Obsidian「设置 → 钥匙串」中添加名称为「${opts.secretId}」的密钥(名称必须完全一致)。` +
				'密钥不会写入插件配置,也不会随库同步到其他设备。',
		)
		.addExtraButton((btn) => {
			btn.setIcon('copy').setTooltip('复制密钥名').onClick(() => {
				void navigator.clipboard.writeText(opts.secretId);
			});
		});
	const status = containerEl.createDiv({ cls: 'ratel-secret-status' });
	status.setText(opts.hasKey ? '状态: ✅ 已配置' : '状态: ⚠️ 未配置');
}

/**
 * 渲染无需 Key 的说明块。
 *
 * @param containerEl - 设置面板容器
 * @param message - 说明文案(如"当前为内置本地 Embedding 模型,无需 API Key")
 */
export function renderNoKeyNeeded(containerEl: HTMLElement, message: string): void {
	new Setting(containerEl).setName('API 密钥').setDesc(message);
}
