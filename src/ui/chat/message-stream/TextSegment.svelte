<!--
	@file src/ui/chat/message-stream/TextSegment.svelte
	@description 文本段渲染 — 助手单块 MarkdownView(stable/tail 由 projector 拆分),用户消息纯文本
	@module ui/chat/message-stream/TextSegment
	@depends ../components/MarkdownView.svelte, ../input/slash-commands
-->
<script lang="ts">
	import { splitLeadingSlashCommand } from '../input/slash-commands';
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
	<div class="ratel-text-segment ratel-text-user">
		{#each splitLeadingSlashCommand(text) as span}
			{#if span.kind === 'command'}
				<span class="ratel-slash-token">{span.text}</span>
			{:else}{span.text}{/if}
		{/each}
	</div>
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

	.ratel-slash-token {
		color: var(--text-accent, var(--interactive-accent));
		font-family: var(--font-monospace);
		font-weight: 600;
	}

	.ratel-text-assistant {
		color: var(--text-normal);
	}
</style>
