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
	import { t, type StringKey } from '../../../i18n';
	import ThinkingOrb from '../../orbs/ThinkingOrb.svelte';
	import { mapOrbState, type RatelOrbBusyKind } from '../../orbs/map-orb-state';
	import type { OrbState } from '../../orbs/types';
	import EmptyStage from '../../motion/empty/EmptyStage.svelte';
	import { isChatMotionEnabled } from '../../motion/prefs';
	import { settings$ as settingsStore } from '../../settings-store';

	/**
	 * MessageList props。
	 *
	 * @param messages - 消息数组
	 * @param isRunning - Agent Loop 是否运行中(影响最后一条消息的流式标记)
	 * @param containerRef - 可绑定,内层可滚动容器(.ratel-messages)的 DOM 引用,父组件据此控制滚动
	 * @param onScroll - 滚动事件回调,父组件据此判断用户是否处于底部(sticky-to-bottom)
	 * @param highlightId - 进度轨跳转高亮的消息 id；null 表示无高亮
	 */
	let {
		messages,
		isRunning,
		containerRef = $bindable(),
		onScroll,
		onOpenPath,
		highlightId = null,
		/** 会话最近一次检索结果 — 跟进气泡正文 [n] 挂钩回退 */
		citeSearchFallback = null,
	}: {
		messages: Message[];
		isRunning: boolean;
		containerRef?: HTMLDivElement | null;
		onScroll?: (el: HTMLDivElement) => void;
		onOpenPath: (path: string) => void;
		highlightId?: string | null;
		citeSearchFallback?: Message['searchResults'] | null;
	} = $props();

	const ORB_LABEL: Record<OrbState, StringKey> = {
		working: 'orb.state.working',
		searching: 'orb.state.searching',
		solving: 'orb.state.solving',
		listening: 'orb.state.listening',
		connecting: 'orb.state.connecting',
		weaving: 'orb.state.weaving',
		composing: 'orb.state.composing',
		breathing: 'orb.state.breathing',
		shaping: 'orb.state.shaping',
	};

	/**
	 * 整段 Agent 回合都显示底部 orb(不再只在空窗期)。
	 * 有 calling 工具时切到 working 动画,与工具行小 orb 语义一致。
	 */
	const showBusyOrb = $derived.by(() => {
		if (!isRunning || messages.length === 0) return false;
		return messages[messages.length - 1]!.role === 'assistant';
	});

	const busyKind = $derived.by((): RatelOrbBusyKind => {
		if (!showBusyOrb) return 'thinking';
		const last = messages[messages.length - 1]!;
		const calling = last.segments.some(
			(s) => s.type === 'tool' && s.toolCall.status === 'calling',
		);
		if (calling) {
			const name = last.segments
				.filter((s) => s.type === 'tool' && s.toolCall.status === 'calling')
				.map((s) => (s.type === 'tool' ? s.toolCall.name : ''))
				.join(' ');
			// 检索类工具用 searching 动画
			if (/search|检索|embed|index/i.test(name)) return 'search';
			return 'tool';
		}
		return 'thinking';
	});

	const busyOrbState = $derived(mapOrbState(busyKind));
	const motionOn = $derived(isChatMotionEnabled($settingsStore));
</script>

<div class="ratel-messages" bind:this={containerRef} onscroll={() => { if (containerRef) onScroll?.(containerRef); }}>
	{#if messages.length === 0}
		<EmptyStage motionOn={motionOn} />
	{/if}
	{#each messages as msg, i (msg.id)}
		<MessageBubble
			{msg}
			isLast={i === messages.length - 1}
			{isRunning}
			{onOpenPath}
			navFlash={msg.id === highlightId}
			{citeSearchFallback}
		/>
	{/each}
	{#if showBusyOrb}
		<div class="ratel-typing">
			<ThinkingOrb orbState={busyOrbState} size={24} />
			<span class="ratel-typing-text">{$t(ORB_LABEL[busyOrbState])}</span>
		</div>
	{/if}
</div>

<style>
	/*
	 * 关键路径:消息流 gap/padding 贴近原型 v3(20/16, gap 20),对话区更疏朗。
	 */
	.ratel-messages {
		position: relative;
		flex: 1;
		overflow-y: auto;
		padding: 20px 16px 12px;
		display: flex;
		flex-direction: column;
		gap: 20px;
		scroll-behavior: smooth;
		/* 组件内兜底；全局压过 Obsidian body{user-select:none} 在 styles.css */
		-webkit-user-select: text;
		user-select: text;
		/* 用右侧点列导航，隐藏系统纵向滚动条（仍可滚轮/触控板滚动） */
		scrollbar-width: none;
		-ms-overflow-style: none;
	}

	.ratel-messages::-webkit-scrollbar {
		width: 0;
		height: 0;
		display: none;
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

	.ratel-typing-text {
		opacity: 0.85;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-messages { scroll-behavior: auto; }
	}
</style>
