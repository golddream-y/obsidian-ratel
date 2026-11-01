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
 * 索引诊断切片 — 只放状态、计数与代际 ID,绝不放笔记正文、路径清单或密钥。
 *
 * 关键路径:`epochSourceMissing` 为真时必须如实呈现「本轮缺少 epoch 保护」,
 * 不允许静默;`recordsKind` 为 `unjudgeable` 时不得显示成「0 篇可检索」。
 */
export interface FeedbackIndexDiagnostics {
	/** 当前索引阶段(含 stalled/stopping/migrating)。 */
	phase?: string;
	/** 已提交且可检索的文件数。 */
	committed?: number;
	/** 本轮已知文件总数。 */
	total?: number;
	/** 待处理文件数。 */
	pending?: number;
	/** 本轮失败数。 */
	failed?: number;
	/** 本轮是否缺少 epoch 保护。 */
	epochSourceMissing?: boolean;
	/** 可信完成记录是否可判定。 */
	recordsKind?: 'known' | 'unjudgeable';
	/** 记录集与当前配置的关系。 */
	recordsConfig?: 'current' | 'mismatch' | 'unknown';
	/** 当前活动代际 ID。 */
	activeGenerationId?: string | null;
	/** 迁移结论阶段(发生迁移时)。 */
	migrationPhase?: string;
}

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
	breadcrumbs?: { readRecentLines(limit?: number): string[] };
	/** 索引诊断提供者;未提供时摘要不新增索引段。 */
	indexDiagnostics?: () => FeedbackIndexDiagnostics | null | undefined;
}

/**
 * 组装诊断摘要 — 仅版本/模型/语言等,不含笔记正文与密钥。
 *
 * @param plugin - plugin 切片
 * @param recentBreadcrumbs - 可选最近崩溃面包屑行(不含用户消息/笔记正文)
 * @returns 可粘贴到 Issue 的纯文本
 */
export function buildFeedbackDiagnostics(
	plugin: PluginLike,
	recentBreadcrumbs?: string[],
): string {
	const lines = [
		`Ratel ${plugin.manifest.version} (${plugin.manifest.id})`,
		`Obsidian: ${(plugin.app as unknown as { appVersion?: string }).appVersion ?? 'unknown'}`,
		`Locale: ${plugin.settings.language || 'zh'}`,
		`Chat model: ${plugin.settings.chatModel || '(unset)'}`,
		`Embed: ${plugin.settings.embedProvider}`,
		'',
	];
	const index = readIndexDiagnostics(plugin);
	if (index) {
		lines.push(tNow('chat.feedback.diag.indexHeading'));
		if (index.phase !== undefined) lines.push(tNow('chat.feedback.diag.indexPhase', { phase: index.phase }));
		if (index.committed !== undefined || index.total !== undefined) {
			lines.push(tNow('chat.feedback.diag.indexCounts', {
				committed: index.committed ?? 0,
				total: index.total ?? 0,
				pending: index.pending ?? 0,
				failed: index.failed ?? 0,
			}));
		}
		if (index.recordsKind !== undefined || index.recordsConfig !== undefined) {
			lines.push(tNow('chat.feedback.diag.indexTrust', {
				kind: index.recordsKind ?? 'known',
				config: index.recordsConfig ?? 'current',
			}));
		}
		if (index.activeGenerationId) {
			lines.push(tNow('chat.feedback.diag.indexGeneration', { id: index.activeGenerationId }));
		}
		if (index.migrationPhase !== undefined) {
			lines.push(tNow('chat.feedback.diag.indexMigration', { phase: index.migrationPhase }));
		}
		if (index.epochSourceMissing === true) {
			lines.push(tNow('chat.feedback.diag.indexEpochMissing'));
		}
		lines.push('');
	}
	if (recentBreadcrumbs && recentBreadcrumbs.length > 0) {
		lines.push('Breadcrumbs (last 40, no message text):');
		lines.push(...recentBreadcrumbs);
		lines.push('');
	}
	lines.push('<!-- 请描述问题 / 期望行为;不要粘贴笔记正文或 API Key -->');
	return lines.join('\n');
}

/** 读取索引诊断切片 — 提供者抛错时按「无此段」处理,诊断本身不能阻断反馈入口。 */
function readIndexDiagnostics(plugin: PluginLike): FeedbackIndexDiagnostics | null {
	try {
		return plugin.indexDiagnostics?.() ?? null;
	} catch {
		return null;
	}
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

		const recent = this.plugin.breadcrumbs?.readRecentLines(40) ?? [];
		const diag = buildFeedbackDiagnostics(this.plugin, recent);
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
