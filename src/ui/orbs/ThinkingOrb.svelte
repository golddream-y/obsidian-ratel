<!--
	@file src/ui/orbs/ThinkingOrb.svelte
	@description Canvas 点阵思考球 — 移植 thinking-orbs 引擎，无 React
	@module ui/orbs/ThinkingOrb
	@depends ./engine/registry, ./presets, ./theme, ./types
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { MODE_DRAWS } from './engine/registry';
	import { coerceOrbSize, resolvePreset } from './presets';
	import { prefersOrbReducedMotion, resolveOrbDark } from './theme';
	import type { OrbState, OrbTheme } from './types';
	import { t, type StringKey } from '../../i18n';

	let {
		orbState = 'working',
		size = 20,
		theme = 'auto',
		speed = 1,
		paused = false,
		ariaLabel = null,
	}: {
		/** 动画动词；勿命名为 state — 会与 Svelte `$state` rune 冲突，编译成 store.subscribe */
		orbState?: OrbState;
		/** 逻辑像素边长；非 20/64 时预设回退到最近档，CSS 仍按传入 size 显示 */
		size?: number;
		theme?: OrbTheme;
		speed?: number;
		paused?: boolean;
		ariaLabel?: string | null;
	} = $props();

	let canvasEl = $state<HTMLCanvasElement | null>(null);

	const labelKey = $derived(
		(
			{
				working: 'orb.state.working',
				searching: 'orb.state.searching',
				solving: 'orb.state.solving',
				listening: 'orb.state.listening',
				connecting: 'orb.state.connecting',
				weaving: 'orb.state.weaving',
				composing: 'orb.state.composing',
				breathing: 'orb.state.breathing',
				shaping: 'orb.state.shaping',
			} as const satisfies Record<OrbState, StringKey>
		)[orbState],
	);

	let stopLoop: (() => void) | null = null;

	function startPaint() {
		stopLoop?.();
		stopLoop = null;
		const canvas = canvasEl;
		if (!canvas) return;

		const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
		// 绘制用标定档；画布 CSS 边长仍用调用方 size，避免 12/14 直接打崩预设表
		const paintSize = coerceOrbSize(size);
		canvas.width = Math.round(paintSize * dpr);
		canvas.height = Math.round(paintSize * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		let mode: ReturnType<typeof resolvePreset>['mode'];
		let baseSpeed: number;
		let opts: ReturnType<typeof resolvePreset>['opts'];
		try {
			({ mode, speed: baseSpeed, opts } = resolvePreset(orbState, paintSize));
		} catch (err) {
			// 安全路径:预设异常时静默停画,绝不能抛到 ChatView 更新半途
			console.error('[ThinkingOrb] resolvePreset 失败', err);
			return;
		}
		const draw = MODE_DRAWS[mode];
		if (!draw) return;
		const effSpeed = baseSpeed * speed;
		const dark = resolveOrbDark(theme);
		const reduced = prefersOrbReducedMotion();

		let raf = 0;
		let running = false;
		const stop = () => {
			running = false;
			cancelAnimationFrame(raf);
		};
		const frame = (tSec: number) => {
			try {
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				ctx.clearRect(0, 0, paintSize, paintSize);
				draw(ctx, paintSize, tSec, dark, opts);
			} catch (err) {
				console.error('[ThinkingOrb] 帧绘制失败', err);
				stop();
			}
		};

		if (reduced) {
			frame(0.6);
			return;
		}

		const loop = () => {
			frame((performance.now() / 1000) * effSpeed);
			if (running) raf = requestAnimationFrame(loop);
		};
		const start = () => {
			if (running || paused) return;
			running = true;
			raf = requestAnimationFrame(loop);
		};

		frame((performance.now() / 1000) * effSpeed);

		let visible = true;
		const io =
			typeof IntersectionObserver !== 'undefined'
				? new IntersectionObserver(([entry]) => {
						visible = !!entry?.isIntersecting;
						if (visible && document.visibilityState !== 'hidden') start();
						else stop();
					})
				: null;
		io?.observe(canvas);
		const onVis = () => {
			if (document.visibilityState === 'hidden') stop();
			else if (visible) start();
		};
		document.addEventListener('visibilitychange', onVis);
		if (!io) start();

		stopLoop = () => {
			stop();
			io?.disconnect();
			document.removeEventListener('visibilitychange', onVis);
		};
	}

	$effect(() => {
		// 依赖 props：变更时重绑绘制循环
		void orbState;
		void size;
		void theme;
		void speed;
		void paused;
		void canvasEl;
		startPaint();
		return () => {
			stopLoop?.();
			stopLoop = null;
		};
	});

	onDestroy(() => {
		stopLoop?.();
		stopLoop = null;
	});
</script>

<canvas
	bind:this={canvasEl}
	class="ratel-thinking-orb"
	role="img"
	aria-label={ariaLabel ?? $t(labelKey)}
	width={size}
	height={size}
	style:width="{size}px"
	style:height="{size}px"
></canvas>

<style>
	.ratel-thinking-orb {
		display: block;
		flex-shrink: 0;
		vertical-align: middle;
	}
</style>
