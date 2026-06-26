<script lang="ts">
	/**
	 * @file src/ui/StatusLine.svelte
	 * @description 底部常驻单行状态条 — 状态点 + 文字 + ctx 进度条 + 展开 ▲
	 * @module ui/StatusLine
	 * @depends svelte/store, user-feedback/user-status
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot, ContextUsage } from '../user-feedback/user-status';

	// 关键路径:Svelte 5 用 $props() 替代 export let
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

	// 关键路径:Svelte 5 用 $derived 替代 $: 自动重算
	const snap = $derived($status$);
	const usage = $derived($contextUsage$);

	// 状态点 + 文字映射(5 种状态,索引中优先)
	const state = $derived(
		computeState(snap),
	);

	function computeState(s: UserStatusSnapshot): {
		tone: 'ready' | 'thinking' | 'error' | 'unconfigured' | 'indexing';
		label: string;
	} {
		// 关键路径:索引中优先于思考中(spec §2)
		if (s.index === 'processing' || s.index === 'scanning' || s.index === 'queueing') {
			return { tone: 'indexing', label: '索引中' };
		}
		if (s.model === 'failed' || s.index === 'failed') {
			return { tone: 'error', label: '请求失败' };
		}
		// 关键路径:未配置 — model 空闲且未就绪,或 embedding 不可用
		if (s.model === 'idle' && s.embedding === 'unavailable') {
			return { tone: 'unconfigured', label: '未配置' };
		}
		// 关键路径:思考中 — 模型不在 ready 且不空闲(初始化/下载/检查中)
		// 关键路径:此处 s.model 已被前面分支收窄为非 'failed',无需再判 !== 'failed'
		if (s.model !== 'ready' && s.model !== 'idle') {
			return { tone: 'thinking', label: '思考中…' };
		}
		return { tone: 'ready', label: '就绪' };
	}

	// ctx 进度条颜色阈值:0-79% 绿,80-94% 黄,95-100% 红
	const ctxColor = $derived(
		usage.percentage >= 95
			? 'var(--text-error)'
			: usage.percentage >= 80
				? 'var(--text-warning)'
				: 'var(--text-success)',
	);
</script>

<div class="ratel-status-line">
	<!-- 关键路径:左侧点击展开/收起 Drawer;右侧 ctx 区域不展开(spec §2 点击区域划分) -->
	<button
		class="ratel-status-left"
		type="button"
		onclick={onToggle}
		aria-label={expanded ? '收起详情' : '展开详情'}
		aria-expanded={expanded}
	>
		<span class="ratel-status-dot ratel-dot-{state.tone}"></span>
		<span class="ratel-status-text ratel-text-{state.tone}">{state.label}</span>
		<span class="ratel-status-arrow">{expanded ? '▼' : '▲'}</span>
	</button>
	<!-- ctx 区域:不展开 Drawer,未来可预留跳转上下文管理 -->
	<div class="ratel-status-right" title={`已用 ${usage.usedTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens`}>
		<div class="ratel-ctx-bar" style="width: 48px; height: 4px; background: var(--background-modifier-border);">
			<div class="ratel-ctx-fill" style="width: {Math.min(usage.percentage, 100)}%; background: {ctxColor};"></div>
		</div>
		<span class="ratel-ctx-pct" style="color: {ctxColor};">{usage.percentage}%</span>
	</div>
</div>

<style>
	.ratel-status-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 30px;
		padding: 0 8px;
		border-top: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		color: var(--text-normal);
		font-size: 0.8em;
		flex-shrink: 0;
	}

	.ratel-status-left {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		padding: 4px 8px;
		cursor: pointer;
		color: inherit;
		font: inherit;
		border-radius: 4px;
	}

	.ratel-status-left:hover {
		background: var(--background-modifier-border-hover);
	}

	.ratel-status-right {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.ratel-status-dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	/* 就绪:绿点稳定 */
	.ratel-dot-ready {
		background: var(--text-success);
	}

	/* 思考中:黄点脉冲 */
	.ratel-dot-thinking {
		background: var(--text-warning);
		animation: ratel-pulse 1.5s ease-in-out infinite;
	}

	/* 索引中:黄点脉冲(与思考中同色,文字区分) */
	.ratel-dot-indexing {
		background: var(--text-warning);
		animation: ratel-pulse 1.5s ease-in-out infinite;
	}

	/* 错误:红点 */
	.ratel-dot-error {
		background: var(--text-error);
	}

	/* 未配置:灰圈空心 */
	.ratel-dot-unconfigured {
		background: transparent;
		border: 1px solid var(--text-muted);
	}

	@keyframes ratel-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.ratel-status-text {
		font-size: 0.9em;
	}

	.ratel-text-ready {
		color: var(--text-normal);
	}

	.ratel-text-thinking,
	.ratel-text-indexing {
		color: var(--text-warning);
	}

	.ratel-text-error {
		color: var(--text-error);
	}

	.ratel-text-unconfigured {
		color: var(--text-muted);
	}

	.ratel-status-arrow {
		font-size: 0.75em;
		color: var(--text-muted);
	}

	.ratel-ctx-bar {
		position: relative;
		overflow: hidden;
		border-radius: 2px;
	}

	.ratel-ctx-fill {
		height: 100%;
		transition: width 0.2s ease, background 0.2s ease;
	}

	.ratel-ctx-pct {
		font-family: var(--font-monospace);
		font-size: 10px;
		min-width: 32px;
		text-align: right;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-dot-thinking,
		.ratel-dot-indexing {
			animation: none;
		}
	}
</style>
