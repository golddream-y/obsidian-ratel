<script lang="ts">
	/**
	 * @file src/ui/components/MarkdownView.svelte
	 * @description Markdown 流式渲染 — rAF 节流 + marked + DOMPurify + mermaid + cite 挂钩
	 * @module ui/components/MarkdownView
	 * @depends utils/markdown-renderer, utils/mermaid-renderer, ui/chat/cite-enhance
	 */

	import { onDestroy } from 'svelte';
	import { renderMarkdownToHtml, areAllCodeBlocksClosed } from '../../utils/markdown-renderer';
	import { renderMermaidBlocks } from '../../utils/mermaid-renderer';
	import { enhanceCiteLinks } from '../chat/cite-enhance';
	import { bindCitePathTooltip } from '../chat/cite-path-tooltip';
	import { pathForCiteIndex } from '../chat/open-chat-note';
	import { tNow } from '../../i18n';
	import {
		CITE_EACH_STAGGER_MS,
		shouldStaggerCite,
	} from '../motion/enter/cite-policy';
	import { markCiteEnterIfNew } from '../motion/enter/cite-enter-tracker';

	let {
		content,
		streaming = false,
		searchResults,
		onOpenPath,
		motionOn = false,
		messageId = '',
	}: {
		content: string;
		streaming?: boolean;
		searchResults?: Array<{ docId: string; score: number; path: string; index: number }>;
		onOpenPath?: (path: string) => void;
		motionOn?: boolean;
		messageId?: string;
	} = $props();

	let containerEl: HTMLDivElement | null = $state(null);
	let rafId = 0;
	let lastRenderedText = '';
	let lastCiteKey = '';
	let cleanupCites: (() => void) | null = null;
	let cleanupCiteTips: (() => void) | null = null;
	/** 有选区时暂存待渲染内容，松手后再写 DOM */
	let pendingRender: { text: string; force: boolean } | null = null;

	function citeKey(): string {
		if (!searchResults?.length) return '';
		return searchResults.map((r) => `${r.index}:${r.path}`).join('|');
	}

	/** 用户正在拖选本容器内文字时，勿用 innerHTML 冲掉选区。 */
	function hasSelectionInside(el: HTMLElement): boolean {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
		const node = sel.getRangeAt(0).commonAncestorContainer;
		return el.contains(node.nodeType === Node.TEXT_NODE ? node.parentNode : node);
	}

	function applyCiteEnterAnimation() {
		if (!containerEl || !motionOn || !messageId || !searchResults?.length) return;
		const mode = shouldStaggerCite(searchResults.length);
		const buttons = containerEl.querySelectorAll<HTMLButtonElement>('button.ratel-cite');
		let staggerIdx = 0;
		for (const btn of buttons) {
			const n = Number(btn.dataset.citeIndex);
			if (!markCiteEnterIfNew(messageId, n)) continue;
			btn.classList.add('ratel-cite-enter');
			if (mode === 'each') {
				btn.style.animationDelay = `${staggerIdx * CITE_EACH_STAGGER_MS}ms`;
				staggerIdx += 1;
			}
		}
	}

	function applyCites() {
		cleanupCites?.();
		cleanupCites = null;
		cleanupCiteTips?.();
		cleanupCiteTips = null;
		if (!containerEl || !onOpenPath || !searchResults?.length) return;
		const valid = new Set(searchResults.map((r) => r.index));
		cleanupCites = enhanceCiteLinks(containerEl, valid, (index) => {
			const path = pathForCiteIndex(searchResults, index);
			if (path) onOpenPath(path);
		});
		const tipCleaners: Array<() => void> = [];
		for (const btn of containerEl.querySelectorAll<HTMLButtonElement>('button.ratel-cite')) {
			const n = Number(btn.dataset.citeIndex);
			const path = pathForCiteIndex(searchResults, n);
			if (!path) continue;
			btn.setAttribute('aria-label', tNow('chat.cite.openNote', { path }));
			tipCleaners.push(bindCitePathTooltip(btn, path));
		}
		cleanupCiteTips = () => {
			for (const c of tipCleaners) c();
		};
		applyCiteEnterAnimation();
	}

	function flushPendingRender(): void {
		if (!pendingRender || !containerEl) return;
		if (hasSelectionInside(containerEl)) return;
		const next = pendingRender;
		pendingRender = null;
		renderToDom(next.text, next.force);
	}

	function renderToDom(text: string, force = false) {
		if (!containerEl) return;
		const key = citeKey();
		if (!force && text === lastRenderedText && key === lastCiteKey) return;
		// 关键路径:流式 innerHTML 会清空 Selection；有选区则暂存，等 selectionchange/mouseup 再刷
		if (hasSelectionInside(containerEl)) {
			pendingRender = { text, force: force || (pendingRender?.force ?? false) };
			return;
		}
		pendingRender = null;
		lastRenderedText = text;
		lastCiteKey = key;

		const html = renderMarkdownToHtml(text);
		containerEl.innerHTML = html;

		if (areAllCodeBlocksClosed(text)) {
			renderMermaidBlocks(containerEl).catch(() => {});
		}
		applyCites();
	}

	$effect(() => {
		const text = content;
		const _sr = searchResults;
		void _sr;
		cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => {
			renderToDom(text);
		});
	});

	$effect(() => {
		if (!streaming && containerEl && content) {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				renderToDom(content, true);
			});
		}
	});

	$effect(() => {
		const onSel = () => flushPendingRender();
		document.addEventListener('selectionchange', onSel);
		document.addEventListener('mouseup', onSel);
		return () => {
			document.removeEventListener('selectionchange', onSel);
			document.removeEventListener('mouseup', onSel);
		};
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
		cleanupCites?.();
		cleanupCiteTips?.();
		pendingRender = null;
	});
</script>

<div class="ratel-md" bind:this={containerEl}></div>

<style>
	.ratel-md {
		font-size: 14px;
		line-height: 1.65;
		color: var(--text-muted);
		letter-spacing: 0.01em;
		word-break: break-word;
	}

	.ratel-md :global(h1) {
		font-size: 1.5em;
		font-weight: 600;
		margin: 0.8em 0 0.4em;
		color: var(--text-normal);
	}
	.ratel-md :global(h2) {
		font-size: 1.3em;
		font-weight: 600;
		margin: 0.7em 0 0.3em;
		color: var(--text-normal);
	}
	.ratel-md :global(h3) {
		font-size: 1.15em;
		font-weight: 600;
		margin: 0.6em 0 0.3em;
		color: var(--text-normal);
	}
	.ratel-md :global(h4),
	.ratel-md :global(h5),
	.ratel-md :global(h6) {
		font-size: 1em;
		font-weight: 600;
		margin: 0.5em 0 0.2em;
		color: var(--text-normal);
	}

	.ratel-md :global(p) {
		margin: 0.4em 0;
	}

	.ratel-md :global(ul),
	.ratel-md :global(ol) {
		margin: 0.4em 0;
		padding-left: 1.5em;
	}
	.ratel-md :global(li) {
		margin: 0.15em 0;
	}

	.ratel-md :global(code) {
		font-family: var(--font-monospace);
		font-size: 0.9em;
		background: var(--background-secondary);
		border-radius: 3px;
		padding: 1px 4px;
	}
	.ratel-md :global(pre) {
		background: var(--background-secondary);
		border-radius: 6px;
		padding: 10px 12px;
		overflow-x: auto;
		margin: 0.5em 0;
	}
	.ratel-md :global(pre code) {
		background: transparent;
		padding: 0;
		font-size: 12px;
		line-height: 1.5;
	}

	.ratel-md :global(table) {
		border-collapse: collapse;
		margin: 0.5em 0;
		width: 100%;
	}
	.ratel-md :global(th),
	.ratel-md :global(td) {
		border: 1px solid var(--background-modifier-border);
		padding: 4px 8px;
		text-align: left;
	}
	.ratel-md :global(th) {
		font-weight: 600;
		background: var(--background-secondary);
	}

	.ratel-md :global(blockquote) {
		border-left: 3px solid var(--background-modifier-border);
		padding-left: 10px;
		margin: 0.5em 0;
		color: var(--text-muted);
	}

	.ratel-md :global(a) {
		color: var(--text-accent);
		text-decoration: none;
	}
	.ratel-md :global(a:hover) {
		text-decoration: underline;
	}

	/* 引用编号 — 与芯片共用 --ratel-cite;原型为下划线散链气质 */
	.ratel-md :global(button.ratel-cite) {
		display: inline-block;
		padding: 0 1px;
		margin: 0 1px;
		border: none;
		border-radius: 0;
		border-bottom: 1px solid color-mix(in srgb, var(--ratel-cite, var(--interactive-accent)) 35%, transparent);
		background: transparent;
		color: var(--ratel-cite, var(--interactive-accent));
		font-family: inherit;
		font-size: inherit;
		font-weight: 500;
		line-height: inherit;
		cursor: pointer;
		vertical-align: baseline;
		-webkit-appearance: none;
		appearance: none;
	}
	.ratel-md :global(button.ratel-cite:hover) {
		background: transparent;
		border-bottom-color: var(--ratel-cite, var(--interactive-accent));
		text-decoration: none;
	}

	.ratel-md :global(button.ratel-cite.ratel-cite-enter) {
		opacity: 0;
		transform: translateY(6px);
		animation: ratel-cite-enter 220ms ease forwards;
	}

	@keyframes ratel-cite-enter {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-md :global(button.ratel-cite.ratel-cite-enter) {
			animation: none;
			opacity: 1;
			transform: none;
		}
	}

	.ratel-md :global(hr) {
		border: none;
		border-top: 1px solid var(--background-modifier-border);
		margin: 1em 0;
	}

	.ratel-md :global(.hljs-keyword) { color: #c678dd; }
	.ratel-md :global(.hljs-string) { color: #98c379; }
	.ratel-md :global(.hljs-number) { color: #d19a66; }
	.ratel-md :global(.hljs-comment) { color: #7f7f7f; font-style: italic; }
	.ratel-md :global(.hljs-function) { color: #61afef; }
	.ratel-md :global(.hljs-title) { color: #61afef; }
	.ratel-md :global(.hljs-attr) { color: #d19a66; }
	.ratel-md :global(.hljs-built_in) { color: #e6c07b; }
	.ratel-md :global(.hljs-type) { color: #e6c07b; }

	.ratel-md :global(.ratel-mermaid) {
		margin: 0.5em 0;
		text-align: center;
	}
	.ratel-md :global(.ratel-mermaid svg) {
		max-width: 100%;
		height: auto;
	}

	.ratel-md :global(.ratel-mermaid-error) {
		padding: 8px 10px;
		border-radius: 6px;
		background: rgba(248, 113, 113, 0.1);
		color: var(--text-error);
		font-size: 11.5px;
		margin: 0.5em 0;
	}

	.ratel-md :global(input[type="checkbox"]) {
		margin-right: 6px;
	}
</style>
