<!--
	@file src/ui/motion/brand/ClickSpark.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Animations/ClickSpark/ClickSpark.tsx
	@description 发送钮火花 — 纯 canvas 粒子 burst API（无 motion 库）
	@module ui/motion/brand/ClickSpark
	@depends ./spark-ease
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { sparkEaseOut } from './spark-ease';

	interface Spark {
		x: number;
		y: number;
		angle: number;
		startTime: number;
	}

	interface Props {
		children: Snippet;
		enabled?: boolean;
		sparkCount?: number;
		duration?: number;
		sparkSize?: number;
		sparkRadius?: number;
		extraScale?: number;
	}

	let {
		children,
		enabled = true,
		sparkCount = 8,
		duration = 400,
		sparkSize = 10,
		sparkRadius = 15,
		extraScale = 1.0,
	}: Props = $props();

	let rootEl = $state<HTMLDivElement | undefined>();
	let canvasEl = $state<HTMLCanvasElement | undefined>();

	let sparks: Spark[] = [];
	let animId: number | null = null;
	let sparkColor = '';

	function resizeCanvas(): void {
		if (!canvasEl || !rootEl) return;
		const { width, height } = rootEl.getBoundingClientRect();
		if (canvasEl.width !== width || canvasEl.height !== height) {
			canvasEl.width = width;
			canvasEl.height = height;
		}
	}

	function readSparkColor(): string {
		if (!rootEl) return '#ffffff';
		const accent = getComputedStyle(rootEl).getPropertyValue('--interactive-accent').trim();
		return accent || '#ffffff';
	}

	/**
	 * 在按钮中心（或指定坐标）触发一次火花 burst。
	 *
	 * @param x - canvas 内 x；省略则用容器中心
	 * @param y - canvas 内 y；省略则用容器中心
	 */
	export function burst(x?: number, y?: number): void {
		if (!enabled || !canvasEl || !rootEl) return;

		sparkColor = readSparkColor();
		const rect = canvasEl.getBoundingClientRect();
		const cx = x ?? rect.width / 2;
		const cy = y ?? rect.height / 2;
		const now = performance.now();

		const batch: Spark[] = Array.from({ length: sparkCount }, (_, i) => ({
			x: cx,
			y: cy,
			angle: (2 * Math.PI * i) / sparkCount,
			startTime: now,
		}));
		sparks.push(...batch);
		startLoop();
	}

	function draw(timestamp: number): void {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

		sparks = sparks.filter((spark) => {
			const elapsed = timestamp - spark.startTime;
			if (elapsed >= duration) return false;

			const progress = elapsed / duration;
			const eased = sparkEaseOut(progress);
			const distance = eased * sparkRadius * extraScale;
			const lineLength = sparkSize * (1 - eased);

			const x1 = spark.x + distance * Math.cos(spark.angle);
			const y1 = spark.y + distance * Math.sin(spark.angle);
			const x2 = spark.x + (distance + lineLength) * Math.cos(spark.angle);
			const y2 = spark.y + (distance + lineLength) * Math.sin(spark.angle);

			ctx.strokeStyle = sparkColor || readSparkColor();
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
			return true;
		});

		if (sparks.length > 0) {
			animId = requestAnimationFrame(draw);
		} else {
			animId = null;
		}
	}

	function startLoop(): void {
		if (animId !== null) return;
		animId = requestAnimationFrame(draw);
	}

	onMount(() => {
		resizeCanvas();
		let resizeTimeout: ReturnType<typeof setTimeout> | undefined;

		const handleResize = (): void => {
			clearTimeout(resizeTimeout);
			resizeTimeout = setTimeout(resizeCanvas, 100);
		};

		const ro = new ResizeObserver(handleResize);
		if (rootEl) ro.observe(rootEl);

		return () => {
			ro.disconnect();
			clearTimeout(resizeTimeout);
			if (animId !== null) cancelAnimationFrame(animId);
		};
	});
</script>

<div class="ratel-click-spark" bind:this={rootEl}>
	<canvas class="ratel-click-spark-canvas" bind:this={canvasEl} aria-hidden="true"></canvas>
	{@render children()}
</div>

<style>
	.ratel-click-spark {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		align-self: flex-end;
	}

	.ratel-click-spark-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 1;
	}
</style>
