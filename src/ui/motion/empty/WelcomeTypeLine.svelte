<!--
	@file src/ui/motion/empty/WelcomeTypeLine.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/TextAnimations/TextType/TextType.tsx
	@description 空态欢迎副句 — setInterval 逐字打字，只打一次不循环
	@module ui/motion/empty/WelcomeTypeLine
-->
<script lang="ts">
	import { onDestroy } from 'svelte';

	interface Props {
		text: string;
		play: boolean;
		charMs?: number;
	}

	let { text, play, charMs = 50 }: Props = $props();

	let displayed = $state(play ? '' : text);
	let timer: ReturnType<typeof setInterval> | null = null;

	function clearTimer() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	$effect(() => {
		clearTimer();

		if (!play) {
			displayed = text;
			return;
		}

		displayed = '';
		let idx = 0;

		// 关键路径:单次 setInterval 逐字推进，打完即清，不循环
		timer = setInterval(() => {
			idx += 1;
			if (idx > text.length) {
				clearTimer();
				return;
			}
			displayed = text.slice(0, idx);
		}, charMs);

		return clearTimer;
	});

	onDestroy(clearTimer);
</script>

<p class="ratel-welcome-type">{displayed}</p>

<style>
	.ratel-welcome-type {
		margin: 0.5rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--text-muted);
		max-width: 18rem;
		font-family: var(--font-monospace);
	}
</style>
