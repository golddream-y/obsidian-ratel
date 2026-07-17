<!--
	@file src/ui/chat/message-stream/MessageBubble.svelte
	@description 单条消息渲染 — text 独立;连续 tool/think 合并进同一 Trace 脊柱
	@module ui/chat/message-stream/MessageBubble
	@depends ./TextSegment, ./ThinkSegment, ./ToolSegment, ./SearchResults, ./group-trace-segments, ./types
	设计:用户气泡毛玻璃 + 助手无背景 + Trace 一根左边线 + 错误/取消精致呈现
-->
<script lang="ts">
	import type { Message } from './types';
	import TextSegment from './TextSegment.svelte';
	import ThinkSegment from './ThinkSegment.svelte';
	import ToolSegment from './ToolSegment.svelte';
	import SearchResults from './SearchResults.svelte';
	import { groupTraceSegments } from './group-trace-segments';
	import { t } from '../../../i18n';

	/**
	 * MessageBubble props。
	 *
	 * @param msg - 消息对象(含 segments / attachments / searchResults / chatError)
	 * @param isLast - 是否消息流中最后一条(影响流式 think/text 段的 streaming 标记)
	 * @param isRunning - Agent Loop 是否运行中
	 */
	let {
		msg,
		isLast,
		isRunning,
		onOpenPath,
	}: {
		msg: Message;
		isLast: boolean;
		isRunning: boolean;
		onOpenPath: (path: string) => void;
	} = $props();

	const isAssistantStreaming = $derived(isLast && isRunning && msg.role === 'assistant');
	// 关键路径:连续 tool/think 收成一块,共享一根左边线(对齐原型 .trace)
	const blocks = $derived(groupTraceSegments(msg.segments));
</script>

<div
	class="ratel-msg"
	class:ratel-msg-user={msg.role === 'user'}
	class:ratel-msg-assistant={msg.role === 'assistant'}
>
	{#if msg.attachments && msg.attachments.length > 0}
		<div class="ratel-msg-imgs">
			{#each msg.attachments as att}
				<img
					class="ratel-msg-img"
					src="data:{att.mimeType};base64,{att.base64}"
					alt={att.fileName}
					title={att.fileName}
				/>
			{/each}
		</div>
	{/if}

	{#each blocks as block}
		{#if block.kind === 'text'}
			<TextSegment
				text={block.seg.text}
				isUser={msg.role === 'user'}
				streaming={isAssistantStreaming}
				searchResults={msg.role === 'assistant' ? msg.searchResults : undefined}
				{onOpenPath}
			/>
		{:else if block.kind === 'trace'}
			<div class="ratel-trace">
				{#each block.items as item}
					{#if item.kind === 'tool'}
						<ToolSegment toolCall={item.seg.toolCall} />
					{:else}
						<ThinkSegment text={item.seg.text} streaming={isAssistantStreaming} />
					{/if}
				{/each}
			</div>
		{/if}
	{/each}

	{#if msg.searchResults && msg.searchResults.length > 0}
		<SearchResults
			results={msg.searchResults}
			reranked={msg.searchReranked ?? false}
			{onOpenPath}
		/>
	{/if}

	{#if msg.chatError}
		<div class="ratel-err">
			<div class="ratel-err-icon">⚠</div>
			<div class="ratel-err-body">
				<div class="ratel-err-msg">{msg.chatError.message}</div>
				{#if msg.chatError.suggestion}
					<div class="ratel-err-sug">{msg.chatError.suggestion}</div>
				{/if}
			</div>
		</div>
	{/if}

	{#if msg.cancelled}
		<div class="ratel-cancelled">
			<span class="ratel-cancelled-dot"></span>
			{$t('chat.error.stopped')}
		</div>
	{/if}
</div>

<style>
	/*
	 * 关键路径:用户气泡右下尖角贴近原型(14/14/4/14);助手无底。
	 * 最大宽度 86% 与原型一致。
	 */
	.ratel-msg {
		max-width: 86%;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.ratel-msg-user {
		align-self: flex-end;
		padding: 11px 14px;
		border-radius: 14px 14px 4px 14px;
		background: color-mix(in srgb, var(--background-secondary) 88%, transparent);
		border: 1px solid var(--background-modifier-border);
		font-size: 14px;
		line-height: 1.55;
	}

	.ratel-msg-assistant {
		align-self: stretch;
		max-width: 100%;
		padding: 0;
		background: transparent;
		border: none;
		box-shadow: none;
	}

	/* 关键路径:一根左边线包住连续 tool/think,行组件用 display:contents 挂到此容器 */
	.ratel-trace {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 2px 0 4px;
		margin-left: 4px;
		padding-left: 2px;
		border-left: 1px solid var(--background-modifier-border);
	}

	.ratel-msg-imgs {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 4px;
	}

	.ratel-msg-img {
		width: 96px;
		height: 96px;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		transition: transform 0.15s ease;
	}

	.ratel-msg-img:hover {
		transform: scale(1.03);
	}

	/*
	 * 关键路径:错误块用 warning 色(非 error 红色)淡背景 + 左侧色带,
	 * 配合 ⚠ 图标和分块布局,提升精致度。
	 */
	.ratel-err {
		margin-top: 4px;
		padding: 8px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--text-error) 8%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		border-left: 2px solid var(--text-error);
		border-top: 1px solid color-mix(in srgb, var(--text-error) 12%, var(--background-modifier-border));
		border-right: 1px solid color-mix(in srgb, var(--text-error) 12%, var(--background-modifier-border));
		border-bottom: 1px solid color-mix(in srgb, var(--text-error) 12%, var(--background-modifier-border));
		color: var(--text-error);
		font-size: 11.5px;
		line-height: 1.5;
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}

	.ratel-err-icon {
		flex-shrink: 0;
		font-size: 13px;
		line-height: 1.4;
		opacity: 0.9;
	}

	.ratel-err-body {
		flex: 1;
		min-width: 0;
	}

	.ratel-err-msg {
		font-weight: 600;
		color: var(--text-error);
	}

	.ratel-err-sug {
		margin-top: 4px;
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.5;
	}

	.ratel-cancelled {
		margin-top: 4px;
		font-size: 11.5px;
		color: var(--text-muted);
		font-style: italic;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.ratel-cancelled-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--text-muted);
		opacity: 0.7;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-msg-img { transition: none; }
	}
</style>
