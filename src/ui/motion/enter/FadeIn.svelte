<!--
	@file src/ui/motion/enter/FadeIn.svelte
	@origin https://github.com/DavidHDev/react-bits (Fade Content / Animated Content 参数级)
	@description 通用块级入场 — 仅首次 mount 播 translateY+opacity
	@module ui/motion/enter/FadeIn
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';

	interface Props {
		play: boolean;
		delayMs?: number;
		children: Snippet;
	}

	let { play, delayMs = 0, children }: Props = $props();

	/** 关键路径:仅首次 mount 加 class，streaming 子树更新不重播 */
	let animate = $state(false);

	onMount(() => {
		if (play) animate = true;
	});
</script>

<div
	class="ratel-fade-in-wrap"
	class:ratel-fade-in-active={animate}
	style:--ratel-fade-in-delay="{animate ? delayMs : 0}ms"
>
	{@render children()}
</div>

<style>
	/* 关键路径:flex 列 + 满宽，子节点 align-self:flex-end 才能右对齐用户气泡 */
	.ratel-fade-in-wrap {
		display: flex;
		flex-direction: column;
		width: 100%;
	}

	.ratel-fade-in-active > :global(*) {
		opacity: 0;
		transform: translateY(6px);
		animation: ratel-fade-in 220ms ease forwards;
		animation-delay: var(--ratel-fade-in-delay, 0ms);
	}

	@keyframes ratel-fade-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-fade-in-active > :global(*) {
			animation: none;
			opacity: 1;
			transform: none;
		}
	}
</style>
