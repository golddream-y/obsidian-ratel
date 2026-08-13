<!--
	@file src/ui/motion/empty/RotateHint.svelte
	@description 空态欢迎副句 — 双层交叉淡入轮换
	@module ui/motion/empty/RotateHint
	@depends ./rotate-hint-policy
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { nextHintIndex } from './rotate-hint-policy';

	interface Props {
		hints: string[];
		play: boolean;
		intervalMs?: number;
	}

	let { hints, play, intervalMs = 3200 }: Props = $props();

	let currentIndex = $state(0);
	let showLayerA = $state(true);
	let textA = $state('');
	let textB = $state('');
	let timer: ReturnType<typeof setInterval> | null = null;

	const displayText = $derived(play ? undefined : (hints[0] ?? ''));

	function clearTimer() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function resetToFirst() {
		currentIndex = 0;
		showLayerA = true;
		const first = hints[0] ?? '';
		textA = first;
		textB = first;
	}

	$effect(() => {
		clearTimer();

		if (!play) {
			resetToFirst();
			return;
		}

		resetToFirst();

		if (hints.length <= 1) {
			return;
		}

		// 关键路径: 仅 play 且多条 hint 时启动轮换 timer
		timer = setInterval(() => {
			const next = nextHintIndex(currentIndex, hints.length);
			const nextText = hints[next] ?? '';

			if (showLayerA) {
				textB = nextText;
				showLayerA = false;
			} else {
				textA = nextText;
				showLayerA = true;
			}
			currentIndex = next;
		}, intervalMs);

		return clearTimer;
	});

	onDestroy(clearTimer);
</script>

{#if !play}
	<p class="ratel-rotate-hint ratel-rotate-hint--static">{displayText}</p>
{:else}
	<div class="ratel-rotate-hint">
		<p class="ratel-rotate-hint-layer" class:is-visible={showLayerA}>{textA}</p>
		<p class="ratel-rotate-hint-layer" class:is-visible={!showLayerA}>{textB}</p>
	</div>
{/if}

<style>
	.ratel-rotate-hint {
		display: grid;
		justify-items: center;
		margin: 0.5rem 0 0;
		width: 100%;
		min-width: 0;
		/* 关键路径:两层叠同一格，格子有宽度，中文不会被挤成竖排；窄侧栏可折行 */
		flex-shrink: 0;
		text-align: center;
	}

	.ratel-rotate-hint--static {
		display: block;
		margin: 0.5rem 0 0;
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--text-muted);
		width: 100%;
		max-width: 100%;
		font-family: var(--font-monospace);
	}

	.ratel-rotate-hint-layer {
		grid-area: 1 / 1;
		margin: 0;
		width: 100%;
		font-size: 0.8125rem;
		line-height: 1.4;
		color: var(--text-muted);
		font-family: var(--font-monospace);
		text-align: center;
		overflow-wrap: break-word;
		opacity: 0;
		transition: opacity 480ms ease;
	}

	.ratel-rotate-hint-layer.is-visible {
		opacity: 1;
	}
</style>
