/**
 * @file src/ui/ChatView.ts
 * @description Obsidian `ItemView` 包装 — 挂载 Svelte 组件并在关闭时销毁
 * @module ui/ChatView
 * @depends obsidian, ./ChatView.svelte, ../main
 */

import { ItemView, type WorkspaceLeaf } from 'obsidian';
import ChatViewComponent from './ChatView.svelte';
import type RatelVaultPlugin from '../main';

/** Obsidian 工作区视图类型 — 唯一字符串,注册到 `registerView`。 */
export const VIEW_TYPE_CHAT = 'ratel-chat';

/**
 * Ratel 聊天侧栏的 Obsidian 视图。
 *
 * 设计要点:
 * - `onOpen` 时把 Svelte 组件 mount 到 `containerEl.children[1]`(主内容区)。
 * - `onClose` 时调用 `$destroy()` 释放 Svelte 内部资源,避免内存泄漏。
 * - 持有 `plugin` 引用以便 Svelte 组件访问主线程 API(`ask`、`persistence` 等)。
 */
export class ChatView extends ItemView {
	component: { $destroy: () => void } | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: RatelVaultPlugin) {
		super(leaf);
	}

	/** Obsidian 框架要求 — 返回视图唯一类型字符串。 */
	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	/** 工作区标签上显示的标题。 */
	getDisplayText(): string {
		return 'Ratel Chat';
	}

	/** 工作区侧栏显示的图标 — 'brain' 是 lucide 内置图标。 */
	getIcon(): string {
		return 'brain';
	}

	/**
	 * 视图打开时挂载 Svelte 组件。
	 *
	 * 关键路径:`containerEl.children[1]` 是 Obsidian 分配给 `ItemView` 的内容容器;
	 * 第一个 child 是视图标题栏,第二个才是放业务内容的地方。
	 */
	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();

		this.component = new ChatViewComponent({
			target: container,
			props: {
				plugin: this.plugin,
			},
		}) as { $destroy: () => void };
	}

	/**
	 * 视图关闭时销毁 Svelte 组件并清空引用。
	 *
	 * 关键路径:不调 `$destroy()` 会导致 Svelte 5 的 effect / signal 仍持有 DOM 引用,
	 * 在多次开关后出现内存泄漏。
	 */
	async onClose(): Promise<void> {
		this.component?.$destroy();
		this.component = null;
	}
}
