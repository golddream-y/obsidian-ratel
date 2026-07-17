/**
 * @file src/utils/badger-icon.ts
 * @description Ratel 品牌图标 — Lucide 无獾,用 emoji 替换 Obsidian 默认 SVG
 * @module utils/badger-icon
 */

import type { Workspace, WorkspaceLeaf } from 'obsidian';

export const BADGER_EMOJI = '🦡';

const VIEW_TYPE_CHAT = 'ratel-chat';

function createEmojiSpan(text: string): HTMLSpanElement {
	// 安全路径:activeDocument + createSpan 兼容 popout,并满足商店 prefer-create-el
	const span = activeDocument.body.createSpan({ text });
	span.remove();
	return span;
}

/**
 * 将图标容器内的 Lucide SVG 替换为蜜獾 emoji。
 *
 * @param iconContainer - 含 svg 的图标容器
 */
export function applyBadgerEmojiToElement(iconContainer: HTMLElement): void {
	const svg = iconContainer.querySelector('svg');
	if (svg) {
		svg.replaceWith(createEmojiSpan(BADGER_EMOJI));
		return;
	}
	if (!iconContainer.textContent?.includes(BADGER_EMOJI)) {
		iconContainer.replaceChildren(createEmojiSpan(BADGER_EMOJI));
	}
}

function patchTabHeaderElement(tabHeader: HTMLElement): void {
	const icon = tabHeader.querySelector('.workspace-tab-header-inner-icon');
	// 关键路径:用 .instanceOf() 替代 instanceof 做 cross-window 安全类型检查
	if (icon?.instanceOf(HTMLElement)) {
		applyBadgerEmojiToElement(icon);
	}
}

function getTabHeaderForLeaf(leaf: WorkspaceLeaf): HTMLElement | null {
	const leafAny = leaf as unknown as { tabHeaderEl?: HTMLElement };
	if (leafAny.tabHeaderEl) {
		return leafAny.tabHeaderEl;
	}

	const viewType = leaf.view?.getViewType?.();
	if (viewType !== VIEW_TYPE_CHAT) {
		return null;
	}

	// 关键路径:用 activeDocument 兼容 popout 窗口
	const headers = activeDocument.querySelectorAll(
		`.workspace-tab-header[data-type="${VIEW_TYPE_CHAT}"]`,
	);
	for (const header of Array.from(headers)) {
		const headerEl = header as HTMLElement;
		const headerLeaf = (headerEl as unknown as { leaf?: WorkspaceLeaf }).leaf;
		if (headerLeaf === leaf) {
			return headerEl;
		}
	}

	if (headers.length === 1) {
		return headers[0] as HTMLElement;
	}

	return null;
}

/**
 * 修补单个 Chat 工作区 leaf 的标签/标题栏图标(右侧边栏 tab、视图顶栏等)。
 *
 * @param leaf - Ratel Chat 所在的 WorkspaceLeaf
 */
export function patchChatLeafIcon(leaf: WorkspaceLeaf): void {
	const tabHeader = getTabHeaderForLeaf(leaf);
	if (tabHeader) {
		patchTabHeaderElement(tabHeader);
	}

	const containerEl = leaf.view?.containerEl;
	if (!containerEl) {
		return;
	}
	const viewHeaderIcon = containerEl.querySelector('.view-header-icon');
	// 关键路径:用 .instanceOf() 替代 instanceof 做 cross-window 安全类型检查
	if (viewHeaderIcon?.instanceOf(HTMLElement)) {
		applyBadgerEmojiToElement(viewHeaderIcon);
	}
}

/**
 * 修补页面上所有 ratel-chat 图标 — layout-change 后调用。
 *
 * 关键路径:`.workspace-tab-header` 在 tab 条上,不在 `.workspace-leaf` 内部,
 * 必须按 `data-type="ratel-chat"` 单独查询。
 */
export function patchAllChatLeafIcons(workspace?: Workspace): void {
	// 关键路径:用 activeDocument 兼容 popout 窗口;
	// 用 .instanceOf() 替代 instanceof 做 cross-window 安全类型检查
	activeDocument
		.querySelectorAll(
			`.workspace-tab-header[data-type="${VIEW_TYPE_CHAT}"] .workspace-tab-header-inner-icon`,
		)
		.forEach((el: Element) => {
			if (el.instanceOf(HTMLElement)) {
				applyBadgerEmojiToElement(el);
			}
		});

	activeDocument
		.querySelectorAll(
			`.workspace-leaf[data-type="${VIEW_TYPE_CHAT}"] .view-header-icon`,
		)
		.forEach((el: Element) => {
			if (el.instanceOf(HTMLElement)) {
				applyBadgerEmojiToElement(el);
			}
		});

	workspace?.iterateAllLeaves((leaf) => {
		if (leaf.view?.getViewType?.() === VIEW_TYPE_CHAT) {
			patchChatLeafIcon(leaf);
		}
	});
}
