<!--
	@file src/ui/chat/message-stream/TextSegment.svelte
	@description 文本段渲染 — 助手文本走 MarkdownView,用户文本走纯文本
	@module ui/chat/message-stream/TextSegment
	@depends ../components/MarkdownView.svelte
-->
<script lang="ts">
	import MarkdownView from '../../components/MarkdownView.svelte';

	/**
	 * 文本段 props。
	 *
	 * @param text - 文本内容
	 * @param isUser - 是否用户消息(用户消息用纯文本,保留换行)
	 * @param streaming - 是否流式输出中(影响 MarkdownView 的 mermaid 渲染时机)
	 */
	let {
		text,
		isUser = false,
		streaming = false,
	}: {
		text: string;
		isUser?: boolean;
		streaming?: boolean;
	} = $props();
</script>

{#if isUser}
	<div class="ratel-text-segment ratel-text-user">{text}</div>
{:else}
	<div class="ratel-text-segment ratel-text-assistant">
		<MarkdownView content={text} {streaming} />
	</div>
{/if}

<style>
	.ratel-text-segment {
		font-size: 13.5px;
		line-height: 1.6;
	}

	/*
	 * 关键路径:用户文本保留换行,允许长单词换行避免溢出气泡。
	 */
	.ratel-text-user {
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-normal);
	}

	.ratel-text-assistant {
		color: var(--text-normal);
	}
</style>
