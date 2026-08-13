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
	import {
		collectCitedIndexesFromSegments,
		shouldShowCiteChips,
	} from '../collect-cited-indexes';
	import { t } from '../../../i18n';
	import FadeIn from '../../motion/enter/FadeIn.svelte';
	import { isChatMotionEnabled } from '../../motion/prefs';
	import { settings$ as settingsStore } from '../../settings-store';
	import '../../motion/bubble/star-border.css';

	/**
	 * MessageBubble props。
	 *
	 * @param msg - 消息对象(含 segments / attachments / searchResults / chatError)
	 * @param isLast - 是否消息流中最后一条(影响流式 think/text 段的 streaming 标记)
	 * @param isRunning - Agent Loop 是否运行中
	 * @param navFlash - 进度轨跳转后的短暂高亮
	 */
	let {
		msg,
		isLast,
		isRunning,
		onOpenPath,
		navFlash = false,
		/** 会话内最近一次检索 — 本条未挂 searchResults 时供正文 [n] 挂钩 */
		citeSearchFallback = null,
		/** 本条是否播 FadeIn（hydrate / 会话切换为 false） */
		fadePlay = true,
	}: {
		msg: Message;
		isLast: boolean;
		isRunning: boolean;
		onOpenPath: (path: string) => void;
		navFlash?: boolean;
		citeSearchFallback?: Message['searchResults'] | null;
		fadePlay?: boolean;
	} = $props();

	const isAssistantStreaming = $derived(isLast && isRunning && msg.role === 'assistant');
	// 关键路径:连续 tool/think 收成一块,共享一根左边线(对齐原型 .trace)
	const blocks = $derived(groupTraceSegments(msg.segments));
	const validIndexes = $derived(
		new Set((msg.searchResults ?? []).map((r) => r.index)),
	);
	const citedIndexes = $derived(
		collectCitedIndexesFromSegments(msg.segments, validIndexes),
	);
	const showCiteChips = $derived(
		shouldShowCiteChips(!!msg.searchResults?.length, citedIndexes.size),
	);

	// 正文挂钩可用本条或会话最近一次检索;芯片仍只认本条,避免跟进气泡误出「来源」折叠条
	const citeSearchResults = $derived(
		msg.searchResults?.length ? msg.searchResults : citeSearchFallback ?? undefined,
	);
	const motionOn = $derived(isChatMotionEnabled($settingsStore));
	const fadeInPlay = $derived(motionOn && fadePlay);
</script>

<FadeIn play={fadeInPlay}>
<div
	class="ratel-msg"
	class:ratel-msg-user={msg.role === 'user'}
	class:ratel-msg-user--star={msg.role === 'user' && motionOn}
	class:ratel-msg-assistant={msg.role === 'assistant'}
	class:ratel-msg-nav-flash={navFlash}
	data-msg-id={msg.id}
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
				searchResults={msg.role === 'assistant' ? citeSearchResults : undefined}
				{onOpenPath}
				{motionOn}
				messageId={msg.id}
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

	{#if showCiteChips}
		<SearchResults
			results={msg.searchResults!}
			reranked={msg.searchReranked ?? false}
			{onOpenPath}
			{motionOn}
			messageId={msg.id}
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
</FadeIn>

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

	/* 进度轨跳转反馈：短暂描边 + 淡底 */
	.ratel-msg-nav-flash {
		outline: 1px solid color-mix(in srgb, var(--interactive-accent) 55%, transparent);
		background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
		transition: background 0.35s ease, outline-color 0.35s ease;
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
