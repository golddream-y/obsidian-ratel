<script lang="ts">
	/**
	 * @file src/ui/status/StatusLine.svelte
	 * @description 底部常驻单行状态条 — 状态点 + 文字 + ctx 进度条 + source 指示器 + 展开 ▲
	 * @module ui/StatusLine
	 * @depends svelte/store, user-feedback/user-status
	 * 设计:毛玻璃背景 + source 指示点(estimate灰/streaming黄/api绿)+ 进度条精致圆角
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot, ContextUsage } from '../../user-feedback/user-status';

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

	/*
	 * 关键路径:source 指示器 — 区分 token 数据来源可信度。
	 * - estimate(send 前):灰点,粗估
	 * - streaming(流式中):黄点,实时累计
	 * - api(message.end):绿点,真值校准
	 * - undefined(旧调用方):默认 estimate
	 */
	const sourceInfo = $derived.by(() => {
		const src = usage.source ?? 'estimate';
		if (src === 'api') {
			return { label: 'API', dotClass: 'ratel-sl-src-api', title: 'API 真值校准' };
		}
		if (src === 'streaming') {
			return { label: '流式', dotClass: 'ratel-sl-src-streaming', title: '流式累计估算' };
		}
		return { label: '估算', dotClass: 'ratel-sl-src-estimate', title: '本地估算' };
	});
</script>

<!-- 关键路径:整行可点击切换 Drawer,与 mockup 一致 -->
<div
	class="ratel-status-line"
	onclick={onToggle}
	role="button"
	aria-expanded={expanded}
	aria-label={expanded ? '收起详情' : '展开详情'}
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
	<div
		class="ratel-sl-ctx"
		title={`${sourceInfo.title} · 已用 ${usage.usedTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens`}
	>
		<div class="ratel-sl-ctx-bar">
			<div class="ratel-sl-ctx-fill" style={`width: ${pct}%; background: ${ctxColor};`}></div>
		</div>
		<span class="ratel-sl-ctx-pct" style={`color: ${ctxColor};`}>{usage.percentage}%</span>
		<!-- 关键路径:source 指示点 + 标签,让用户感知当前 token 统计的可信度 -->
		<span class="ratel-sl-src {sourceInfo.dotClass}" title={sourceInfo.title}>
			<span class="ratel-sl-src-dot"></span>
			<span class="ratel-sl-src-label">{sourceInfo.label}</span>
		</span>
	</div>
	<span class="ratel-sl-arrow">▲</span>
</div>

<style>
	/*
	 * 关键路径:状态条使用毛玻璃背景,与 Header/输入区视觉一致。
	 * 高度 30px 常驻底部,hover 微亮反馈。
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
		box-shadow: 0 0 6px color-mix(in srgb, var(--text-success) 40%, transparent);
	}

	.ratel-sl-dot-thinking {
		background: var(--text-warning);
		animation: ratel-sl-pulse 1.2s infinite;
	}

	.ratel-sl-dot-error {
		background: var(--text-error);
		box-shadow: 0 0 6px color-mix(in srgb, var(--text-error) 40%, transparent);
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
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06) inset;
	}

	.ratel-sl-ctx-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.3s ease;
		box-shadow: 0 0 4px color-mix(in srgb, currentColor 30%, transparent);
	}

	.ratel-sl-ctx-pct {
		font-size: 10px;
		font-family: var(--font-monospace);
		min-width: 28px;
		text-align: right;
		font-weight: 600;
	}

	/*
	 * 关键路径:source 指示器 — 小圆点 + 标签,精致紧凑。
	 * estimate 灰色,streaming 黄色脉冲,api 绿色(最可信)。
	 */
	.ratel-sl-src {
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 1px 6px 1px 5px;
		border-radius: 8px;
		font-size: 9.5px;
		font-family: var(--font-monospace);
		font-weight: 500;
		letter-spacing: 0.2px;
		margin-left: 2px;
	}

	.ratel-sl-src-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.ratel-sl-src-label {
		opacity: 0.85;
	}

	.ratel-sl-src-estimate {
		background: color-mix(in srgb, var(--text-muted) 12%, transparent);
		color: var(--text-muted);
	}
	.ratel-sl-src-estimate .ratel-sl-src-dot {
		background: var(--text-muted);
	}

	.ratel-sl-src-streaming {
		background: color-mix(in srgb, var(--text-warning) 12%, transparent);
		color: var(--text-warning);
	}
	.ratel-sl-src-streaming .ratel-sl-src-dot {
		background: var(--text-warning);
		animation: ratel-sl-src-pulse 1.2s infinite;
	}

	.ratel-sl-src-api {
		background: color-mix(in srgb, var(--text-success) 12%, transparent);
		color: var(--text-success);
	}
	.ratel-sl-src-api .ratel-sl-src-dot {
		background: var(--text-success);
		box-shadow: 0 0 4px color-mix(in srgb, var(--text-success) 50%, transparent);
	}

	@keyframes ratel-sl-src-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-sl-src-streaming .ratel-sl-src-dot {
			animation: none;
		}
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
