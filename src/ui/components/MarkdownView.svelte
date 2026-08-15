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
	import { enhanceMdBlocks } from '../chat/md-block-enhance';
	import { bindCitePathTooltip } from '../chat/cite-path-tooltip';
	import { pathForCiteIndex } from '../chat/open-chat-note';
	import { tNow } from '../../i18n';
	import {
		CITE_EACH_STAGGER_MS,
		shouldStaggerCite,
	} from '../motion/enter/cite-policy';
	import { markCiteEnterIfNew } from '../motion/enter/cite-enter-tracker';
	import {
		applyLightTextAction,
		StreamingMarkdownState,
		type MarkdownRenderAction,
	} from '../chat/streaming-markdown-state';

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
	let cleanupMdBlocks: (() => void) | null = null;
	let mdEnhanceGen = 0;
	/** 流式渲染决策状态机:决定本帧轻量追加 / 轻量替换 / 富渲染 */
	const renderState = new StreamingMarkdownState();
	/** 流式轻渲染当前持有的唯一 Text 节点 */
	let lightTextNode: Text | null = null;
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

		// 关键路径:富渲染即将整体替换 innerHTML,先丢弃轻量 Text 节点引用并移除流式样式
		lightTextNode = null;
		containerEl.classList.remove('is-streaming-light');

		const html = renderMarkdownToHtml(text);
		containerEl.innerHTML = html;

		cleanupMdBlocks?.();
		cleanupMdBlocks = null;
		const gen = ++mdEnhanceGen;
		const bindMdBlocks = () => {
			if (!containerEl || gen !== mdEnhanceGen) return;
			cleanupMdBlocks?.();
			cleanupMdBlocks = enhanceMdBlocks(containerEl, {
				labels: {
					copy: tNow('chat.md.copy'),
					copied: tNow('chat.md.copied'),
				},
			});
		};
		if (areAllCodeBlocksClosed(text)) {
			void renderMermaidBlocks(containerEl, {
				failed: (message) => tNow('chat.md.mermaidFailed', { message }),
			})
				.catch(() => {})
				.finally(bindMdBlocks);
		} else {
			bindMdBlocks();
		}
		applyCites();
	}

	/**
	 * 执行状态机给出的渲染动作:流式阶段轻量写 Text 节点,结束时一次富渲染。
	 *
	 * @param action - 状态机本帧决策出的渲染动作
	 * @returns 无返回值
	 * @example
	 *   applyRenderAction(renderState.next({ content, streaming, citeKey: citeKey() }));
	 */
	function applyRenderAction(action: MarkdownRenderAction): void {
		if (!containerEl || action.kind === 'none') return;
		if (action.kind === 'render-rich') {
			renderToDom(action.text, action.force);
			return;
		}
		// 关键路径:流式阶段只写 Text 节点,不运行 marked / highlight / Mermaid / cite enhance。
		// 轻量内容不含富元素,先清掉上一轮富渲染留下的清理回调,避免悬挂监听。
		cleanupCites?.();
		cleanupCites = null;
		cleanupCiteTips?.();
		cleanupCiteTips = null;
		cleanupMdBlocks?.();
		cleanupMdBlocks = null;
		containerEl.classList.add('is-streaming-light');
		lightTextNode = applyLightTextAction(containerEl, lightTextNode, action);
	}

	$effect(() => {
		const next = { content, streaming, citeKey: citeKey() };
		cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => {
			applyRenderAction(renderState.next(next));
		});
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
		cleanupMdBlocks?.();
		pendingRender = null;
		renderState.reset();
		lightTextNode = null;
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

	/* 流式轻渲染:保留源码换行,避免被折叠成空格导致与最终富渲染视觉跳变。
	   is-streaming-light 由运行时动态添加,Svelte 静态分析无法命中,需 :global() 修饰 */
	.ratel-md:global(.is-streaming-light) {
		white-space: pre-wrap;
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
	.ratel-md :global(.ratel-md-block) {
		margin: 0.85em 0;
		border: 1px solid var(--background-modifier-border);
		border-radius: 10px;
		overflow: hidden;
		background: var(--background-secondary);
	}
	.ratel-md :global(.ratel-md-block-bar) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 32px;
		padding: 0 8px 0 12px;
		border-bottom: 1px solid var(--background-modifier-border);
		background: color-mix(in srgb, var(--background-primary) 70%, var(--background-secondary));
	}
	.ratel-md :global(.ratel-md-block-label) {
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.04em;
		text-transform: lowercase;
		color: var(--text-faint, var(--text-muted));
		user-select: none;
	}
	.ratel-md :global(.ratel-md-block-actions) {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.ratel-md :global(.ratel-md-copy),
	.ratel-md :global(.ratel-md-expand) {
		flex-shrink: 0;
		margin: 0;
		padding: 3px 8px;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		font-family: inherit;
		font-size: 11px;
		line-height: 1.3;
		cursor: pointer;
		-webkit-appearance: none;
		appearance: none;
		user-select: none;
	}
	.ratel-md :global(.ratel-md-copy:hover),
	.ratel-md :global(.ratel-md-expand:hover) {
		background: var(--background-modifier-hover);
		color: var(--text-normal);
	}
	.ratel-md :global(.ratel-md-copy.is-copied) {
		color: var(--text-success, var(--interactive-accent));
	}
	.ratel-md :global(pre) {
		background: var(--background-secondary);
		border-radius: 6px;
		padding: 10px 12px;
		overflow-x: auto;
		margin: 0.5em 0;
	}
	.ratel-md :global(.ratel-md-block-body pre) {
		margin: 0;
		border-radius: 0;
		background: transparent;
		padding: 12px 14px;
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

	.ratel-md :global(.ratel-md-block-error) {
		padding: 8px 10px;
		color: var(--text-error);
		font-size: 11.5px;
	}

	.ratel-md :global(input[type="checkbox"]) {
		margin-right: 6px;
	}
</style>
