/**
 * @file src/ui/chat/feedback-modal.ts
 * @description 问题反馈原型 Modal — 外链 GitHub Issues + 复制诊断摘要(不含笔记正文)
 * @module ui/chat/feedback-modal
 * @depends obsidian, i18n
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import { tNow } from '../../i18n';
import { openExternalUrl } from '../../utils/open-external-url';

/** Issues 仓库(原型固定;后续可配置) */
const FEEDBACK_ISSUES_URL = 'https://github.com/golddream-y/obsidian-ratel/issues/new';

/**
 * Modal 所需的最小 plugin 切片。
 */
interface PluginLike {
	app: App;
	manifest: { version: string; id: string };
	settings: {
		chatModel: string;
		embedProvider: 'local' | 'api';
		language: string;
	};
}

/**
 * 组装诊断摘要 — 仅版本/模型/语言等,不含笔记正文与密钥。
 *
 * @param plugin - plugin 切片
 * @returns 可粘贴到 Issue 的纯文本
 */
export function buildFeedbackDiagnostics(plugin: PluginLike): string {
	const lines = [
		`Ratel ${plugin.manifest.version} (${plugin.manifest.id})`,
		`Obsidian: ${(plugin.app as unknown as { appVersion?: string }).appVersion ?? 'unknown'}`,
		`Locale: ${plugin.settings.language || 'zh'}`,
		`Chat model: ${plugin.settings.chatModel || '(unset)'}`,
		`Embed: ${plugin.settings.embedProvider}`,
		'',
		'<!-- 请描述问题 / 期望行为;不要粘贴笔记正文或 API Key -->',
	];
	return lines.join('\n');
}

/**
 * 问题反馈原型 Modal。
 *
 * 设计要点:
 * - 外链 GitHub Issues,不上传遥测
 * - 一键复制诊断摘要,方便用户粘贴
 * - 文案走 i18n
 */
export class FeedbackModal extends Modal {
	constructor(
		app: App,
		private plugin: PluginLike,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('chat.feedback.title'));
		this.contentEl.empty();

		this.contentEl.createEl('p', {
			text: tNow('chat.feedback.body'),
			cls: 'ratel-feedback-body',
		});

		const diag = buildFeedbackDiagnostics(this.plugin);
		const pre = this.contentEl.createEl('pre', { cls: 'ratel-feedback-diag' });
		pre.setText(diag);

		new Setting(this.contentEl)
			.addButton((btn) => {
				btn
					.setButtonText(tNow('chat.feedback.copyDiag'))
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(diag);
							new Notice(tNow('chat.feedback.copyOk'));
						} catch {
							new Notice(tNow('chat.feedback.copyFail'));
						}
					});
			})
			.addButton((btn) => {
				btn
					.setButtonText(tNow('chat.feedback.openIssues'))
					.setCta()
					.onClick(() => {
						const url =
							FEEDBACK_ISSUES_URL +
							'?body=' +
							encodeURIComponent(diag + '\n\n');
						void openExternalUrl(url);
					});
			});
	}
}
