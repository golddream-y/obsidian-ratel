<!--
	@file src/ui/chat/message-stream/MessageList.svelte
	@description 消息流虚拟渲染 — RenderUnit 投影 + 变量高度窗口挂载,含思考指示器
	@module ui/chat/message-stream/MessageList
	@depends ./MessageBubble, ./render-unit-projector, ./virtual-window, ./types
	设计:spacer 保持完整滚动高度;ResizeObserver 实测高度 + 阅读锚点补偿;焦点/选择单元暂留
-->
<script lang="ts">
	import { tick } from 'svelte';
	import type { Message } from './types';
	import MessageBubble from './MessageBubble.svelte';
	import { RenderUnitProjector, type RenderUnit, type VirtualJumpRequest } from './render-unit-projector';
	import {
		buildVirtualLayout,
		computeVirtualRange,
		compensateMeasuredHeight,
		offsetForUnit,
	} from './virtual-window';
	import { t, type StringKey } from '../../../i18n';
	import ThinkingOrb from '../../orbs/ThinkingOrb.svelte';
	import { mapOrbState, type RatelOrbBusyKind } from '../../orbs/map-orb-state';
	import type { OrbState } from '../../orbs/types';
	import EmptyStage from '../../motion/empty/EmptyStage.svelte';
	import { isChatMotionEnabled } from '../../motion/prefs';
	import { settings$ as settingsStore } from '../../settings-store';
	import { computeFadePlay, reseedEnteredIds } from '../../motion/enter/fade-play-policy';

	/**
	 * MessageList props。
	 *
	 * @param messages - 消息数组
	 * @param sessionId - 当前会话 id；切换时重种子 enteredIds，hydrate 不播 FadeIn
	 * @param isRunning - Agent Loop 是否运行中(影响最后一条消息的流式标记)
	 * @param containerRef - 可绑定,内层可滚动容器(.ratel-messages)的 DOM 引用,父组件据此控制滚动
	 * @param onScroll - 滚动事件回调,父组件据此判断用户是否处于底部(sticky-to-bottom)
	 * @param highlightId - 进度轨跳转高亮的消息 id；null 表示无高亮
	 * @param jumpRequest - 跳转到(可能未挂载的)消息的请求;token 递增去重
	 */
	let {
		messages,
		sessionId,
		isRunning,
		containerRef = $bindable(),
		onScroll,
		onOpenPath,
		highlightId = null,
		/** 会话最近一次检索结果 — 跟进气泡正文 [n] 挂钩回退 */
		citeSearchFallback = null,
		jumpRequest = null,
	}: {
		messages: Message[];
		sessionId: string;
		isRunning: boolean;
		containerRef?: HTMLDivElement | null;
		onScroll?: (el: HTMLDivElement) => void;
		onOpenPath: (path: string) => void;
		highlightId?: string | null;
		citeSearchFallback?: Message['searchResults'] | null;
		jumpRequest?: VirtualJumpRequest | null;
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

	/** 已入场或 hydrate 种子的消息 id — 仅新 id 首帧播 FadeIn */
	let enteredIds = $state(new Set<string>());
	let trackedSessionId = $state('');

	// ==================== 虚拟窗口状态 ====================

	const projector = new RenderUnitProjector();
	let measured = $state(new Map<string, number>());
	let scrollTop = $state(0);
	let viewportHeight = $state(600);
	/** 焦点或文字选择涉及的单元 — 暂留挂载,交互结束恢复回收 */
	let retainedIds = $state(new Set<string>());
	let units = $state<RenderUnit[]>([]);

	$effect(() => {
		units = projector.project(messages, isRunning);
	});

	/**
	 * 未实测单元的高度估算 — 按 compact/流式尾部/工具/文本粗分档。
	 * 文本按字符数线性插值并夹在 48–480px,实测值到达后自动校准。
	 */
	const estimateUnitHeight = (unit: RenderUnit): number => {
		if (unit.kind === 'compact') return 54;
		const gap = unit.position === 'only' || unit.position === 'last' ? 20 : 10;
		if (unit.streaming) return 72 + gap;
		const first = unit.segments[0];
		if (first?.type === 'tool' || first?.type === 'think') return 64 + gap;
		if (first?.type === 'text') return Math.max(48, Math.min(480, 32 + first.text.length * 0.35)) + gap;
		return 72 + gap;
	};

	const layout = $derived(buildVirtualLayout(units, measured, estimateUnitHeight));
	const range = $derived(computeVirtualRange(
		layout,
		scrollTop,
		viewportHeight,
		Math.max(400, viewportHeight * 1.5),
		retainedIds,
	));
	const visibleUnits = $derived(units.slice(range.start, range.end));

	/**
	 * 单元实测 action — 首次挂载与尺寸变化时写缓存;
	 * 视口上方单元变高时补偿 scrollTop 保持阅读锚点,贴底时不补偿(sticky 接管)。
	 */
	function measureUnit(node: HTMLElement, id: string) {
		const apply = (height: number) => {
			const previous = measured.get(id);
			if (!Number.isFinite(height) || height <= 0 || (previous !== undefined && Math.abs(previous - height) < 0.5)) return;
			const el = containerRef;
			// 关键路径:贴底 80px 内不做锚点补偿 — sticky-to-bottom 语义优先
			const nearBottom = !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
			const corrected = compensateMeasuredHeight(layout, id, height, scrollTop);
			const next = new Map(measured);
			next.set(id, height);
			measured = next;
			if (el && !nearBottom && corrected !== scrollTop) {
				el.scrollTop = corrected;
				scrollTop = corrected;
			}
		};
		apply(node.getBoundingClientRect().height);
		if (typeof ResizeObserver === 'undefined') return {};
		const observer = new ResizeObserver(() => apply(node.getBoundingClientRect().height));
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}

	/** 从 DOM 节点向上找所属渲染单元 id */
	function unitIdFromNode(node: Node | null): string | null {
		const el = node instanceof Element ? node : node?.parentElement;
		return el?.closest<HTMLElement>('[data-render-unit-id]')?.dataset.renderUnitId ?? null;
	}

	// 关键路径:焦点/选择端点暂留对应单元,防止交互中被卸载导致选区丢失
	$effect(() => {
		const updateRetained = () => {
			// 修复: 删除附件芯片等 DOM 变更会在 Svelte flush 期间同步触发 focusout /
			// selectionchange;此刻处于活动 effect 上下文,直接写 $state 撞
			// state_unsafe_mutation 守卫。微任务延后到刷新周期外再读选区并写入。
			queueMicrotask(() => {
				const next = new Set<string>();
				const focused = unitIdFromNode(document.activeElement);
				if (focused) next.add(focused);
				const selection = window.getSelection();
				if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
					const selRange = selection.getRangeAt(0);
					const start = unitIdFromNode(selRange.startContainer);
					const end = unitIdFromNode(selRange.endContainer);
					if (start) next.add(start);
					if (end) next.add(end);
				}
				retainedIds = next;
			});
		};
		document.addEventListener('focusin', updateRetained);
		document.addEventListener('focusout', updateRetained);
		document.addEventListener('selectionchange', updateRetained);
		return () => {
			document.removeEventListener('focusin', updateRetained);
			document.removeEventListener('focusout', updateRetained);
			document.removeEventListener('selectionchange', updateRetained);
		};
	});

	// 容器绑定后读一次真实视口高度,避免首帧窗口估算过小
	$effect(() => {
		if (!containerRef) return;
		viewportHeight = containerRef.clientHeight || 600;
	});

	// ==================== 虚拟跳转 ====================

	let handledJumpToken = $state(-1);
	// 关键路径:目标消息可能未挂载 — 先按布局偏移滚到附近,挂载后再对齐真实节点
	$effect(() => {
		const request = jumpRequest;
		if (!request || request.token === handledJumpToken || !containerRef) return;
		handledJumpToken = request.token;
		const target = units.find((unit) => unit.messageId === request.messageId &&
			(unit.kind === 'compact' || unit.anchor));
		if (!target) return;
		const top = offsetForUnit(layout, target.id);
		if (top === null) return;
		containerRef.scrollTop = top;
		scrollTop = top;
		void tick().then(() => {
			const node = containerRef?.querySelector(`[data-msg-id="${CSS.escape(request.messageId)}"]`);
			node?.scrollIntoView({ block: 'start' });
		});
	});

	// 关键路径:会话切换 / 初始 hydrate 同步种子，首帧全部 play=false
	$effect.pre(() => {
		const ids = messages.map((m) => m.id);
		if (sessionId !== trackedSessionId) {
			// 虚拟化状态随会话重置 — 旧会话的测量高度对新消息毫无意义
			measured = new Map();
			scrollTop = 0;
			retainedIds = new Set();
			trackedSessionId = sessionId;
			enteredIds = reseedEnteredIds(ids);
		}
	});

	// 新消息首帧播完后记入集合，streaming 重渲不重播
	$effect(() => {
		const ids = messages.map((m) => m.id);
		let next: Set<string> | null = null;
		for (const id of ids) {
			if (!enteredIds.has(id)) {
				if (!next) next = new Set(enteredIds);
				next.add(id);
			}
		}
		if (next) enteredIds = next;
	});

	function compactLabelKey(phase: Message['compactPhase'] | undefined): StringKey {
		if (phase === 'running') return 'chat.compact.running';
		if (phase === 'failed') return 'chat.compact.failed';
		return 'chat.compact.done';
	}
</script>

<div
	class="ratel-messages"
	bind:this={containerRef}
	onscroll={() => {
		if (!containerRef) return;
		scrollTop = containerRef.scrollTop;
		viewportHeight = containerRef.clientHeight || 600;
		onScroll?.(containerRef);
	}}
>
	{#if messages.length === 0}
		<EmptyStage motionOn={motionOn} />
	{/if}
	<div class="ratel-virtual-spacer" style:height={`${range.paddingTop}px`}></div>
	{#each visibleUnits as unit (unit.id)}
		<div
			class="ratel-render-unit"
			data-render-unit-id={unit.id}
			data-unit-position={unit.kind === 'compact' ? 'compact' : unit.position}
			use:measureUnit={unit.id}
		>
			{#if unit.kind === 'compact'}
				<div class="ratel-compact-divider" data-phase={unit.phase ?? 'done'}>
					{$t(compactLabelKey(unit.phase))}
				</div>
			{:else}
				<MessageBubble
					msg={unit.msg}
					segments={unit.segments}
					position={unit.position}
					anchor={unit.anchor}
					showAttachments={unit.showAttachments}
					showFooter={unit.showFooter}
					streaming={unit.streaming}
					isLast={unit.messageIndex === messages.length - 1}
					{isRunning}
					{onOpenPath}
					navFlash={unit.messageId === highlightId}
					{citeSearchFallback}
					fadePlay={computeFadePlay(unit.messageId, enteredIds, motionOn)}
				/>
			{/if}
		</div>
	{/each}
	<div class="ratel-virtual-spacer" style:height={`${range.paddingBottom}px`}></div>
	{#if showBusyOrb}
		<div class="ratel-typing">
			<ThinkingOrb orbState={busyOrbState} size={24} />
			<span class="ratel-typing-text">{$t(ORB_LABEL[busyOrbState])}</span>
		</div>
	{/if}
</div>

<style>
	/*
	 * 关键路径:虚拟化容器改 block 布局,单元间距用可实测的 padding-bottom 表达
	 * (margin 不进入 ResizeObserver 高度,会导致窗口计算漂移)。
	 */
	.ratel-messages {
		position: relative;
		flex: 1;
		overflow-y: auto;
		padding: 20px 16px 12px;
		display: block;
		/* 修复:sticky-to-bottom 必须瞬时落底，避免流式输出期间持续追赶平滑动画。 */
		scroll-behavior: auto;
		/* 组件内兜底；全局压过 Obsidian body{user-select:none} 在 styles.css */
		-webkit-user-select: text;
		user-select: text;
		/* 用右侧点列导航，隐藏系统纵向滚动条（仍可滚轮/触控板滚动） */
		scrollbar-width: none;
		-ms-overflow-style: none;
	}

	.ratel-render-unit {
		display: flex;
		flex-direction: column;
		padding-bottom: 10px;
		box-sizing: border-box;
	}

	.ratel-render-unit[data-unit-position='only'],
	.ratel-render-unit[data-unit-position='last'],
	.ratel-render-unit[data-unit-position='compact'] {
		padding-bottom: 20px;
	}

	.ratel-virtual-spacer {
		width: 1px;
		pointer-events: none;
	}

	.ratel-messages.ratel-scroll-snap {
		scroll-behavior: auto;
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

	.ratel-compact-divider {
		align-self: center;
		max-width: 100%;
		padding: 4px 12px;
		font-size: 11px;
		line-height: 1.4;
		color: var(--text-faint, var(--text-muted));
		text-align: center;
		border-top: 1px solid var(--background-modifier-border);
		border-bottom: 1px solid var(--background-modifier-border);
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-messages { scroll-behavior: auto; }
	}
</style>
