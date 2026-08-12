<!--
	@file src/ui/motion/chrome/GlareHover.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Animations/GlareHover/GlareHover.tsx
	@description 发送钮悬停扫光 — pointer 跟踪 radial 高光（无 motion 库）
	@module ui/motion/chrome/GlareHover
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		enabled?: boolean;
		children: Snippet;
	}

	let { enabled = true, children }: Props = $props();

	let root = $state<HTMLDivElement | undefined>();

	/**
	 * 指针移动时更新扫光中心 CSS 变量。
	 *
	 * @param e - pointermove 事件
	 */
	function onMove(e: PointerEvent): void {
		if (!root) return;
		const rect = root.getBoundingClientRect();
		const x = ((e.clientX - rect.left) / rect.width) * 100;
		const y = ((e.clientY - rect.top) / rect.height) * 100;
		root.style.setProperty('--ratel-glare-x', `${x}%`);
		root.style.setProperty('--ratel-glare-y', `${y}%`);
	}

	/** 指针离开时重置扫光中心到正中。 */
	function onLeave(): void {
		if (!root) return;
		root.style.setProperty('--ratel-glare-x', '50%');
		root.style.setProperty('--ratel-glare-y', '50%');
	}
</script>

<div
	class="ratel-glare"
	class:is-on={enabled}
	bind:this={root}
	onpointermove={enabled ? onMove : undefined}
	onpointerleave={enabled ? onLeave : undefined}
>
	{#if enabled}<div class="ratel-glare-shine" aria-hidden="true"></div>{/if}
	{@render children()}
</div>

<style>
	.ratel-glare {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		align-self: flex-end;
		border-radius: 10px;
		overflow: hidden;
	}

	.ratel-glare-shine {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		pointer-events: none;
		z-index: 1;
		background: radial-gradient(
			circle 90% at var(--ratel-glare-x, 50%) var(--ratel-glare-y, 50%),
			color-mix(in srgb, white 42%, transparent) 0%,
			transparent 65%
		);
		opacity: 0;
		transition: opacity 0.18s ease;
	}

	.ratel-glare.is-on:hover .ratel-glare-shine {
		opacity: 1;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-glare-shine {
			display: none;
		}
	}
</style>
