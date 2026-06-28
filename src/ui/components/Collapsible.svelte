<!--
	@file src/ui/components/Collapsible.svelte
	@description 通用折叠容器 — think / tool 段共用,slot 内容 + prop 控制样式
	@module ui/components/Collapsible
	设计:中性卡片背景 + 细边框 + hover 微阴影 + 无左侧色带
-->
<script lang="ts">
	/**
	 * Collapsible 折叠容器 props。
	 *
	 * @param title - 折叠条标题文本
	 * @param icon - 标题前缀图标(如 ✓ ✗ 💭)
	 * @param iconClass - 图标样式类(done/failed/calling/think)
	 * @param variant - 卡片变体: 'think' 用 sans-serif 标题, 'tool' 用 mono 标题
	 * @param titleClass - 标题附加 CSS 类(用于状态色如 done/failed)
	 * @param expanded - 受控展开状态(支持 bind:expanded;未绑定时用 defaultExpanded 初始化)
	 * @param defaultExpanded - 初始是否展开(仅在未绑定 expanded 时作为初值)
	 * @param onToggle - 切换回调(可选,用于父组件感知切换)
	 * @param children - slot 内容(think 文本 / tool 详情)
	 */
	let {
		title,
		icon = '',
		iconClass = '',
		variant = 'tool',
		titleClass = '',
		expanded = $bindable(false),
		defaultExpanded = false,
		onToggle,
		children,
	}: {
		title: string;
		icon?: string;
		iconClass?: string;
		variant?: 'think' | 'tool';
		titleClass?: string;
		expanded?: boolean;
		defaultExpanded?: boolean;
		onToggle?: (next: boolean) => void;
		children: import('svelte').Snippet;
	} = $props();

	// 关键路径:首次挂载用 defaultExpanded 初始化(仅在父未显式 bind 时生效)
	// Svelte 5 $bindable 的 fallback 仅在父未传值时使用,故此处 effect 仅初始化一次
	let initialized = false;
	$effect(() => {
		if (!initialized) {
			initialized = true;
			if (defaultExpanded) expanded = true;
		}
	});

	function toggle() {
		expanded = !expanded;
		onToggle?.(expanded);
	}
</script>

<div
	class="ratel-collapsible"
	class:ratel-collapsible-expanded={expanded}
>
	<button
		class="ratel-collapsible-hdr"
		onclick={toggle}
		aria-expanded={expanded}
		type="button"
	>
		{#if icon}
			<span class="ratel-collapsible-icon {iconClass}">{icon}</span>
		{/if}
		<span
			class="ratel-collapsible-title {titleClass}"
			class:ratel-collapsible-title-think={variant === 'think'}
		>{title}</span>
		<span class="ratel-collapsible-arrow" class:ratel-collapsible-arrow-collapsed={!expanded}>▼</span>
	</button>
	{#if expanded}
		<div class="ratel-collapsible-body">
			{@render children()}
		</div>
	{/if}
</div>

<style>
	/*
	 * 关键路径:中性卡片背景 + 统一边框,无左侧色带。
	 * hover 时微阴影增强层次感,无 backdrop-filter。
	 */
	.ratel-collapsible {
		border-radius: 6px;
		background: var(--background-secondary-alt, var(--background-modifier-form-field));
		border: 1px solid var(--background-modifier-border);
		margin-bottom: 6px;
		overflow: hidden;
		transition: box-shadow 0.15s ease;
	}

	.ratel-collapsible:hover {
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
	}

	.ratel-collapsible-hdr {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 8px 12px;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
		user-select: none;
		text-align: left;
		font-size: 12px;
		transition: background 0.12s ease;
	}

	.ratel-collapsible-hdr:hover {
		background: color-mix(in srgb, var(--text-normal) 3%, transparent);
	}

	.ratel-collapsible-icon {
		flex-shrink: 0;
		font-size: 13px;
		width: 18px;
		text-align: center;
		font-weight: 600;
	}

	.ratel-collapsible-icon.done { color: var(--text-success); }
	.ratel-collapsible-icon.failed { color: var(--text-error); }
	.ratel-collapsible-icon.think { color: var(--text-warning); }

	/* 关键路径:calling 状态用 pulsing dot 替代文本图标 */
	.ratel-collapsible-icon.calling {
		font-size: 0;
		line-height: 0;
	}

	.ratel-collapsible-icon.calling::after {
		content: '';
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-warning);
		animation: ratel-collapsible-pulse 1.2s infinite;
		box-shadow: 0 0 6px color-mix(in srgb, var(--text-warning) 50%, transparent);
	}

	.ratel-collapsible-title {
		flex: 1;
		font-size: 12px;
		font-family: var(--font-monospace);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
	}

	/* 关键路径:title 状态色与 icon 同步,增强视觉一致性 */
	.ratel-collapsible-title.done { color: var(--text-success); }
	.ratel-collapsible-title.failed { color: var(--text-error); }

	/* think 变体:sans-serif + warning 色 */
	.ratel-collapsible-title-think {
		font-family: inherit;
		color: var(--text-warning);
		font-weight: 500;
	}

	.ratel-collapsible-arrow {
		font-size: 10px;
		opacity: 0.5;
		transition: transform 0.25s ease;
		flex-shrink: 0;
	}

	.ratel-collapsible-arrow-collapsed {
		transform: rotate(-90deg);
	}

	.ratel-collapsible-body {
		padding: 10px 12px;
		font-size: 11.5px;
		line-height: 1.5;
		border-top: 1px solid var(--background-modifier-border);
	}

	@keyframes ratel-collapsible-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-collapsible-arrow,
		.ratel-collapsible,
		.ratel-collapsible-hdr {
			transition: none;
		}
		.ratel-collapsible-icon.calling::after {
			animation: none;
		}
	}
</style>
