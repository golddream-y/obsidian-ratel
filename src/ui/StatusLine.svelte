<script lang="ts">
	/**
	 * @file src/ui/StatusLine.svelte
	 * @description 底部常驻单行状态条 — 状态点 + 文字 + ctx 进度条 + 展开 ▲(整行可点击)
	 * @module ui/StatusLine
	 * @depends svelte/store, user-feedback/user-status
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot, ContextUsage } from '../user-feedback/user-status';

	let {
		status$,
		contextUsage$,
		expanded = false,
		onToggle,
	}: {
		status$: Readable<UserStatusSnapshot>;
		contextUsage$: Readable<ContextUsage>;
		expanded: boolean;
		onToggle: () => void;
	} = $props();

	// 关键路径:Svelte 5 直接用 $ 前缀订阅 store,无需 $derived 包装
	const snap = $derived($status$);
	const usage = $derived($contextUsage$);

	type Tone = 'ready' | 'thinking' | 'error' | 'unconfigured' | 'indexing';

	const state = $derived.by(() => {
		const s = snap;
		// 关键路径:索引中优先于思考中
		if (s.index === 'processing' || s.index === 'scanning' || s.index === 'queueing') {
			return { tone: 'indexing' as Tone, label: '索引中' };
		}
		if (s.model === 'failed' || s.index === 'failed') {
			return { tone: 'error' as Tone, label: '请求失败' };
		}
		if (s.model === 'idle' && s.embedding === 'unavailable') {
			return { tone: 'unconfigured' as Tone, label: '未配置' };
		}
		if (s.model !== 'ready' && s.model !== 'idle') {
			return { tone: 'thinking' as Tone, label: '思考中…' };
		}
		return { tone: 'ready' as Tone, label: '就绪' };
	});

	// ctx 进度条颜色阈值:0-79% 绿,80-94% 黄,95-100% 红
	const ctxColor = $derived.by(() => {
		const p = usage.percentage;
		if (p >= 95) return 'var(--text-error)';
		if (p >= 80) return 'var(--text-warning)';
		return 'var(--text-success)';
	});

	const pct = $derived(Math.min(usage.percentage, 100));
</script>

<!-- 关键路径:整行可点击切换 Drawer,与 mockup 一致 -->
<div class="ratel-status-line" onclick={onToggle} role="button" aria-expanded={expanded} aria-label={expanded ? '收起详情' : '展开详情'}>
	<span class="ratel-sl-dot" class:ratel-sl-dot-ready={state.tone === 'ready'} class:ratel-sl-dot-thinking={state.tone === 'thinking' || state.tone === 'indexing'} class:ratel-sl-dot-error={state.tone === 'error'} class:ratel-sl-dot-unconfigured={state.tone === 'unconfigured'}></span>
	<span class="ratel-sl-text" class:ratel-sl-text-warn={state.tone === 'thinking' || state.tone === 'indexing'} class:ratel-sl-text-error={state.tone === 'error'} class:ratel-sl-text-muted={state.tone === 'unconfigured'}>{state.label}</span>
	<div class="ratel-sl-ctx" title={`已用 ${usage.usedTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens`}>
		<div class="ratel-sl-ctx-bar">
			<div class="ratel-sl-ctx-fill" style={`width: ${pct}%; background: ${ctxColor};`}></div>
		</div>
		<span class="ratel-sl-ctx-pct" style={`color: ${ctxColor};`}>{usage.percentage}%</span>
	</div>
	<span class="ratel-sl-arrow">{expanded ? '▼' : '▲'}</span>
</div>

<style>
	.ratel-status-line {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 30px;
		padding: 0 14px;
		border-top: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		font-size: 11.5px;
		color: var(--text-muted);
		cursor: pointer;
		user-select: none;
		flex-shrink: 0;
		transition: background 0.15s;
	}

	.ratel-status-line:hover {
		background: var(--background-modifier-hover);
	}

	.ratel-sl-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
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

	.ratel-sl-ctx {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-left: auto;
	}

	.ratel-sl-ctx-bar {
		width: 48px;
		height: 4px;
		border-radius: 2px;
		background: var(--background-modifier-form-field, var(--background-primary));
		overflow: hidden;
	}

	.ratel-sl-ctx-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.3s;
	}

	.ratel-sl-ctx-pct {
		font-size: 10px;
		font-family: var(--font-monospace);
		min-width: 28px;
		text-align: right;
	}

	.ratel-sl-arrow {
		font-size: 10px;
		opacity: 0.6;
		flex-shrink: 0;
	}
</style>
