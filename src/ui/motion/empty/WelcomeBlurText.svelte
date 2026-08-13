<!--
	@file src/ui/motion/empty/WelcomeBlurText.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/TextAnimations/BlurText/BlurText.tsx
	@description 空态欢迎主句 — span + CSS 模糊入场（无 motion 库）
	@module ui/motion/empty/WelcomeBlurText
	@depends ./blur-split
-->
<script lang="ts">
	import { splitBlurUnits, shouldGapBlurWords } from './blur-split';

	interface Props {
		text: string;
		play: boolean;
	}

	let { text, play }: Props = $props();

	/** 上游量级：约 80–120ms/单元 */
	const UNIT_DELAY_MS = 100;
	/** 上游 stepDuration≈0.35，两档共 0.7s */
	const ANIM_DURATION_S = 0.7;

	const units = $derived(splitBlurUnits(text, 'words'));
	/** 英文按词才留间距；中文按字，字间加空格会把句子拆开 */
	const gapWords = $derived(shouldGapBlurWords(text));
</script>

{#if !play}
	<p class="ratel-welcome-blur ratel-welcome-blur-static">{text}</p>
{:else}
	<p class="ratel-welcome-blur" aria-label={text}>
		{#each units as unit, i (i)}
			<span
				class="ratel-welcome-blur-unit"
				class:is-word-gap={gapWords && i < units.length - 1}
				style:animation-delay="{(i * UNIT_DELAY_MS) / 1000}s"
				style:animation-duration="{ANIM_DURATION_S}s"
			>
				{unit}
			</span>
		{/each}
	</p>
{/if}

<style>
	.ratel-welcome-blur {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
		line-height: 1.45;
		color: var(--text-normal);
		max-width: 100%;
		text-wrap: balance;
		overflow-wrap: break-word;
	}

	.ratel-welcome-blur-static {
		opacity: 1;
		filter: none;
		transform: none;
	}

	.ratel-welcome-blur-unit {
		display: inline-block;
		will-change: transform, filter, opacity;
		opacity: 0;
		filter: blur(10px);
		transform: translateY(-12px);
		animation: ratel-welcome-blur-in ease forwards;
	}

	.ratel-welcome-blur-unit.is-word-gap {
		/* 关键路径:inline-block 会吃掉标签内尾随空格，词间距用 margin，避免英文挤成一团 */
		margin-right: 0.33em;
	}

	@keyframes ratel-welcome-blur-in {
		0% {
			opacity: 0;
			filter: blur(10px);
			transform: translateY(-12px);
		}
		50% {
			opacity: 0.5;
			filter: blur(5px);
			transform: translateY(5px);
		}
		100% {
			opacity: 1;
			filter: blur(0);
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-welcome-blur-unit {
			animation: none;
			opacity: 1;
			filter: none;
			transform: none;
		}
	}
</style>
