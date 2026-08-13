<!--
	@file src/ui/motion/title/TitleDissolve.svelte
	@origin https://github.com/DavidHDev/react-bits (TextAnimations / crossfade 参数级)
	@description 会话标题 chip 落定 — playToken 递增时播一次 blur+opacity 溶解（≤280ms）
	@module ui/motion/title/TitleDissolve
-->
<script lang="ts">
	interface Props {
		text: string;
		playToken: number;
		motionOn: boolean;
	}

	let { text, playToken, motionOn }: Props = $props();

	/** 关键路径:同 token 不重播；会话切换不重置 token 时也不误播 */
	let lastPlayedToken = $state(-1);
	let dissolving = $state(false);

	const DURATION_MS = 260;

	$effect(() => {
		const token = playToken;
		if (token === lastPlayedToken) return;

		lastPlayedToken = token;

		if (!motionOn || token <= 0) {
			dissolving = false;
			return;
		}

		dissolving = true;
		const timer = setTimeout(() => {
			dissolving = false;
		}, DURATION_MS);
		return () => clearTimeout(timer);
	});
</script>

{#if !motionOn}
	<span class="ratel-title-dissolve ratel-title-dissolve-static">{text}</span>
{:else}
	<span
		class="ratel-title-dissolve"
		class:ratel-title-dissolve-active={dissolving}
	>{text}</span>
{/if}

<style>
	.ratel-title-dissolve {
		display: inline;
		min-width: 0;
	}

	.ratel-title-dissolve-static {
		opacity: 1;
		filter: none;
	}

	.ratel-title-dissolve-active {
		opacity: 0;
		filter: blur(6px);
		animation: ratel-title-dissolve 260ms ease forwards;
	}

	@keyframes ratel-title-dissolve {
		from {
			opacity: 0;
			filter: blur(6px);
		}
		to {
			opacity: 1;
			filter: blur(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-title-dissolve-active {
			animation: none;
			opacity: 1;
			filter: none;
		}
	}
</style>
