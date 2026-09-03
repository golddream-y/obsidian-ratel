<!--
	@file src/ui/mascot/ChatMascot.svelte
	@description 聊天窗可拖吉祥物 — Canvas 绘制、视线跟鼠标、脸档弹簧 morph
	@module ui/mascot/ChatMascot
	@depends ./layout, ./eyes, ./paint, ./types, ../../i18n
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t, type StringKey } from '../../i18n';
	import {
		MASCOT_SIZE,
		ratioToOffset,
		offsetToRatio,
		computeGaze,
	} from './layout';
	import { getEyeRings, lerpRings, applyGaze, squashRing } from './eyes';
	import { drawMascotFrame } from './paint';
	import type { MascotFace } from './types';

	const DOUBLE_CLICK_MS = 300;
	const MORPH_SPRING = 0.22;
	const BLINK_MIN_MS = 6000;
	const BLINK_MAX_MS = 14000;
	const BLINK_DURATION_MS = 160;

	const ARIA_KEYS: Record<MascotFace, StringKey> = {
		idle: 'chat.mascot.aria.idle',
		waiting: 'chat.mascot.aria.waiting',
		thinking: 'chat.mascot.aria.thinking',
		working: 'chat.mascot.aria.working',
		speaking: 'chat.mascot.aria.speaking',
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
	let pointerX = $state<number | null>(null);
	let pointerY = $state<number | null>(null);
	let morphFromFace = $state<MascotFace>('idle');
	let morphToFace = $state<MascotFace>('idle');
	let morphT = $state(1);
	let blinkAmount = $state(0);
	let lastDownAt = 0;

	let wrapEl: HTMLElement | null = null;
	let resizeObs: ResizeObserver | null = null;
	let rafId = 0;
	let blinkTimer: ReturnType<typeof setTimeout> | null = null;
	let blinkAnimTimer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let grabOffsetX = 0;
	let grabOffsetY = 0;

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

	/** 从宿主读强调色与眼填色。 */
	function readPaintColors(el: HTMLElement): { accent: string; eyeFill: string } {
		const style = getComputedStyle(el);
		const accent = style.getPropertyValue('--interactive-accent').trim();
		const eyeFill = style.getPropertyValue('--background-primary').trim();
		return {
			accent: accent || '#7c6cff',
			eyeFill: eyeFill || '#ffffff',
		};
	}

	/** 当前帧左右眼环（morph + 视线 + 眨眼）。 */
	function buildRings(gazeFrozen: boolean): { left: ReturnType<typeof getEyeRings>['left']; right: ReturnType<typeof getEyeRings>['right'] } {
		const from = getEyeRings(morphFromFace);
		const to = getEyeRings(morphToFace);
		let left = lerpRings(from.left, to.left, morphT);
		let right = lerpRings(from.right, to.right, morphT);

		if (blinkAmount > 0 && morphToFace === 'idle' && morphT > 0.85) {
			left = squashRing(left, blinkAmount);
			right = squashRing(right, blinkAmount);
		}

		const centerX = posLeft + MASCOT_SIZE / 2;
		const centerY = posTop + MASCOT_SIZE / 2;
		const gaze = computeGaze(pointerX, pointerY, centerX, centerY, gazeFrozen);
		return {
			left: applyGaze(left, gaze.x, gaze.y),
			right: applyGaze(right, gaze.x, gaze.y),
		};
	}

	function paintFrame() {
		const canvas = canvasEl;
		const host = rootEl;
		if (!canvas || !host) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
		canvas.width = Math.round(MASCOT_SIZE * dpr);
		canvas.height = Math.round(MASCOT_SIZE * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, MASCOT_SIZE, MASCOT_SIZE);

		const { accent, eyeFill } = readPaintColors(host);
		const { left, right } = buildRings(dragging || !animate);
		drawMascotFrame(ctx, {
			size: MASCOT_SIZE,
			accent,
			eyeFill,
			leftRing: left,
			rightRing: right,
		});
	}

	function scheduleBlink() {
		if (!animate) return;
		if (blinkTimer) clearTimeout(blinkTimer);
		const delay = BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
		blinkTimer = setTimeout(() => {
			blinkAmount = 1;
			if (blinkAnimTimer) clearTimeout(blinkAnimTimer);
			blinkAnimTimer = setTimeout(() => {
				blinkAmount = 0;
				scheduleBlink();
			}, BLINK_DURATION_MS);
		}, delay);
	}

	function stopBlink() {
		if (blinkTimer) clearTimeout(blinkTimer);
		if (blinkAnimTimer) clearTimeout(blinkAnimTimer);
		blinkTimer = null;
		blinkAnimTimer = null;
		blinkAmount = 0;
	}

	function frameStep() {
		if (morphT < 1) {
			morphT = Math.min(1, morphT + (1 - morphT) * MORPH_SPRING);
		}
		paintFrame();
	}

	function startLoop() {
		if (running) return;
		running = true;
		const loop = () => {
			if (!running) return;
			frameStep();
			rafId = requestAnimationFrame(loop);
		};
		rafId = requestAnimationFrame(loop);
	}

	function stopLoop() {
		running = false;
		cancelAnimationFrame(rafId);
	}

	function onWrapPointerMove(e: PointerEvent) {
		pointerX = e.clientX;
		pointerY = e.clientY;
	}

	function onWrapPointerLeave() {
		pointerX = null;
		pointerY = null;
	}

	function onMascotPointerDown(e: PointerEvent) {
		const now = Date.now();
		if (now - lastDownAt < DOUBLE_CLICK_MS) {
			lastDownAt = 0;
			onRatioReset();
			syncPosition();
			paintFrame();
			return;
		}
		lastDownAt = now;

		dragging = true;
		const host = rootEl as HTMLDivElement;
		host.setPointerCapture(e.pointerId);
		const elRect = host.getBoundingClientRect();
		grabOffsetX = e.clientX - elRect.left;
		grabOffsetY = e.clientY - elRect.top;
		onMascotDragAt(e.clientX, e.clientY);
	}

	function onMascotDragAt(clientX: number, clientY: number) {
		if (!wrapEl) return;
		const rect = wrapEl.getBoundingClientRect();
		posLeft = clientX - rect.left - grabOffsetX;
		posTop = clientY - rect.top - grabOffsetY;
		paintFrame();
	}

	function onMascotPointerMove(e: PointerEvent) {
		if (!dragging) return;
		onMascotDragAt(e.clientX, e.clientY);
	}

	function onMascotPointerUp(e: PointerEvent) {
		if (!dragging || !wrapEl) return;
		dragging = false;
		try {
			(rootEl as HTMLDivElement).releasePointerCapture(e.pointerId);
		} catch {
			// 已释放时忽略
		}
		const w = wrapEl.clientWidth;
		const h = wrapEl.clientHeight;
		const ratio = offsetToRatio(posLeft, posTop, w, h);
		onRatioChange(ratio.x, ratio.y);
		syncPosition();
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
		if (face !== morphToFace) {
			if (!animate) {
				morphFromFace = face;
				morphToFace = face;
				morphT = 1;
				paintFrame();
			} else {
				morphFromFace = morphT >= 0.999 ? morphToFace : morphFromFace;
				morphToFace = face;
				morphT = 0;
			}
		}
	});

	$effect(() => {
		stopLoop();
		stopBlink();
		if (!enabled || !canvasEl) return;

		if (animate) {
			scheduleBlink();
			startLoop();
		} else {
			morphT = 1;
			morphFromFace = face;
			morphToFace = face;
			pointerX = null;
			pointerY = null;
			paintFrame();
		}

		return () => {
			stopLoop();
			stopBlink();
		};
	});

	onDestroy(() => {
		stopLoop();
		stopBlink();
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
			width={MASCOT_SIZE}
			height={MASCOT_SIZE}
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
		border: 1px solid var(--background-modifier-border);
		border-radius: 50%;
		box-sizing: border-box;
	}

	.ratel-mascot:active {
		cursor: grabbing;
	}

	.ratel-mascot-canvas {
		display: block;
		width: 48px;
		height: 48px;
		border-radius: 50%;
	}
</style>
