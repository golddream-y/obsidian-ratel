<!--
	@file src/ui/chat/nav/ChatNavRail.svelte
	@description 对话位置点列 — DeepSeek 式密集点；hover 鱼眼加宽；回底；左右吸附
	@module ui/chat/nav/ChatNavRail
	@depends ./chat-nav-rail, ../../i18n
-->
<script lang="ts">
	import { t } from '../../../i18n';
	import type { ChatNavAnchor } from './chat-nav-rail';

	/**
	 * ChatNavRail props。
	 *
	 * @param enabled - 总开关（父层通常已按此决定是否挂载）
	 * @param side - 左右吸附
	 * @param anchors - 已抽稀的 user 锚点
	 * @param ratio - 视口阅读比例 0..1（用于高亮最接近的点）
	 * @param showBackToBottom - 离开底部时显示回底
	 * @param onJump - 点击刻度跳到消息
	 * @param onBackToBottom - 强制滚到底并恢复 sticky
	 * @param onSideChange - 拖过中线后改侧
	 * @param onThumbSeek - 在列空白处垂直拖时改 scrollTop 比例
	 */
	let {
		enabled,
		side,
		anchors,
		ratio,
		showBackToBottom,
		onJump,
		onBackToBottom,
		onSideChange,
		onThumbSeek,
	}: {
		enabled: boolean;
		side: 'left' | 'right';
		anchors: ChatNavAnchor[];
		ratio: number;
		showBackToBottom: boolean;
		onJump: (id: string) => void;
		onBackToBottom: () => void;
		onSideChange: (side: 'left' | 'right') => void;
		onThumbSeek: (ratio: number) => void;
	} = $props();

	let rootEl = $state<HTMLDivElement | null>(null);
	let clusterEl = $state<HTMLDivElement | null>(null);
	let hoverIdx = $state<number>(-1);
	let dragging = false;
	let dragAxis: 'pending' | 'horizontal' | 'vertical' = 'pending';
	let dragOriginX = 0;
	let dragOriginY = 0;
	let lastEmittedSide: 'left' | 'right' = side;
	const SIDE_FLIP_DEAD_ZONE_PX = 24;
	const AXIS_LOCK_THRESHOLD_PX = 6;

	/** 与阅读比例最接近的锚点下标 — 作「当前」高亮 */
	const activeIdx = $derived.by(() => {
		if (anchors.length === 0) return -1;
		if (anchors.length === 1) return 0;
		const t = Math.min(1, Math.max(0, ratio));
		let best = 0;
		let bestDist = Infinity;
		for (let i = 0; i < anchors.length; i++) {
			const p = i / (anchors.length - 1);
			const d = Math.abs(p - t);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		}
		return best;
	});

	const hoverSummary = $derived(
		hoverIdx >= 0 && hoverIdx < anchors.length ? anchors[hoverIdx]!.summary : '',
	);

	$effect(() => {
		if (!dragging) lastEmittedSide = side;
	});

	/**
	 * 鱼眼宽度（px）：hover 中心最宽，邻域递减；无 hover 时当前点略宽。
	 */
	function dotWidth(idx: number): number {
		const isActive = idx === activeIdx;
		if (hoverIdx < 0) return isActive ? 14 : 7;
		const d = Math.abs(idx - hoverIdx);
		if (d === 0) return 26;
		if (d === 1) return 16;
		if (d === 2) return 11;
		return isActive ? 12 : 7;
	}

	function seekFromClientY(clientY: number) {
		if (!clusterEl) return;
		const rect = clusterEl.getBoundingClientRect();
		if (rect.height <= 0) return;
		const r = (clientY - rect.top) / rect.height;
		onThumbSeek(Math.min(1, Math.max(0, r)));
	}

	function maybeFlipSide(clientX: number) {
		const wrap = rootEl?.parentElement;
		if (!wrap) return;
		const rect = wrap.getBoundingClientRect();
		const mid = rect.left + rect.width / 2;
		if (Math.abs(clientX - mid) < SIDE_FLIP_DEAD_ZONE_PX) return;
		const next: 'left' | 'right' = clientX < mid ? 'left' : 'right';
		if (next === lastEmittedSide) return;
		lastEmittedSide = next;
		onSideChange(next);
	}

	function onRailPointerDown(e: PointerEvent) {
		const t = e.target as HTMLElement | null;
		if (t?.closest('.ratel-chat-nav-tick, .ratel-chat-nav-bottom')) return;
		dragging = true;
		dragAxis = 'pending';
		dragOriginX = e.clientX;
		dragOriginY = e.clientY;
		lastEmittedSide = side;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onRailPointerMove(e: PointerEvent) {
		if (!dragging) return;
		if (dragAxis === 'pending') {
			const dx = Math.abs(e.clientX - dragOriginX);
			const dy = Math.abs(e.clientY - dragOriginY);
			if (dx < AXIS_LOCK_THRESHOLD_PX && dy < AXIS_LOCK_THRESHOLD_PX) return;
			dragAxis = dx > dy ? 'horizontal' : 'vertical';
		}
		if (dragAxis === 'horizontal') {
			maybeFlipSide(e.clientX);
			return;
		}
		seekFromClientY(e.clientY);
	}

	function onRailPointerUp(e: PointerEvent) {
		if (!dragging) return;
		if (dragAxis === 'pending') {
			seekFromClientY(e.clientY);
		}
		dragging = false;
		dragAxis = 'pending';
		try {
			(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		} catch {
			// 已释放时忽略
		}
	}

	function onClusterLeave() {
		if (!dragging) hoverIdx = -1;
	}
</script>

{#if enabled}
	<div
		bind:this={rootEl}
		class="ratel-chat-nav"
		class:is-hot={hoverIdx >= 0}
		data-side={side}
		role="navigation"
		aria-label={$t('chat.nav.rail.aria')}
		onpointerdown={onRailPointerDown}
		onpointermove={onRailPointerMove}
		onpointerup={onRailPointerUp}
		onpointercancel={onRailPointerUp}
	>
		<!-- 点列集中在右侧中段；hover 时内侧同步显示该轮摘要（复用 anchor.summary，无新状态） -->
		<div
			class="ratel-chat-nav-cluster"
			bind:this={clusterEl}
			onpointerleave={onClusterLeave}
		>
			{#each anchors as a, i (a.id)}
				<div
					class="ratel-chat-nav-row"
					class:is-hover={i === hoverIdx}
					class:is-active={i === activeIdx}
					onpointerenter={() => (hoverIdx = i)}
				>
					{#if i === hoverIdx && hoverSummary}
						<span class="ratel-chat-nav-preview" aria-hidden="true">{hoverSummary}</span>
					{/if}
					<button
						type="button"
						class="ratel-chat-nav-tick"
						class:is-active={i === activeIdx}
						class:is-hover={i === hoverIdx}
						style:width="{dotWidth(i)}px"
						style:transition-delay="{hoverIdx >= 0 ? Math.min(Math.abs(i - hoverIdx), 3) * 18 : 0}ms"
						aria-label={$t('chat.nav.tick.aria', { summary: a.summary || '…' })}
						aria-current={i === activeIdx ? 'true' : undefined}
						onclick={() => onJump(a.id)}
					></button>
				</div>
			{/each}
		</div>
		{#if showBackToBottom}
			<button
				type="button"
				class="ratel-chat-nav-bottom"
				aria-label={$t('chat.nav.backToBottom')}
				onclick={onBackToBottom}
			>↓</button>
		{/if}
	</div>
{/if}

<style>
	/*
	 * DeepSeek 式：无粗进度条；中段密集点列；hover 鱼眼横向加宽。
	 * 热区宽于可见点，方便进入 is-hot。
	 */
	.ratel-chat-nav {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 24px;
		z-index: 3;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 12px 0 10px;
		box-sizing: border-box;
		touch-action: none;
		user-select: none;
		/* 整列统一指针，避免上下扫过点间隙时 cursor 闪烁 */
		cursor: pointer;
	}

	.ratel-chat-nav[data-side='right'] {
		right: 0;
		align-items: flex-end;
		padding-right: 5px;
	}

	.ratel-chat-nav[data-side='left'] {
		left: 0;
		align-items: flex-start;
		padding-left: 5px;
	}

	.ratel-chat-nav-cluster {
		display: flex;
		flex-direction: column;
		align-items: inherit;
		justify-content: center;
		/* 无 gap：间距用 row padding，命中连续，扫过时不掉进「空白」 */
		gap: 0;
		max-height: min(52%, 280px);
		overflow: visible;
		padding: 4px 0;
		min-width: 28px;
		cursor: pointer;
	}

	.ratel-chat-nav[data-side='right'] .ratel-chat-nav-cluster {
		align-items: flex-end;
	}

	.ratel-chat-nav[data-side='left'] .ratel-chat-nav-cluster {
		align-items: flex-start;
	}

	.ratel-chat-nav-row {
		position: relative;
		display: flex;
		align-items: center;
		flex-shrink: 0;
		/* 视觉间距 + 连续命中带 */
		padding: 3px 0;
		min-height: 10px;
		cursor: pointer;
	}

	.ratel-chat-nav[data-side='right'] .ratel-chat-nav-row {
		justify-content: flex-end;
	}

	.ratel-chat-nav[data-side='left'] .ratel-chat-nav-row {
		justify-content: flex-start;
	}

	/* 预览贴在点列内侧（右轨→左侧，左轨→右侧），覆盖消息区上方便于扫读 */
	.ratel-chat-nav-preview {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		max-width: min(180px, 42vw);
		padding: 3px 8px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--background-primary) 88%, var(--background-secondary));
		border: 1px solid var(--background-modifier-border);
		color: var(--text-muted);
		font-size: 11px;
		line-height: 1.35;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		pointer-events: none;
		z-index: 4;
	}

	.ratel-chat-nav[data-side='right'] .ratel-chat-nav-preview {
		right: calc(100% + 8px);
	}

	.ratel-chat-nav[data-side='left'] .ratel-chat-nav-preview {
		left: calc(100% + 8px);
	}

	.ratel-chat-nav-row.is-hover .ratel-chat-nav-preview {
		color: var(--text-normal);
		border-color: color-mix(in srgb, var(--interactive-accent) 35%, var(--background-modifier-border));
	}

	.ratel-chat-nav-tick {
		flex-shrink: 0;
		height: 4px;
		min-height: 4px;
		padding: 0;
		border: none;
		border-radius: 999px;
		background: color-mix(in srgb, var(--text-muted) 45%, transparent);
		cursor: pointer;
		transition:
			width 0.16s ease,
			background 0.12s ease,
			opacity 0.12s ease;
		opacity: 0.75;
		cursor: pointer;
	}

	.ratel-chat-nav-tick.is-active {
		background: var(--interactive-accent);
		opacity: 1;
		height: 5px;
	}

	.ratel-chat-nav-tick.is-hover,
	.ratel-chat-nav.is-hot .ratel-chat-nav-tick.is-hover {
		background: var(--interactive-accent);
		opacity: 1;
		height: 6px;
	}

	.ratel-chat-nav.is-hot .ratel-chat-nav-tick:not(.is-hover):not(.is-active) {
		opacity: 0.4;
	}

	.ratel-chat-nav-bottom {
		position: absolute;
		bottom: 10px;
		flex-shrink: 0;
		width: 22px;
		height: 22px;
		min-height: unset;
		padding: 0;
		border: 1px solid var(--background-modifier-border);
		border-radius: 50%;
		background: var(--background-secondary);
		color: var(--text-muted);
		font-size: 12px;
		line-height: 1;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.ratel-chat-nav[data-side='right'] .ratel-chat-nav-bottom {
		right: 4px;
	}

	.ratel-chat-nav[data-side='left'] .ratel-chat-nav-bottom {
		left: 4px;
	}

	.ratel-chat-nav-bottom:hover {
		color: var(--interactive-accent);
		border-color: var(--interactive-accent);
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-chat-nav-tick {
			transition: none;
		}
	}
</style>
