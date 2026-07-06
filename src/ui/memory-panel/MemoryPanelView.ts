/**
 * @file src/ui/memory-panel/MemoryPanelView.ts
 * @description Obsidian `ItemView` 包装 — 挂载记忆管理 Svelte 组件并在关闭时销毁
 * @module ui/memory-panel/MemoryPanelView
 * @depends obsidian, svelte, ./MemoryPanel.svelte, ../../main
 *
 * 设计要点:
 * - 与 ChatView 同模式 — `mount()` 挂载 Svelte 5 组件,`unmount()` 释放。
 * - 视图类型 `ratel-memory-panel`,在 main.ts registerView 注册。
 * - 图标用 Lucide `brain`(记忆系统语义),不做 emoji 替换(区别于主聊天侧栏的 🦡)。
 * - 通过 props 注入 `plugin`,Svelte 组件调 `plugin.memoryStore` 读写记忆。
 */

import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';
import MemoryPanelComponent from './MemoryPanel.svelte';
import type RatelVaultPlugin from '../../main';
import { tNow } from '../../i18n';

/** Obsidian 工作区视图类型 — 唯一字符串,注册到 `registerView`。 */
export const VIEW_TYPE_MEMORY = 'ratel-memory-panel';

/**
 * Ratel 记忆管理面板的 Obsidian 视图。
 *
 * 设计要点:
 * - `onOpen` 时用 Svelte 5 的 `mount()` 把组件挂到 `containerEl.children[1]`(主内容区)。
 * - `onClose` 时调 `unmount()` 释放 Svelte 内部资源,避免内存泄漏。
 * - 关键路径:用 `mount` / `unmount` 而非 Svelte 4 风格 `new Component({...})` + `$destroy()`。
 *   Svelte 5 编译 export let 后的组件函数签名是 `(target, props)` 双参,
 *   旧的单参 options 对象调用会让第二个参数变 undefined,Svelte 5 effect 链
 *   内部对 undefined 用 in 算符找 Symbol($state) 直接抛。
 * - 持有 `plugin` 引用以便 Svelte 组件访问 `plugin.memoryStore` 与 `plugin.settings`。
 */
export class MemoryPanelView extends ItemView {
	component: ReturnType<typeof mount> | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: RatelVaultPlugin) {
		super(leaf);
	}

	/** Obsidian 框架要求 — 返回视图唯一类型字符串。 */
	getViewType(): string {
		return VIEW_TYPE_MEMORY;
	}

	/**
	 * 工作区标签上显示的标题。
	 *
	 * 关键路径:用 tNow 同步读,语言切换后下次打开面板生效。
	 */
	getDisplayText(): string {
		return tNow('memory.panel.title');
	}

	/**
	 * 工作区侧栏占位图标 — Lucide `brain`(记忆系统语义)。
	 *
	 * 关键路径:不调 patchChatLeafIcon — 那是主聊天侧栏 🦡 替换逻辑,
	 * 记忆面板保留 Lucide 图标,与 Obsidian 原生视觉一致。
	 */
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

		this.component = mount(MemoryPanelComponent, {
			target: container,
			props: {
				plugin: this.plugin,
			},
		});
	}

	/**
	 * 视图关闭时卸载 Svelte 组件并清空引用。
	 *
	 * 关键路径:不调 `unmount()` 会导致 Svelte 5 的 effect / signal 仍持有 DOM 引用,
	 * 在多次开关后出现内存泄漏。
	 */
	async onClose(): Promise<void> {
		if (this.component) {
			// 关键路径:unmount 返回 Promise,await 确保销毁完成再清空引用,避免浮动 Promise。
			await unmount(this.component);
			this.component = null;
		}
	}
}
