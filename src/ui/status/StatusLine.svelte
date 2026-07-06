<script lang="ts">
	/**
	 * @file src/ui/status/StatusLine.svelte
	 * @description 底部常驻单行状态条 — 状态点 + 文字 + 展开 ▲(百分比已外移到 Header)
	 * @module ui/StatusLine
	 * @depends svelte/store, user-feedback/user-status, ./tone
	 * 设计:毛玻璃背景,只留 3 件事:点 + 文字 + 箭头
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot } from '../../user-feedback/user-status';
	import { t, type StringKey } from '../../i18n';
	import { deriveTone, type Tone } from './tone';

	let {
		status$,
		expanded = false,
		onToggle,
	}: {
		status$: Readable<UserStatusSnapshot>;
		expanded: boolean;
		onToggle: () => void;
	} = $props();

	// 关键路径:Svelte 5 直接用 $ 前缀订阅 store
	const snap = $derived($status$);

	const toneLabels: Record<Tone, StringKey> = {
		ready: 'status.index.ready',
		thinking: 'status.index.thinking',
		error: 'status.index.requestFailed',
		unconfigured: 'status.index.notConfigured',
		indexing: 'status.index.indexing',
	};

	const state = $derived.by(() => {
		const { tone } = deriveTone(snap);
		return { tone, label: $t(toneLabels[tone]) };
	});
</script>

<!-- 关键路径:整行可点击切换 Drawer,ctx 百分比已外移到 Header -->
<div
	class="ratel-status-line"
	onclick={onToggle}
	role="button"
	aria-expanded={expanded}
	aria-label={expanded ? $t('status.drawer.collapse') : $t('status.drawer.expand')}
>
	<span
		class="ratel-sl-dot"
		class:ratel-sl-dot-ready={state.tone === 'ready'}
		class:ratel-sl-dot-thinking={state.tone === 'thinking' || state.tone === 'indexing'}
		class:ratel-sl-dot-error={state.tone === 'error'}
		class:ratel-sl-dot-unconfigured={state.tone === 'unconfigured'}
	></span>
	<span
		class="ratel-sl-text"
		class:ratel-sl-text-warn={state.tone === 'thinking' || state.tone === 'indexing'}
		class:ratel-sl-text-error={state.tone === 'error'}
		class:ratel-sl-text-muted={state.tone === 'unconfigured'}
	>{state.label}</span>
	<span class="ratel-sl-arrow">▲</span>
</div>

<style>
	/*
	 * 关键路径:状态条使用毛玻璃背景,与 Header/输入区视觉一致。
	 * 高度 30px 常驻底部,hover 微亮反馈。
	 * 删除 ctx 块后只剩 点 + 文字 + 箭头,无 box-shadow。
	 */
	.ratel-status-line {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 30px;
		padding: 0 14px;
		border-top: 1px solid var(--background-modifier-border);
		background: color-mix(in srgb, var(--background-secondary) 75%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		font-size: 11.5px;
		color: var(--text-muted);
		cursor: pointer;
		user-select: none;
		flex-shrink: 0;
		transition: background 0.15s;
	}

	.ratel-status-line:hover {
		background: color-mix(in srgb, var(--background-modifier-hover) 70%, transparent);
	}

	.ratel-sl-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		transition: background 0.2s;
	}

	.ratel-sl-dot-ready {
		background: var(--text-success);
	}

	.ratel-sl-dot-thinking {
		background: var(--text-warning);
		animation: ratel-sl-pulse 1.2s infinite;
	}

	.ratel-sl-dot-error {
		background: var(--text-error);
	}

	.ratel-sl-dot-unconfigured {
		background: transparent;
		border: 1.5px solid var(--text-faint, var(--text-muted));
	}

	@keyframes ratel-sl-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-sl-dot-thinking {
			animation: none;
		}
	}

	.ratel-sl-text {
		font-weight: 500;
		color: var(--text-normal);
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

	.ratel-sl-arrow {
		margin-left: auto;
		font-size: 10px;
		opacity: 0.6;
		flex-shrink: 0;
		transition: opacity 0.15s;
	}

	.ratel-status-line:hover .ratel-sl-arrow {
		opacity: 0.9;
	}
</style>
