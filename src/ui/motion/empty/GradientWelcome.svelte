<!--
	@file src/ui/motion/empty/GradientWelcome.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/TextAnimations/GradientText/GradientText.tsx
	@description 空态欢迎主句 — GradientText 色带包装 Blur 入场 stagger
	@module ui/motion/empty/GradientWelcome
	@depends ./WelcomeBlurText
-->
<script lang="ts">
	import WelcomeBlurText from './WelcomeBlurText.svelte';

	interface Props {
		text: string;
		play: boolean;
	}

	let { text, play }: Props = $props();
</script>

<div class="ratel-gradient-welcome">
	<WelcomeBlurText text={text} play={play} />
</div>

<style>
	.ratel-gradient-welcome :global(.ratel-welcome-blur-unit),
	.ratel-gradient-welcome :global(.ratel-welcome-blur-static) {
		background: linear-gradient(
			120deg,
			color-mix(in srgb, var(--text-normal) 70%, var(--interactive-accent) 30%),
			color-mix(in srgb, var(--interactive-accent) 55%, #e8c49a 45%),
			color-mix(in srgb, var(--text-normal) 75%, #3d5a56 25%)
		);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
</style>
