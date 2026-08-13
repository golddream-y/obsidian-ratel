<!--
	@file src/ui/motion/title/EchoText.svelte
	@origin https://reactbits.dev/text-animations/echo-text
	@description 残影文字入场 — CSS 动画收拢，避免 rAF 被 $effect 清理掐死
	@module ui/motion/title/EchoText
	@depends ./echo-math
-->
<script lang="ts">
	import {
		echoDirectionDelta,
		echoLayerStyle,
		type EchoDirection,
		type EchoEase,
	} from './echo-math';

	interface Props {
		text: string;
		playToken: number;
		motionOn: boolean;
		echoes?: number;
		lag?: number;
		offset?: number;
		fade?: number;
		blur?: number;
		duration?: number;
		direction?: EchoDirection;
		ease?: EchoEase;
		tint?: string;
		accentLast?: boolean;
	}

	let {
		text,
		playToken,
		motionOn,
		echoes = 10,
		lag = 0.24,
		offset = 28,
		fade = 0.72,
		blur = 3,
		duration = 900,
		direction = 'right',
		ease = 'ease-out',
		tint = '',
		accentLast = false,
	}: Props = $props();

	let entering = $state(false);
	let settled = $state(false);

	const layers = $derived(Array.from({ length: Math.max(1, echoes) }, (_, i) => i));
	const dir = $derived(echoDirectionDelta(direction));
	const body = $derived(accentLast && text.endsWith('.') ? text.slice(0, -1) : text);
	const tail = $derived(accentLast && text.endsWith('.') ? '.' : '');

	/** 只跟 playToken / motionOn。动画本身走 CSS，cleanup 不会掐掉残影收拢 */
	$effect(() => {
		const token = playToken;
		if (!motionOn || token <= 0) {
			entering = false;
			settled = true;
			return;
		}
		entering = false;
		settled = false;
		const id = requestAnimationFrame(() => {
			entering = true;
		});
		const doneAt = duration * (1 + lag) + 60;
		const done = setTimeout(() => {
			settled = true;
		}, doneAt);
		return () => {
			cancelAnimationFrame(id);
			clearTimeout(done);
		};
	});
</script>

{#if !motionOn}
	<span class="ratel-echo">{body}{#if tail}<span class="ratel-echo-dot">{tail}</span>{/if}</span>
{:else}
	<span
		class="ratel-echo"
		class:is-in={entering}
		class:is-settled={settled}
		style:--echo-tint={tint || 'currentColor'}
		style:--echo-dur={`${duration}ms`}
		style:--echo-ease={ease === 'linear'
			? 'linear'
			: ease === 'snappy'
				? 'cubic-bezier(0.22, 1, 0.36, 1)'
				: ease === 'ease-in-out'
					? 'ease-in-out'
					: 'ease-out'}
	>
		{#each layers as i (i)}
			{@const layerIndex = echoes - 1 - i}
			{@const layer = echoLayerStyle(
				layerIndex,
				echoes,
				0,
				offset,
				lag,
				fade,
				blur,
				direction,
				ease,
			)}
			<span
				class="ratel-echo-ghost"
				aria-hidden="true"
				style:--echo-x={`${dir.x * offset * ((layerIndex + 1) / echoes)}px`}
				style:--echo-y={`${dir.y * offset * ((layerIndex + 1) / echoes)}px`}
				style:--echo-delay={`${((layerIndex + 1) / echoes) * lag * duration}ms`}
				style:--echo-blur={`${blur * ((layerIndex + 1) / echoes)}px`}
				style:opacity={layer.opacity}
			>{body}{#if tail}<span class="ratel-echo-dot">{tail}</span>{/if}</span>
		{/each}
		<span class="ratel-echo-front"
			>{#if settled}<span class="ratel-echo-shine">{body}</span>{:else}{body}{/if}{#if tail}<span
				class="ratel-echo-dot">{tail}</span
			>{/if}</span
		>
	</span>
{/if}

<style>
	.ratel-echo {
		position: relative;
		display: inline;
		font: inherit;
		font-weight: inherit;
		color: inherit;
		line-height: 1;
		white-space: nowrap;
		overflow: visible;
		vertical-align: baseline;
	}

	.ratel-echo-ghost,
	.ratel-echo-front {
		white-space: nowrap;
	}

	.ratel-echo-ghost {
		position: absolute;
		left: 0;
		top: 0;
		color: var(--echo-tint, currentColor);
		pointer-events: none;
		user-select: none;
		transform: translate(var(--echo-x), var(--echo-y));
		filter: blur(var(--echo-blur));
		will-change: transform, filter;
	}

	.ratel-echo-ghost .ratel-echo-dot {
		color: inherit;
	}

	.ratel-echo.is-in .ratel-echo-ghost {
		animation: ratel-echo-collapse var(--echo-dur, 900ms) var(--echo-ease, ease-out) forwards;
		animation-delay: var(--echo-delay, 0ms);
	}

	.ratel-echo.is-settled .ratel-echo-ghost {
		display: none;
	}

	.ratel-echo-front {
		position: relative;
		z-index: 1;
	}

	.ratel-echo-shine {
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
		animation: ratel-echo-shiny-shift 5s linear infinite;
	}

	.ratel-echo:hover .ratel-echo-shine {
		animation-duration: 2.5s;
	}

	.ratel-echo-dot {
		color: var(--ratel-cite, var(--interactive-accent));
	}

	@keyframes ratel-echo-collapse {
		to {
			transform: translate(0, 0);
			filter: blur(0);
		}
	}

	@keyframes ratel-echo-shiny-shift {
		0% {
			background-position: 100% center;
		}
		100% {
			background-position: -100% center;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-echo-ghost {
			display: none;
			animation: none;
		}

		.ratel-echo-shine {
			animation: none;
			background: none;
			-webkit-text-fill-color: var(--text-normal);
			color: var(--text-normal);
		}
	}
</style>
