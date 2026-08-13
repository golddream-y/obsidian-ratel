<!--
	@file src/ui/motion/brand/ShinyBrand.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/TextAnimations/ShinyText/ShinyText.tsx
	@description Header 品牌扫光 — CSS background-size 200% + shiny-shift（无 motion 库）
	@module ui/motion/brand/ShinyBrand
-->
<script lang="ts">
	interface Props {
		text: string;
		motionOn: boolean;
	}

	let { text, motionOn }: Props = $props();
</script>

<span class="ratel-header-mark">
	{#if motionOn}
		<span class="ratel-shiny-brand">
			<span class="ratel-shiny-brand-text">{text}</span><span
				class="ratel-header-dot ratel-shiny-brand-dot"
				aria-hidden="true"
			>.</span>
		</span>
	{:else}
		{text}<span class="ratel-header-dot" aria-hidden="true">.</span>
	{/if}
</span>

<style>
	.ratel-header-mark {
		font-size: 15px;
		font-weight: 650;
		letter-spacing: -0.02em;
		color: var(--text-normal);
		flex-shrink: 0;
		/* 安全路径:禁止合成加粗,避免「Ratel.」的点看起来比正文更重 */
		font-synthesis: none;
	}

	.ratel-header-dot {
		font-weight: inherit;
		color: var(--ratel-cite, var(--interactive-accent));
	}

	.ratel-shiny-brand {
		display: inline;
	}

	.ratel-shiny-brand-text {
		display: inline;
		background: linear-gradient(
			120deg,
			var(--text-normal) 0%,
			var(--text-normal) 35%,
			color-mix(in srgb, var(--text-normal) 20%, white) 50%,
			var(--text-normal) 65%,
			var(--text-normal) 100%
		);
		background-size: 200% auto;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation: ratel-shiny-shift 5s linear infinite;
	}

	.ratel-shiny-brand:hover .ratel-shiny-brand-text {
		/* hover 加强:扫光更快、高光更亮 */
		background: linear-gradient(
			120deg,
			var(--text-normal) 0%,
			var(--text-normal) 30%,
			color-mix(in srgb, var(--text-normal) 10%, white) 50%,
			var(--text-normal) 70%,
			var(--text-normal) 100%
		);
		background-size: 200% auto;
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		animation-duration: 2.5s;
	}

	.ratel-shiny-brand-dot {
		-webkit-text-fill-color: currentColor;
	}

	@keyframes ratel-shiny-shift {
		0% {
			background-position: 100% center;
		}
		100% {
			background-position: -100% center;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-shiny-brand-text {
			animation: none;
			background: none;
			-webkit-text-fill-color: var(--text-normal);
			color: var(--text-normal);
		}
	}
</style>
