<!--
	@file src/ui/motion/title/ParticleText.svelte
	@origin https://reactbits.dev/text-animations/particle-text
	@description 会话标题粒子聚拢 — 离屏采样字形，canvas 画点，结束后在同画布写字（不切 CSS 层）
	@module ui/motion/title/ParticleText
	@depends ./particle-math
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		gatherProgress,
		glyphSampleLayout,
		hash01,
		lerp,
		measureCssAlphabeticBaseline,
		particleCanvasOffset,
		particleStart,
	} from './particle-math';

	interface Props {
		text: string;
		playToken: number;
		motionOn: boolean;
		particleSize?: number;
		density?: number;
		scatter?: number;
		gatherDuration?: number;
		stagger?: number;
		color?: string;
		highlightColor?: string;
	}

	let {
		text,
		playToken,
		motionOn,
		particleSize = 0.7,
		density = 1,
		scatter = 120,
		gatherDuration = 1800,
		stagger = 360,
		color = '',
		highlightColor = '',
	}: Props = $props();

	type Particle = {
		tx: number;
		ty: number;
		sx: number;
		sy: number;
		delay: number;
		hi: boolean;
	};

	let lastPlayedToken = $state(-1);
	let playing = $state(false);
	let settled = $state(false);
	let hostEl = $state<HTMLSpanElement | undefined>();
	let canvasEl = $state<HTMLCanvasElement | undefined>();
	let probeEl = $state<HTMLSpanElement | undefined>();
	let raf = 0;

	function applyLetterSpacing(ctx: CanvasRenderingContext2D, letterSpacing: string) {
		// 关键路径:CSS letter-spacing 不进 font 简写，不设的话粒子字宽会和明文错开
		if ('letterSpacing' in ctx) ctx.letterSpacing = letterSpacing;
	}

	function sampleGlyphs(
		label: string,
		font: string,
		letterSpacing: string,
		step: number,
	): {
		pts: { x: number; y: number }[];
		w: number;
		h: number;
		originX: number;
		originY: number;
	} {
		const empty = { pts: [], w: 1, h: 1, originX: 0, originY: 1 };
		const probe = document.createElement('canvas');
		const ctx = probe.getContext('2d');
		if (!ctx) return empty;
		ctx.font = font;
		applyLetterSpacing(ctx, letterSpacing);
		ctx.textBaseline = 'alphabetic';
		const metrics = ctx.measureText(label);
		const layout = glyphSampleLayout({
			width: metrics.width,
			actualBoundingBoxLeft: metrics.actualBoundingBoxLeft,
			actualBoundingBoxRight: metrics.actualBoundingBoxRight,
			actualBoundingBoxAscent: metrics.actualBoundingBoxAscent,
			actualBoundingBoxDescent: metrics.actualBoundingBoxDescent,
		});
		probe.width = layout.width;
		probe.height = layout.height;
		ctx.font = font;
		applyLetterSpacing(ctx, letterSpacing);
		ctx.fillStyle = '#fff';
		ctx.textBaseline = 'alphabetic';
		ctx.fillText(label, layout.originX, layout.originY);
		const data = ctx.getImageData(0, 0, layout.width, layout.height).data;
		const pts: { x: number; y: number }[] = [];
		for (let y = 0; y < layout.height; y += step) {
			for (let x = 0; x < layout.width; x += step) {
				if ((data[(y * layout.width + x) * 4 + 3] ?? 0) > 120) pts.push({ x, y });
			}
		}
		return {
			pts,
			w: layout.width,
			h: layout.height,
			originX: layout.originX,
			originY: layout.originY,
		};
	}

	function cssColor(el: HTMLElement, fallback: string): string {
		if (color) return color;
		const c = getComputedStyle(el).color;
		return c || fallback;
	}

	function waitTwoFrames(): Promise<void> {
		return new Promise((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
	}

	$effect(() => {
		const token = playToken;
		const label = text;
		const host = hostEl;
		const canvas = canvasEl;
		const on = motionOn;

		if (!on || token <= 0 || !host || !canvas) return;
		if (token === lastPlayedToken) return;
		lastPlayedToken = token;

		// 关键路径:不要 return cancel rAF；lastPlayedToken 写入会重跑 effect，cleanup 会掐死动画
		void (async () => {
			try {
				await document.fonts?.ready;
			} catch {
				/* 字体就绪失败则用当前回退体采样 */
			}
			await waitTwoFrames();
			if (hostEl !== host || canvasEl !== canvas) return;

			const labelEl = host.querySelector('.ratel-particle-label') as HTMLElement | null;
			const style = getComputedStyle(labelEl ?? host);
			const font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const letterSpacing = style.letterSpacing && style.letterSpacing !== 'normal' ? style.letterSpacing : '0px';
			const sampled = sampleGlyphs(label, font, letterSpacing, Math.max(1, density));
			if (sampled.pts.length === 0) {
				playing = false;
				settled = false;
				return;
			}

			playing = true;
			settled = false;

			const cx = sampled.w / 2;
			const cy = sampled.h * 0.55;
			const particles: Particle[] = sampled.pts.map((p, i) => {
				const start = particleStart(i, p.x, p.y, scatter, cx, cy, 0.7);
				return {
					tx: p.x,
					ty: p.y,
					sx: start.x,
					sy: start.y,
					delay: hash01(i * 3.31) * stagger,
					hi: i % 7 === 0,
				};
			});

			const dpr = Math.min(2, window.devicePixelRatio || 1);
			const pad = scatter;
			const w = sampled.w + pad * 2;
			const h = sampled.h + pad * 2;
			const hostRect = host.getBoundingClientRect();
			const labelRect = (labelEl ?? host).getBoundingClientRect();
			const cssBaseline =
				labelEl && probeEl ? measureCssAlphabeticBaseline(labelEl, probeEl) : sampled.originY;
			const overlay = particleCanvasOffset(
				pad,
				labelRect.left - hostRect.left,
				labelRect.top - hostRect.top,
				cssBaseline,
				sampled.originX,
				sampled.originY,
			);
			canvas.width = Math.floor(w * dpr);
			canvas.height = Math.floor(h * dpr);
			canvas.style.width = `${w}px`;
			canvas.style.height = `${h}px`;
			canvas.style.left = `${overlay.left}px`;
			canvas.style.top = `${overlay.top}px`;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				playing = false;
				return;
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

			const fill = cssColor(host, '#ddd');
			const started = performance.now();
			const total = gatherDuration + stagger;
			cancelAnimationFrame(raf);

			const paintSettledText = () => {
				ctx.clearRect(0, 0, w, h);
				ctx.font = font;
				applyLetterSpacing(ctx, letterSpacing);
				ctx.fillStyle = fill;
				ctx.textBaseline = 'alphabetic';
				ctx.fillText(label, sampled.originX + pad, sampled.originY + pad);
			};

			const tick = (now: number) => {
				const elapsed = now - started;
				ctx.clearRect(0, 0, w, h);
				for (const p of particles) {
					const t = gatherProgress(elapsed, p.delay, gatherDuration);
					const x = lerp(p.sx, p.tx, t) + pad;
					const y = lerp(p.sy, p.ty, t) + pad;
					ctx.beginPath();
					ctx.fillStyle = p.hi && highlightColor ? highlightColor : fill;
					ctx.arc(x, y, particleSize, 0, Math.PI * 2);
					ctx.fill();
				}
				if (elapsed < total) {
					raf = requestAnimationFrame(tick);
				} else {
					playing = false;
					settled = true;
					paintSettledText();
				}
			};
			raf = requestAnimationFrame(tick);
		})();
	});

	onDestroy(() => cancelAnimationFrame(raf));

	const hideLabel = $derived(playing || settled);
	const showCanvas = $derived(playing || settled);
</script>

<span class="ratel-particle" bind:this={hostEl}>
	<span class="ratel-particle-label" class:is-hidden={hideLabel}
		>{text}<span class="ratel-particle-baseline-probe" bind:this={probeEl} aria-hidden="true"></span></span>
	{#if motionOn}
		<canvas class="ratel-particle-canvas" class:is-on={showCanvas} bind:this={canvasEl} aria-hidden="true"></canvas>
	{/if}
</span>

<style>
	.ratel-particle {
		position: relative;
		display: inline-block;
		line-height: 1;
		vertical-align: baseline;
	}

	.ratel-particle-label {
		display: inline-block;
		line-height: 1;
		white-space: nowrap;
	}

	.ratel-particle-baseline-probe {
		display: inline-block;
		width: 0;
		height: 0;
		overflow: hidden;
		vertical-align: baseline;
	}

	.ratel-particle-label.is-hidden {
		opacity: 0;
	}

	.ratel-particle-canvas {
		position: absolute;
		left: 0;
		top: 0;
		pointer-events: none;
		opacity: 0;
	}

	.ratel-particle-canvas.is-on {
		opacity: 1;
	}
</style>
