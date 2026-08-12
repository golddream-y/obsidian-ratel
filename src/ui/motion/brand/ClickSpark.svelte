<!--
	@file src/ui/motion/brand/ClickSpark.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Animations/ClickSpark/ClickSpark.tsx
	@description 发送钮火花 — tick 触发；小范围 fixed 叠层挂 body，避免全屏 canvas 吞掉停止钮点击
	@module ui/motion/brand/ClickSpark
	@depends ./spark-ease
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onDestroy } from 'svelte';
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
		/** 递增则触发一次 burst（ChatView 入队成功后 +1） */
		tick?: number;
		sparkCount?: number;
		duration?: number;
		sparkSize?: number;
		sparkRadius?: number;
		extraScale?: number;
	}

	/** 火花层边长；以按钮中心为原点，勿铺满视口 */
	const LAYER = 96;

	let {
		children,
		enabled = true,
		tick = 0,
		sparkCount = 10,
		duration = 480,
		sparkSize = 12,
		sparkRadius = 28,
		extraScale = 1.1,
	}: Props = $props();

	let rootEl = $state<HTMLDivElement | undefined>();

	let sparks: Spark[] = [];
	let animId: number | null = null;
	let overlay: HTMLCanvasElement | null = null;
	let lastTick = 0;

	function ensureOverlay(): HTMLCanvasElement | null {
		if (typeof document === 'undefined') return null;
		if (overlay && overlay.isConnected) return overlay;
		const c = document.createElement('canvas');
		c.className = 'ratel-click-spark-overlay';
		c.setAttribute('aria-hidden', 'true');
		// 关键路径:内联 pointer-events，避免全屏/移出组件树后 scoped CSS 失效吞点击
		c.style.cssText =
			'position:fixed;pointer-events:none;z-index:10000;left:0;top:0;width:0;height:0;';
		document.body.appendChild(c);
		overlay = c;
		return c;
	}

	function placeOverlayAtButton(): { cx: number; cy: number } | null {
		if (!rootEl) return null;
		const canvas = ensureOverlay();
		if (!canvas) return null;
		const rect = rootEl.getBoundingClientRect();
		const left = rect.left + rect.width / 2 - LAYER / 2;
		const top = rect.top + rect.height / 2 - LAYER / 2;
		canvas.style.left = `${Math.round(left)}px`;
		canvas.style.top = `${Math.round(top)}px`;
		canvas.style.width = `${LAYER}px`;
		canvas.style.height = `${LAYER}px`;
		canvas.width = LAYER;
		canvas.height = LAYER;
		return { cx: LAYER / 2, cy: LAYER / 2 };
	}

	function readSparkColor(): string {
		if (!rootEl) return '#f0d4a8';
		const accent = getComputedStyle(rootEl).getPropertyValue('--interactive-accent').trim();
		return accent || '#f0d4a8';
	}

	function burst(): void {
		if (!enabled) return;
		const center = placeOverlayAtButton();
		if (!center || !overlay) return;
		const now = performance.now();
		const batch: Spark[] = Array.from({ length: sparkCount }, (_, i) => ({
			x: center.cx,
			y: center.cy,
			angle: (2 * Math.PI * i) / sparkCount + Math.random() * 0.15,
			startTime: now,
		}));
		sparks.push(...batch);
		startLoop();
	}

	function draw(timestamp: number): void {
		const canvas = overlay;
		if (!canvas) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		ctx.clearRect(0, 0, canvas.width, canvas.height);
		const color = readSparkColor();

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

			ctx.strokeStyle = color;
			ctx.lineWidth = 2.5;
			ctx.lineCap = 'round';
			ctx.globalAlpha = 1 - progress * 0.85;
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
			ctx.globalAlpha = 1;
			return true;
		});

		if (sparks.length > 0) {
			animId = requestAnimationFrame(draw);
		} else {
			animId = null;
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		}
	}

	function startLoop(): void {
		if (animId !== null) return;
		animId = requestAnimationFrame(draw);
	}

	// 关键路径:用 tick 触发，不依赖 Svelte 5 bind:this.burst
	$effect(() => {
		const t = tick;
		if (t > lastTick) {
			lastTick = t;
			if (enabled) burst();
		}
	});

	onDestroy(() => {
		if (animId !== null) cancelAnimationFrame(animId);
		overlay?.remove();
		overlay = null;
	});
</script>

<div class="ratel-click-spark" bind:this={rootEl}>
	{@render children()}
</div>

<style>
	.ratel-click-spark {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		align-self: flex-end;
		overflow: visible;
		z-index: 2;
	}
</style>
