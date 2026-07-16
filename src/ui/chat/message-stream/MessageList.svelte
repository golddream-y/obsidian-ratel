<!--
	@file src/ui/chat/message-stream/MessageList.svelte
	@description 消息流渲染 — 遍历 Message[] 委托 MessageBubble,含思考指示器
	@module ui/chat/message-stream/MessageList
	@depends ./MessageBubble, ./types
	设计:消息间距 12px + 思考指示器 pulse + 自动滚动到底
-->
<script lang="ts">
	import type { Message } from './types';
	import MessageBubble from './MessageBubble.svelte';
	import { t } from '../../../i18n';

	/**
	 * MessageList props。
	 *
	 * @param messages - 消息数组
	 * @param isRunning - Agent Loop 是否运行中(影响最后一条消息的流式标记)
	 * @param containerRef - 可绑定,内层可滚动容器(.ratel-messages)的 DOM 引用,父组件据此控制滚动
	 * @param onScroll - 滚动事件回调,父组件据此判断用户是否处于底部(sticky-to-bottom)
	 */
	let {
		messages,
		isRunning,
		containerRef = $bindable(),
		onScroll,
		onOpenPath,
	}: {
		messages: Message[];
		isRunning: boolean;
		containerRef?: HTMLDivElement | null;
		onScroll?: (el: HTMLDivElement) => void;
		onOpenPath: (path: string) => void;
	} = $props();

	/*
	 * 关键路径:思考指示器 — 仅在 LLM 空窗期(无内容且无 calling 工具)显示。
	 * 有 calling 状态的 tool-call 时,tool-call 的 pulse dot 已是思考指示,不重复显示独立块。
	 */
	function showThinking(): boolean {
		if (!isRunning || messages.length === 0) return false;
		const last = messages[messages.length - 1]!;
		if (last.role !== 'assistant') return false;
		// segments 为空,或全部为空 text/think 段
		const hasContent = last.segments.some(
			(s) =>
				(s.type === 'text' && s.text !== '') ||
				(s.type === 'think' && s.text !== '') ||
				s.type === 'tool',
		);
		if (hasContent) return false;
		// 有 calling 状态的工具段时不显示(tool 段自身有 pulse)
		const hasCallingTool = last.segments.some(
			(s) => s.type === 'tool' && s.toolCall.status === 'calling',
		);
		return !hasCallingTool;
	}
</script>

<div class="ratel-messages" bind:this={containerRef} onscroll={() => { if (containerRef) onScroll?.(containerRef); }}>
	{#each messages as msg, i}
		<MessageBubble {msg} isLast={i === messages.length - 1} {isRunning} {onOpenPath} />
	{/each}
	{#if showThinking()}
		<div class="ratel-typing">
			<span class="ratel-typing-dot"></span>
			<span class="ratel-typing-text">{$t('chat.typing')}</span>
		</div>
	{/if}
</div>

<style>
	/*
	 * 关键路径:消息流 gap/padding 贴近原型 v3(20/16, gap 20),对话区更疏朗。
	 */
	.ratel-messages {
		flex: 1;
		overflow-y: auto;
		padding: 20px 16px 12px;
		display: flex;
		flex-direction: column;
		gap: 20px;
		scroll-behavior: smooth;
	}

	.ratel-typing {
		color: var(--text-warning);
		font-size: 12px;
		padding: 4px 2px;
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--font-monospace);
	}

	.ratel-typing-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-warning);
		animation: ratel-pulse 1.2s infinite;
		flex-shrink: 0;
	}

	.ratel-typing-text {
		opacity: 0.85;
	}

	@keyframes ratel-pulse {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.4; transform: scale(0.85); }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-typing-dot { animation: none; }
		.ratel-messages { scroll-behavior: auto; }
	}
</style>
