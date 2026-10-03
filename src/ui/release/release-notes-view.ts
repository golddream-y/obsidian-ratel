/**
 * @file src/ui/release/release-notes-view.ts
 * @description 更新说明页 — 工作区新标签，按笔记阅读视图排版
 * @module ui/release/release-notes-view
 * @depends obsidian, i18n
 */

import { ItemView, MarkdownRenderer, type WorkspaceLeaf } from 'obsidian';
import { tNow } from '../../i18n';
import type RatelVaultPlugin from '../../main';

/** 工作区视图类型。注册后，升级时用新标签打开，而不是对话框。 */
export const VIEW_TYPE_RELEASE_NOTES = 'ratel-release-notes';

const CHANGE_KEYS = [
	'modal.release.change.compact',
	'modal.release.change.move',
	'modal.release.change.agents',
	'modal.release.change.counts',
	'modal.release.change.profiles',
	'modal.release.change.obsidian',
] as const;

const SETUP_KEYS = [
	'modal.release.setup.provider',
	'modal.release.setup.model',
	'modal.release.setup.switch',
] as const;

/**
 * 拼出更新说明的 Markdown。标题用当前插件版本。
 *
 * @param version - manifest.version
 * @returns 交给 MarkdownRenderer 的正文
 */
export function buildReleaseNotesMarkdown(version: string): string {
	const changes = CHANGE_KEYS.map((key) => `- ${tNow(key)}`).join('\n');
	const setup = SETUP_KEYS.map((key, index) => `${index + 1}. ${tNow(key)}`).join('\n');
	return [
		`# ${tNow('modal.release.title', { version })}`,
		'',
		tNow('modal.release.lead'),
		'',
		`## ${tNow('modal.release.changesHeading')}`,
		'',
		changes,
		'',
		`## ${tNow('modal.release.setupHeading')}`,
		'',
		setup,
	].join('\n');
}

/**
 * 更新说明标签。内容用 MarkdownRenderer，样式走笔记的阅读视图。
 *
 * 关掉标签即离开。同一版本是否再自动打开，由调用方写入 lastSeenRelease。
 */
export class ReleaseNotesView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private readonly plugin: RatelVaultPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_RELEASE_NOTES;
	}

	getDisplayText(): string {
		return tNow('modal.release.title', { version: this.plugin.manifest.version });
	}

	getIcon(): string {
		return 'scroll-text';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		const preview = this.contentEl.createDiv({
			cls: 'markdown-preview-view markdown-rendered ratel-release-notes',
		});
		await MarkdownRenderer.render(
			this.app,
			buildReleaseNotesMarkdown(this.plugin.manifest.version),
			preview,
			'',
			this,
		);
		const actions = preview.createDiv({ cls: 'ratel-release-actions' });
		const open = actions.createEl('button', {
			text: tNow('modal.release.openSettings'),
			cls: 'mod-cta',
		});
		open.addEventListener('click', () => {
			void this.plugin.workspacePort.openPluginSettings('chat');
		});
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}

/**
 * 在工作区新开更新说明标签。已有则切过去，不叠第二页。
 *
 * @param plugin - 插件实例
 * @param markSeen - 为 true 时把当前版本记成已读，下次同版本不再自动打开
 */
export async function openReleaseNotesTab(plugin: RatelVaultPlugin, markSeen: boolean): Promise<void> {
	const existing = plugin.app.workspace.getLeavesOfType(VIEW_TYPE_RELEASE_NOTES);
	const leaf = existing[0] ?? plugin.app.workspace.getLeaf('tab');
	if (existing.length === 0) {
		await leaf.setViewState({ type: VIEW_TYPE_RELEASE_NOTES, active: true });
	}
	await plugin.app.workspace.revealLeaf(leaf);
	if (markSeen && plugin.settings.lastSeenRelease !== plugin.manifest.version) {
		plugin.settings.lastSeenRelease = plugin.manifest.version;
		await plugin.saveSettings();
	}
}
