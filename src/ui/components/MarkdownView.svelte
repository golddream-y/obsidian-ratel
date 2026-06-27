<script lang="ts">
	/**
	 * @file src/ui/MarkdownView.svelte
	 * @description Markdown 流式渲染组件 — rAF 节流 + marked + DOMPurify + mermaid
	 * @module ui/MarkdownView
	 * @depends utils/markdown-renderer, utils/mermaid-renderer
	 */

	import { onDestroy } from 'svelte';
	import { renderMarkdownToHtml, areAllCodeBlocksClosed } from '../../utils/markdown-renderer';
	import { renderMermaidBlocks } from '../../utils/mermaid-renderer';

	/**
	 * 组件 Props。
	 *
	 * @param content - Markdown 源文本(流式追加)
	 * @param streaming - 是否正在流式输出中(true 时 mermaid 块需等闭合后渲染)
	 */
	let { content, streaming = false }: { content: string; streaming?: boolean } = $props();

	let containerEl: HTMLDivElement | null = $state(null);
	let rafId = 0;
	let lastRenderedText = '';

	/**
	 * 渲染管线:marked → DOMPurify → innerHTML → mermaid post-process。
	 *
	 * 关键路径:rAF 节流确保同一帧内多次 content 变化只渲染最后一次,
	 * 避免 60fps 被打满。mermaid 仅在代码块全部闭合时渲染。
	 */
	function renderToDom(text: string) {
		if (!containerEl || text === lastRenderedText) return;
		lastRenderedText = text;

		const html = renderMarkdownToHtml(text);
		// 关键路径:用 innerHTML 替换内容,因为 mermaid post-process
		// 需要在 DOM 更新后操作 querySelectorAll,直接用 innerHTML 更可控。
		containerEl.innerHTML = html;

		// mermaid 渲染:仅在代码块全部闭合时执行
		if (areAllCodeBlocksClosed(text)) {
			renderMermaidBlocks(containerEl).catch(() => {
				// mermaid 渲染异常已在 renderSingleMermaidBlock 内处理,此处静默
			});
		}
	}

	$effect(() => {
		const text = content; // 追踪依赖
		cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => {
			renderToDom(text);
		});
	});

	// streaming 从 true→false 时(模型回复完成),强制重新渲染以触发 mermaid
	$effect(() => {
		if (!streaming && containerEl && content) {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				lastRenderedText = ''; // 强制刷新
				renderToDom(content);
			});
		}
	});

	onDestroy(() => {
		cancelAnimationFrame(rafId);
	});
</script>

<div class="ratel-md" bind:this={containerEl}></div>

<style>
	.ratel-md {
		font-size: 13.5px;
		line-height: 1.6;
		color: var(--text-normal);
		word-break: break-word;
	}

	/* 标题 */
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

	/* 段落 */
	.ratel-md :global(p) {
		margin: 0.4em 0;
	}

	/* 列表 */
	.ratel-md :global(ul),
	.ratel-md :global(ol) {
		margin: 0.4em 0;
		padding-left: 1.5em;
	}
	.ratel-md :global(li) {
		margin: 0.15em 0;
	}

	/* 代码 */
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

	/* 表格 */
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

	/* 引用块 */
	.ratel-md :global(blockquote) {
		border-left: 3px solid var(--background-modifier-border);
		padding-left: 10px;
		margin: 0.5em 0;
		color: var(--text-muted);
	}

	/* 链接 */
	.ratel-md :global(a) {
		color: var(--text-accent);
		text-decoration: none;
	}
	.ratel-md :global(a:hover) {
		text-decoration: underline;
	}

	/* 分隔线 */
	.ratel-md :global(hr) {
		border: none;
		border-top: 1px solid var(--background-modifier-border);
		margin: 1em 0;
	}

	/* highlight.js 令牌色 — 适配 Obsidian 暗色主题 */
	.ratel-md :global(.hljs-keyword) { color: #c678dd; }
	.ratel-md :global(.hljs-string) { color: #98c379; }
	.ratel-md :global(.hljs-number) { color: #d19a66; }
	.ratel-md :global(.hljs-comment) { color: #7f7f7f; font-style: italic; }
	.ratel-md :global(.hljs-function) { color: #61afef; }
	.ratel-md :global(.hljs-title) { color: #61afef; }
	.ratel-md :global(.hljs-attr) { color: #d19a66; }
	.ratel-md :global(.hljs-built_in) { color: #e6c07b; }
	.ratel-md :global(.hljs-type) { color: #e6c07b; }

	/* mermaid 容器 */
	.ratel-md :global(.ratel-mermaid) {
		margin: 0.5em 0;
		text-align: center;
	}
	.ratel-md :global(.ratel-mermaid svg) {
		max-width: 100%;
		height: auto;
	}

	/* mermaid 渲染失败提示 */
	.ratel-md :global(.ratel-mermaid-error) {
		padding: 8px 10px;
		border-radius: 6px;
		background: rgba(248, 113, 113, 0.1);
		color: var(--text-error);
		font-size: 11.5px;
		margin: 0.5em 0;
	}

	/* 任务列表 */
	.ratel-md :global(input[type="checkbox"]) {
		margin-right: 6px;
	}
</style>
