<!--
	@file src/ui/chat/message-stream/MessageBubble.svelte
	@description 单条消息渲染 — 按 segments 顺序委托各 Segment 组件
	@module ui/chat/message-stream/MessageBubble
	@depends ./TextSegment, ./ThinkSegment, ./ToolSegment, ./SearchResults, ./types
	设计:用户气泡毛玻璃 + 助手无背景 + 附件预览圆角 + 错误/取消状态精致呈现
-->
<script lang="ts">
	import type { Message } from './types';
	import TextSegment from './TextSegment.svelte';
	import ThinkSegment from './ThinkSegment.svelte';
	import ToolSegment from './ToolSegment.svelte';
	import SearchResults from './SearchResults.svelte';

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
	}: {
		msg: Message;
		isLast: boolean;
		isRunning: boolean;
	} = $props();

	// 关键路径:最后一条助手消息在 running 时,think 段为流式
	const isAssistantStreaming = $derived(isLast && isRunning && msg.role === 'assistant');
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

	{#each msg.segments as seg}
		{#if seg.type === 'text'}
			<TextSegment
				text={seg.text}
				isUser={msg.role === 'user'}
				streaming={isAssistantStreaming}
			/>
		{:else if seg.type === 'think'}
			<ThinkSegment text={seg.text} streaming={isAssistantStreaming} />
		{:else if seg.type === 'tool'}
			<ToolSegment toolCall={seg.toolCall} />
		{/if}
	{/each}

	{#if msg.searchResults && msg.searchResults.length > 0}
		<SearchResults results={msg.searchResults} reranked={msg.searchReranked ?? false} />
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
			已停止生成
		</div>
	{/if}
</div>

<style>
	/*
	 * 关键路径:用户气泡使用毛玻璃 + 微阴影,助手消息无背景(直接在 leaf 上渲染)。
	 * 最大宽度 88% 留出呼吸感,圆角 8px 符合设计系统上限。
	 */
	.ratel-msg {
		max-width: 88%;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.ratel-msg-user {
		align-self: flex-end;
		padding: 10px 13px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--background-tertiary) 78%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
	}

	.ratel-msg-assistant {
		align-self: flex-start;
		padding: 0;
		background: transparent;
		border: none;
		box-shadow: none;
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
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
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
