<!--
	@file src/ui/chat/message-stream/TextSegment.svelte
	@description 文本段渲染 — 助手 Markdown + 可选引用编号挂钩
	@module ui/chat/message-stream/TextSegment
	@depends ../components/MarkdownView.svelte
-->
<script lang="ts">
	import MarkdownView from '../../components/MarkdownView.svelte';

	let {
		text,
		isUser = false,
		streaming = false,
		searchResults,
		onOpenPath,
		motionOn = false,
		messageId = '',
	}: {
		text: string;
		isUser?: boolean;
		streaming?: boolean;
		searchResults?: Array<{ docId: string; score: number; path: string; index: number }>;
		onOpenPath?: (path: string) => void;
		motionOn?: boolean;
		messageId?: string;
	} = $props();
</script>

{#if isUser}
	<div class="ratel-text-segment ratel-text-user">{text}</div>
{:else}
	<div class="ratel-text-segment ratel-text-assistant">
		<MarkdownView
			content={text}
			{streaming}
			{searchResults}
			{onOpenPath}
			{motionOn}
			{messageId}
		/>
	</div>
{/if}

<style>
	.ratel-text-segment {
		font-size: 13.5px;
		line-height: 1.6;
	}

	.ratel-text-user {
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-normal);
	}

	.ratel-text-assistant {
		color: var(--text-normal);
	}
</style>
