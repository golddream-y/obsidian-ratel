<!--
	@file src/ui/mascot/ChatMascot.svelte
	@description 聊天窗可拖捣蛋鬼 — blob 身体、弹簧视线与眨眼
	@module ui/mascot/ChatMascot
	@depends ./layout, ./paint, ./sim, ./gesture, ./types, ../../i18n
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t, type StringKey } from '../../i18n';
	import {
		MASCOT_SIZE,
		MASCOT_CANVAS_PAD,
		MASCOT_CANVAS_VIEW,
		ratioToOffset,
		offsetToRatio,
		computeGaze,
		snapMascotToSides,
	} from './layout';
	import { drawMascotFrame } from './paint';
	import { MascotSim } from './sim';
	import { isMascotTap } from './gesture';
	import type { MascotFace } from './types';

	const DOUBLE_CLICK_MS = 300;
	const BUSY_TAP: ReadonlySet<MascotFace> = new Set(['waiting', 'thinking', 'working', 'speaking']);

	const ARIA_KEYS: Record<MascotFace, StringKey> = {
		idle: 'chat.mascot.aria.idle',
		waiting: 'chat.mascot.aria.waiting',
		thinking: 'chat.mascot.aria.thinking',
		working: 'chat.mascot.aria.working',
		speaking: 'chat.mascot.aria.speaking',
		listening: 'chat.mascot.aria.listening',
		error: 'chat.mascot.aria.error',
		stopped: 'chat.mascot.aria.stopped',
	};

	let {
		enabled = true,
		animate = true,
		face = 'idle' as MascotFace,
		ratioX = 1,
		ratioY = 1,
		onRatioChange,
		onRatioReset,
	}: {
		enabled: boolean;
		animate: boolean;
		face: MascotFace;
		ratioX: number;
		ratioY: number;
		onRatioChange: (x: number, y: number) => void;
		onRatioReset: () => void;
	} = $props();

	let rootEl = $state<HTMLDivElement | null>(null);
	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let posLeft = $state(0);
	let posTop = $state(0);
	let dragging = $state(false);
	let holding = $state(false);
	let pointerX = $state<number | null>(null);
	let pointerY = $state<number | null>(null);
	let lastDownAt = 0;
	let downX = 0;
	let downY = 0;
	let didDrag = false;

	let wrapEl: HTMLElement | null = null;
	let resizeObs: ResizeObserver | null = null;
	let rafId = 0;
	let running = false;
	let grabOffsetX = 0;
	let grabOffsetY = 0;
	let lastFrameAt = 0;
	const sim = new MascotSim();

	const ariaLabel = $derived($t(ARIA_KEYS[face]));

	/** 根据 wrap 尺寸与比例更新 left/top。 */
	function syncPosition() {
		if (!wrapEl) return;
		const w = wrapEl.clientWidth;
		const h = wrapEl.clientHeight;
		const { left, top } = ratioToOffset(ratioX, ratioY, w, h);
		posLeft = left;
		posTop = top;
	}

	/** 身体用强调色；眼睛用主题底，保持浅色块。 */
	function readPaintColors(el: HTMLElement): { accent: string; eyeFill: string } {
		const style = getComputedStyle(el);
		const accent = style.getPropertyValue('--interactive-accent').trim();
		const eyeFill = style.getPropertyValue('--background-primary').trim();
		return {
			accent: accent || '#7c6cff',
			eyeFill: eyeFill || '#f4f0ea',
		};
	}

	function paintFrame() {
		const canvas = canvasEl;
		const host = rootEl;
		if (!canvas || !host) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
		const dt = lastFrameAt ? Math.min(0.05, (now - lastFrameAt) / 1000) : 1 / 60;
		lastFrameAt = now;

		const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
		canvas.width = Math.round(MASCOT_CANVAS_VIEW * dpr);
		canvas.height = Math.round(MASCOT_CANVAS_VIEW * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, MASCOT_CANVAS_VIEW, MASCOT_CANVAS_VIEW);
		ctx.save();
		ctx.translate(MASCOT_CANVAS_PAD, MASCOT_CANVAS_PAD);

		const centerX = posLeft + MASCOT_SIZE / 2;
		const centerY = posTop + MASCOT_SIZE / 2;
		const pointerGaze = computeGaze(pointerX, pointerY, centerX, centerY, dragging || !animate);
		const frame = sim.tick({
			face,
			animate,
			pointerGaze,
			dt,
			now,
			pressing: holding,
		});
		const colors = readPaintColors(host);
		drawMascotFrame(ctx, {
			size: MASCOT_SIZE,
			accent: colors.accent,
			eyeFill: colors.eyeFill,
			leftRing: frame.left,
			rightRing: frame.right,
			body: frame.body,
		});
		ctx.restore();
	}

	function startLoop() {
		if (running) return;
		running = true;
		lastFrameAt = 0;
		const loop = () => {
			if (!running) return;
			paintFrame();
			rafId = requestAnimationFrame(loop);
		};
		rafId = requestAnimationFrame(loop);
	}

	function stopLoop() {
		running = false;
		cancelAnimationFrame(rafId);
	}

	/** 视口坐标 → 消息 wrap 局部坐标。视线必须与 posLeft/posTop 同一空间。 */
	function wrapLocalPoint(clientX: number, clientY: number): { x: number; y: number } | null {
		if (!wrapEl) return null;
		const rect = wrapEl.getBoundingClientRect();
		return { x: clientX - rect.left, y: clientY - rect.top };
	}

	function onWrapPointerMove(e: PointerEvent) {
		const p = wrapLocalPoint(e.clientX, e.clientY);
		if (!p) return;
		pointerX = p.x;
		pointerY = p.y;
	}

	function onWrapPointerLeave() {
		pointerX = null;
		pointerY = null;
	}

	function onMascotPointerDown(e: PointerEvent) {
		const now = Date.now();
		if (now - lastDownAt < DOUBLE_CLICK_MS) {
			lastDownAt = 0;
			// 关键路径:双击复位后必须清 dragging,否则随后的 pointerup 会把旧拖位再写回 settings
			dragging = false;
			holding = false;
			didDrag = false;
			onRatioReset();
			syncPosition();
			paintFrame();
			return;
		}
		lastDownAt = now;
		holding = true;
		didDrag = false;
		downX = e.clientX;
		downY = e.clientY;
		dragging = false;

		const host = rootEl as HTMLDivElement;
		host.setPointerCapture(e.pointerId);
		const elRect = host.getBoundingClientRect();
		grabOffsetX = e.clientX - elRect.left;
		grabOffsetY = e.clientY - elRect.top;
	}

	function onMascotDragAt(clientX: number, clientY: number) {
		if (!wrapEl) return;
		const rect = wrapEl.getBoundingClientRect();
		posLeft = clientX - rect.left - grabOffsetX;
		posTop = clientY - rect.top - grabOffsetY;
		const snapped = snapMascotToSides(posLeft, posTop, wrapEl.clientWidth);
		posLeft = snapped.left;
		posTop = snapped.top;
		paintFrame();
	}

	function onMascotPointerMove(e: PointerEvent) {
		if (!holding) return;
		if (!didDrag && isMascotTap(e.clientX - downX, e.clientY - downY)) return;
		didDrag = true;
		dragging = true;
		onMascotDragAt(e.clientX, e.clientY);
	}

	function onMascotPointerUp(e: PointerEvent) {
		if (!holding) return;
		holding = false;
		dragging = false;
		try {
			(rootEl as HTMLDivElement).releasePointerCapture(e.pointerId);
		} catch {
			// 已释放时忽略
		}
		const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
		if (didDrag && wrapEl) {
			const w = wrapEl.clientWidth;
			const h = wrapEl.clientHeight;
			const ratio = offsetToRatio(posLeft, posTop, w, h);
			onRatioChange(ratio.x, ratio.y);
			syncPosition();
		} else if (!didDrag && animate) {
			sim.pulseTap(BUSY_TAP.has(face) ? 0.5 : 1, now);
		}
		didDrag = false;
		paintFrame();
	}

	function bindWrap(wrap: HTMLElement) {
		wrapEl = wrap;
		syncPosition();
		resizeObs = new ResizeObserver(() => syncPosition());
		resizeObs.observe(wrap);
		wrap.addEventListener('pointermove', onWrapPointerMove);
		wrap.addEventListener('pointerleave', onWrapPointerLeave);
	}

	function unbindWrap() {
		if (wrapEl) {
			wrapEl.removeEventListener('pointermove', onWrapPointerMove);
			wrapEl.removeEventListener('pointerleave', onWrapPointerLeave);
		}
		resizeObs?.disconnect();
		resizeObs = null;
		wrapEl = null;
	}

	$effect(() => {
		if (!enabled) return;
		const el = rootEl;
		if (!el?.parentElement) return;
		unbindWrap();
		bindWrap(el.parentElement);
		return () => unbindWrap();
	});

	$effect(() => {
		void ratioX;
		void ratioY;
		syncPosition();
	});

	$effect(() => {
		stopLoop();
		if (!enabled || !canvasEl) return;

		if (animate) {
			startLoop();
		} else {
			pointerX = null;
			pointerY = null;
			paintFrame();
		}

		return () => {
			stopLoop();
		};
	});

	onDestroy(() => {
		stopLoop();
		unbindWrap();
	});
</script>

{#if enabled}
	<div
		class="ratel-mascot"
		bind:this={rootEl}
		role="img"
		aria-label={ariaLabel}
		style:left="{posLeft}px"
		style:top="{posTop}px"
		onpointerdown={onMascotPointerDown}
		onpointermove={onMascotPointerMove}
		onpointerup={onMascotPointerUp}
		onpointercancel={onMascotPointerUp}
	>
		<canvas
			bind:this={canvasEl}
			class="ratel-mascot-canvas"
			width={MASCOT_CANVAS_VIEW}
			height={MASCOT_CANVAS_VIEW}
			style:left="{-MASCOT_CANVAS_PAD}px"
			style:top="{-MASCOT_CANVAS_PAD}px"
			style:width="{MASCOT_CANVAS_VIEW}px"
			style:height="{MASCOT_CANVAS_VIEW}px"
			aria-hidden="true"
		></canvas>
	</div>
{/if}

<style>
	.ratel-mascot {
		position: absolute;
		z-index: 6;
		width: 48px;
		height: 48px;
		touch-action: none;
		user-select: none;
		cursor: grab;
		overflow: visible;
		border: none;
		background: transparent;
		border-radius: 0;
		box-sizing: border-box;
	}

	.ratel-mascot:active {
		cursor: grabbing;
	}

	.ratel-mascot-canvas {
		position: absolute;
		display: block;
		pointer-events: none;
	}
</style>
