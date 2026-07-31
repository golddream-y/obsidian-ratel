/**
 * @file src/ui/memory-panel/MemoryModal.ts
 * @description 记忆管理 Modal — 挂载全量 MemoryPanel,与 FeedbackModal 同属次要能力壳
 * @module ui/memory-panel/MemoryModal
 * @depends obsidian, svelte, ./MemoryPanel.svelte, ../../i18n
 */

import { App, Modal } from 'obsidian';
import { mount, unmount } from 'svelte';
import MemoryPanel from './MemoryPanel.svelte';
import type RatelVaultPlugin from '../../main';
import { tNow } from '../../i18n';
import { applyRatelAppearance } from '../appearance/apply-ratel-appearance';

/**
 * 是否应新建 Modal — 已有实例则 false。
 *
 * @param current - 插件持有的当前 MemoryModal 单例引用
 * @returns 无实例时 true,允许新建;已有实例时 false
 */
export function shouldCreateMemoryModal(current: MemoryModal | null): boolean {
	return current === null;
}

/**
 * 记忆管理 Modal。
 *
 * 设计要点:
 * - onOpen mount MemoryPanel(embeddedInModal=true);onClose unmount + empty
 * - 关键路径:Svelte 5 必须用 mount/unmount,禁止 new Component
 */
export class MemoryModal extends Modal {
	private component: ReturnType<typeof mount> | null = null;
	/** 关闭时回调,供 plugin 清掉单例引用 */
	onClosed: (() => void) | null = null;

	constructor(
		app: App,
		private plugin: RatelVaultPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText(tNow('memory.panel.title'));
		// 关键路径:宽度/高度必须挂在 modalEl（.modal 外框）,挂 contentEl 无法撑开 Obsidian 默认窄弹框。
		this.modalEl.addClass('ratel-memory-modal-shell');
		this.contentEl.empty();
		this.contentEl.addClass('ratel-memory-modal');
		applyRatelAppearance(this.contentEl, {
			uiColorScheme: this.plugin.settings.uiColorScheme,
			uiAccent: this.plugin.settings.uiAccent,
		});
		this.component = mount(MemoryPanel, {
			target: this.contentEl,
			props: { plugin: this.plugin, embeddedInModal: true },
		});
	}

	async onClose(): Promise<void> {
		if (this.component) {
			// 关键路径:与 ChatView 一致 — await unmount 完成后再 empty,避免 Svelte 5 异步销毁竞态。
			await unmount(this.component);
			this.component = null;
		}
		this.contentEl.empty();
		this.onClosed?.();
		this.onClosed = null;
	}
}
