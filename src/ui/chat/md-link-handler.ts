/**
 * @file src/ui/chat/md-link-handler.ts
 * @description 正文 Markdown 链接点击代理 — 内部路径打开笔记,外链交系统浏览器
 * @module ui/chat/md-link-handler
 * @depends utils/open-external-url
 */

import { openExternalUrl } from '../../utils/open-external-url';

/** 链接点击的外部依赖。 */
export interface MarkdownLinkHandlers {
	/** 打开 vault 内笔记;缺省时内部链接仍阻止默认导航,只是不打开。 */
	onOpenPath?: (path: string) => void;
}

/**
 * 是否外部链接。
 *
 * @param href - 原始 href
 * @returns http/https/mailto 为 true
 */
export function isExternalHref(href: string): boolean {
	return /^(?:https?:|mailto:)/i.test(href);
}

/**
 * href 转 vault 相对路径。
 *
 * @param href - 原始 href
 * @returns 解码后的相对路径
 */
export function hrefToVaultPath(href: string): string {
	let path = href;
	try {
		path = decodeURIComponent(href);
	} catch {
		/* 非法转义按原文处理 */
	}
	return path.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * 在正文容器上代理链接点击。
 *
 * 关键路径:正文由 marked 渲染成裸 `<a href>`,没有 Obsidian 阅读视图的
 * `internal-link` / `external-link` 类,那套全局点击代理不会命中;不自己代理时
 * 点击既不会打开笔记,也不会打开浏览器(默认导航被 Electron 外壳拦掉)。
 *
 * @param container - 渲染正文的容器(innerHTML 会被整体替换,但容器本身稳定)
 * @param handlers - 内部链接处理器
 * @returns 解绑函数
 */
export function bindMarkdownLinkClick(
	container: HTMLElement,
	handlers: MarkdownLinkHandlers,
): () => void {
	const onClick = (event: MouseEvent): void => {
		if (event.button !== 0) return;
		const target = event.target instanceof Element ? event.target : null;
		const anchor = target?.closest('a');
		if (!anchor || !container.contains(anchor)) return;
		const href = anchor.getAttribute('href')?.trim();
		if (!href) return;
		event.preventDefault();
		event.stopPropagation();
		if (isExternalHref(href)) {
			void openExternalUrl(href);
			return;
		}
		// 页内锚点没有可打开的文档,保持不动。
		if (href.startsWith('#')) return;
		handlers.onOpenPath?.(hrefToVaultPath(href));
	};
	container.addEventListener('click', onClick);
	return () => container.removeEventListener('click', onClick);
}
