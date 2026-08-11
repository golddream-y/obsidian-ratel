<script lang="ts">
	/**
	 * @file src/ui/status/StatusLine.svelte
	 * @description composer 顶沿 StatusStrip — 点 + 文案 + 上下文% + 展开
	 * @module ui/StatusLine
	 * @depends svelte/store, user-feedback/user-status, ./tone, ./strip-label
	 * 设计:毛玻璃背景,点 + 文案 + % + 箭头
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot, ContextUsage } from '../../user-feedback/user-status';
	import { t, type StringKey } from '../../i18n';
	import ThinkingOrb from '../orbs/ThinkingOrb.svelte';
	import { mapOrbState, type RatelOrbBusyKind } from '../orbs/map-orb-state';
	import { deriveTone, type Tone } from './tone';
	import { clampContextPct, composeStripLabel, contextPctTextColor } from './strip-label';

	let {
		status$,
		contextUsage$,
		expanded = false,
		onToggle,
		/** 对话进行中时压制「思考中」文案 — 消息区已有打字指示,避免双份 */
		chatBusy = false,
		busyOverride = null,
		/** work-bar 类型对应的 orb 忙态;无则按 tone 回退 */
		busyOrbKind = null,
		/** 硬 gate 阻塞时强制错误强调色(文案仍走 busyOverride) */
		busyHard = false,
	}: {
		status$: Readable<UserStatusSnapshot>;
		contextUsage$: Readable<ContextUsage>;
		expanded: boolean;
		onToggle: () => void;
		chatBusy?: boolean;
		busyOverride?: string | null;
		busyOrbKind?: RatelOrbBusyKind | null;
		busyHard?: boolean;
	} = $props();

	// 关键路径:Svelte 5 直接用 $ 前缀订阅 store
	const snap = $derived($status$);
	const usage = $derived($contextUsage$);
	// 关键路径:显示与色阶共用同一 clamp,避免 >100 时数字截断但色阶仍按原值跳 error
	const pct = $derived(clampContextPct(usage.percentage));
	const pctColor = $derived(contextPctTextColor(pct));

	const toneLabels: Record<Tone, StringKey> = {
		ready: 'status.index.ready',
		thinking: 'status.index.thinking',
		error: 'status.index.requestFailed',
		unconfigured: 'status.index.notConfigured',
		indexing: 'status.index.indexing',
	};

	const state = $derived.by(() => {
		const { tone } = deriveTone(snap);
		// 对话中:不把 checking 映射成第二条「思考中」(MessageList 已有)
		if (chatBusy && tone === 'thinking') {
			return { tone: 'ready' as Tone, label: $t('status.index.ready') };
		}
		return { tone, label: $t(toneLabels[tone]) };
	});

	const label = $derived(
		composeStripLabel({
			busyOverride,
			toneLabel: state.label,
			chatBusy,
			tone: state.tone,
		}),
	);

	// 关键路径:work-bar 忙态可能尚未反映进 deriveTone(如 compacting),busyOverride 时强制 busy 点
	const dotBusy = $derived(
		state.tone === 'thinking' ||
			state.tone === 'indexing' ||
			(!!busyOverride && state.tone !== 'error' && state.tone !== 'unconfigured'),
	);

	// 忙态用 ThinkingOrb 替代黄点 pulse;硬错误 / 未配置仍用 CSS 点
	const showOrb = $derived(dotBusy && !busyHard);
	const orbKind = $derived.by((): RatelOrbBusyKind => {
		if (busyOrbKind) return busyOrbKind;
		if (state.tone === 'indexing') return 'index';
		return 'thinking';
	});
</script>

<!-- 关键路径:整行可点击切换 Drawer;布局 点 | 文案 | % | ▲ -->
<div
	class="ratel-status-line"
	onclick={onToggle}
	role="button"
	aria-expanded={expanded}
	aria-label={expanded ? $t('status.drawer.collapse') : $t('status.drawer.expand')}
>
	{#if showOrb}
		<span class="ratel-sl-orb" aria-hidden="true">
			<ThinkingOrb orbState={mapOrbState(orbKind)} size={14} />
		</span>
	{:else}
		<span
			class="ratel-sl-dot"
			class:ratel-sl-dot-ready={state.tone === 'ready' && !dotBusy && !busyHard}
			class:ratel-sl-dot-error={state.tone === 'error' || busyHard}
			class:ratel-sl-dot-unconfigured={state.tone === 'unconfigured' && !busyHard}
		></span>
	{/if}
	<span
		class="ratel-sl-text"
		class:ratel-sl-text-warn={dotBusy && !busyHard}
		class:ratel-sl-text-error={state.tone === 'error' || busyHard}
		class:ratel-sl-text-muted={state.tone === 'unconfigured' && !busyHard}
	>{label}</span>
	<span class="ratel-sl-pct" style={`color: ${pctColor}`}>{pct}%</span>
	<span class="ratel-sl-arrow">▲</span>
</div>

<style>
	/*
	 * 关键路径:状态条贴 composer 顶沿,极薄;用 padding 代替固定 height,对齐原型 8px 16px。
	 */
	.ratel-status-line {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		/* 顶边由 .ratel-composer 承担,避免与 composer 双线 */
		background: transparent;
		font-size: 11.5px;
		color: var(--text-muted);
		cursor: pointer;
		user-select: none;
		flex-shrink: 0;
		transition: background 0.15s;
	}

	.ratel-status-line:hover {
		background: color-mix(in srgb, var(--text-normal) 2%, transparent);
	}

	.ratel-sl-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex-shrink: 0;
		transition: background 0.2s;
	}

	.ratel-sl-dot-ready {
		background: var(--text-success);
	}

	.ratel-sl-dot-error {
		background: var(--text-error);
	}

	.ratel-sl-dot-unconfigured {
		background: transparent;
		border: 1.5px solid var(--text-faint, var(--text-muted));
	}

	.ratel-sl-orb {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		width: 14px;
		height: 14px;
	}

	.ratel-sl-text {
		font-weight: 500;
		color: var(--text-normal);
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-sl-text-warn {
		color: var(--text-warning);
	}

	.ratel-sl-text-error {
		color: var(--text-error);
	}

	.ratel-sl-text-muted {
		color: var(--text-muted);
		font-weight: 400;
	}

	.ratel-sl-pct {
		margin-left: auto;
		font-family: var(--font-monospace);
		font-size: 11px;
		font-weight: 600;
		flex-shrink: 0;
	}

	.ratel-sl-arrow {
		font-size: 10px;
		opacity: 0.6;
		flex-shrink: 0;
		transition: opacity 0.15s;
	}

	.ratel-status-line:hover .ratel-sl-arrow {
		opacity: 0.9;
	}
</style>
