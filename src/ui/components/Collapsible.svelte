<!--
	@file src/ui/components/Collapsible.svelte
	@description 通用折叠容器 — think / tool 段共用,slot 内容 + prop 控制样式
	@module ui/components/Collapsible
	设计:毛玻璃背景 + 细边框 + 微阴影 + 左侧 accent 色带
-->
<script lang="ts">
	/**
	 * Collapsible 折叠容器 props。
	 *
	 * @param title - 折叠条标题文本
	 * @param icon - 标题前缀图标(如 ✓ ✗ 💭)
	 * @param iconClass - 图标样式类(done/failed/calling/think)
	 * @param expanded - 受控展开状态(支持 bind:expanded;未绑定时用 defaultExpanded 初始化)
	 * @param defaultExpanded - 初始是否展开(仅在未绑定 expanded 时作为初值)
	 * @param accentColor - 左边框颜色 CSS 变量(如 var(--text-warning))
	 * @param onToggle - 切换回调(可选,用于父组件感知切换)
	 * @param children - slot 内容(think 文本 / tool 详情)
	 */
	let {
		title,
		icon = '',
		iconClass = '',
		expanded = $bindable(false),
		defaultExpanded = false,
		accentColor = 'var(--background-modifier-border)',
		onToggle,
		children,
	}: {
		title: string;
		icon?: string;
		iconClass?: string;
		expanded?: boolean;
		defaultExpanded?: boolean;
		accentColor?: string;
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
	style="--ratel-accent: {accentColor}"
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
		<span class="ratel-collapsible-title">{title}</span>
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
	 * 关键路径:容器使用毛玻璃效果(backdrop-filter)与半透明背景,
	 * 配合 1px 边框与微阴影营造层次感。左侧 2px accent 色带提供视觉锚点。
	 * 圆角 6px 符合设计系统(≤8px)。
	 */
	.ratel-collapsible {
		border-left: 2px solid var(--ratel-accent);
		border-radius: 6px;
		background: color-mix(in srgb, var(--ratel-accent) 8%, transparent);
		/* 关键路径:半透明背景 + backdrop-filter 实现毛玻璃质感 */
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		border-top: 1px solid color-mix(in srgb, var(--ratel-accent) 12%, var(--background-modifier-border));
		border-right: 1px solid color-mix(in srgb, var(--ratel-accent) 12%, var(--background-modifier-border));
		border-bottom: 1px solid color-mix(in srgb, var(--ratel-accent) 12%, var(--background-modifier-border));
		margin-bottom: 6px;
		/* 关键路径:微阴影增强层次,用户明确要求阴影效果 */
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04);
		overflow: hidden;
		transition: box-shadow 0.2s ease, background 0.2s ease;
	}

	.ratel-collapsible-expanded {
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06);
	}

	.ratel-collapsible-hdr {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 7px 10px;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
		user-select: none;
		text-align: left;
		transition: background 0.15s ease;
	}

	.ratel-collapsible-hdr:hover {
		background: color-mix(in srgb, var(--ratel-accent) 6%, transparent);
	}

	.ratel-collapsible-icon {
		flex-shrink: 0;
		font-size: 11px;
		width: 12px;
		text-align: center;
		font-weight: 600;
	}

	.ratel-collapsible-icon.done { color: var(--text-success); }
	.ratel-collapsible-icon.failed { color: var(--text-error); }
	.ratel-collapsible-icon.think { color: var(--text-warning); }

	.ratel-collapsible-title {
		flex: 1;
		font-size: 12px;
		font-family: var(--font-monospace);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-normal);
	}

	.ratel-collapsible-arrow {
		font-size: 10px;
		opacity: 0.55;
		transition: transform 0.2s ease, opacity 0.2s ease;
		flex-shrink: 0;
	}

	.ratel-collapsible-hdr:hover .ratel-collapsible-arrow {
		opacity: 0.85;
	}

	.ratel-collapsible-arrow-collapsed {
		transform: rotate(-90deg);
	}

	.ratel-collapsible-body {
		padding: 8px 10px 10px;
		font-size: 11.5px;
		line-height: 1.5;
		/* 关键路径:body 区与 header 用细分隔线区隔 */
		border-top: 1px solid color-mix(in srgb, var(--ratel-accent) 10%, var(--background-modifier-border));
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-collapsible-arrow,
		.ratel-collapsible,
		.ratel-collapsible-hdr {
			transition: none;
		}
	}
</style>
