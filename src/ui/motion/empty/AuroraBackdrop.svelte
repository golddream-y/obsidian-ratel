<!--
	@file src/ui/motion/empty/AuroraBackdrop.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Backgrounds/Aurora/Aurora.tsx
	@description 空会话 Aurora 背景：原生 WebGL2，无 ogl；无 WebGL 或闸门关闭时 CSS 呼吸降级
	@module ui/motion/empty/AuroraBackdrop
	@depends ./aurora-shaders, ./aurora-fallback
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { hexToRgb01, probeWebGL2Support, shouldUseAuroraFallback } from './aurora-fallback';
	import { AURORA_FRAG, AURORA_VERT } from './aurora-shaders';

	interface Props {
		enabled?: boolean;
		colorStops?: [string, string, string];
		amplitude?: number;
		blend?: number;
		speed?: number;
	}

	let {
		enabled = true,
		colorStops = ['#5b4a3a', '#c4a574', '#5b4a3a'],
		amplitude = 0.85,
		blend = 0.55,
		speed = 0.7,
	}: Props = $props();

	let hostEl = $state<HTMLDivElement | undefined>();
	/** 探测完成前不挂 fallback class，避免 WebGL 路径首帧 CSS 闪烁 */
	let probed = $state(false);
	let useFallback = $state(false);

	let teardown: (() => void) | null = null;

	function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
		const shader = gl.createShader(type);
		if (!shader) throw new Error('WebGL: createShader 失败');
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(shader) ?? '未知错误';
			gl.deleteShader(shader);
			throw new Error(`Aurora shader 编译失败: ${log}`);
		}
		return shader;
	}

	function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
		const vs = compileShader(gl, gl.VERTEX_SHADER, AURORA_VERT);
		const fs = compileShader(gl, gl.FRAGMENT_SHADER, AURORA_FRAG);
		const program = gl.createProgram();
		if (!program) throw new Error('WebGL: createProgram 失败');
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			const log = gl.getProgramInfoLog(program) ?? '未知错误';
			gl.deleteProgram(program);
			throw new Error(`Aurora program 链接失败: ${log}`);
		}
		return program;
	}

	function colorStopsToFlatRgb(stops: [string, string, string]): Float32Array {
		const [a, b, c] = stops.map(hexToRgb01);
		return new Float32Array([...a, ...b, ...c]);
	}

	function mountWebGL(host: HTMLDivElement): (() => void) | null {
		const canvas = document.createElement('canvas');
		canvas.className = 'ratel-aurora-canvas';
		canvas.setAttribute('aria-hidden', 'true');
		host.appendChild(canvas);

		const gl = canvas.getContext('webgl2', {
			alpha: true,
			premultipliedAlpha: true,
			antialias: true,
		});
		if (!gl) {
			host.removeChild(canvas);
			return null;
		}

		gl.clearColor(0, 0, 0, 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		let program: WebGLProgram;
		try {
			program = createProgram(gl);
		} catch (err) {
			console.error('[AuroraBackdrop] WebGL 初始化失败', err);
			host.removeChild(canvas);
			return null;
		}

		const uTime = gl.getUniformLocation(program, 'uTime');
		const uAmplitude = gl.getUniformLocation(program, 'uAmplitude');
		const uColorStops = gl.getUniformLocation(program, 'uColorStops[0]');
		const uResolution = gl.getUniformLocation(program, 'uResolution');
		const uBlend = gl.getUniformLocation(program, 'uBlend');
		const posLoc = gl.getAttribLocation(program, 'position');

		const vertices = new Float32Array([-1, -1, 3, -1, -1, 3]);
		const vbo = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

		const vao = gl.createVertexArray();
		gl.bindVertexArray(vao);
		gl.enableVertexAttribArray(posLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);

		let width = 0;
		let height = 0;

		const resize = () => {
			const w = host.offsetWidth;
			const h = host.offsetHeight;
			if (w <= 0 || h <= 0) return;
			width = w;
			height = h;
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
		};

		const draw = (tMs: number) => {
			gl.useProgram(program);
			gl.bindVertexArray(vao);
			gl.uniform1f(uTime, tMs * 0.01 * speed * 0.1);
			gl.uniform1f(uAmplitude, amplitude);
			gl.uniform1f(uBlend, blend);
			gl.uniform2f(uResolution, width, height);
			gl.uniform3fv(uColorStops, colorStopsToFlatRgb(colorStops));
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		};

		resize();
		const ro =
			typeof ResizeObserver !== 'undefined'
				? new ResizeObserver(() => {
						resize();
					})
				: null;
		ro?.observe(host);

		let raf = 0;
		let running = false;

		const stop = () => {
			running = false;
			cancelAnimationFrame(raf);
		};

		const loop = (t: number) => {
			if (!running) return;
			draw(t);
			raf = requestAnimationFrame(loop);
		};

		const start = () => {
			if (running) return;
			running = true;
			raf = requestAnimationFrame(loop);
		};

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
		else if (visible && document.visibilityState !== 'hidden') start();

		return () => {
			stop();
			ro?.disconnect();
			io?.disconnect();
			document.removeEventListener('visibilitychange', onVis);
			gl.bindVertexArray(null);
			gl.useProgram(null);
			gl.deleteBuffer(vbo);
			gl.deleteVertexArray(vao);
			gl.deleteProgram(program);
			gl.getExtension('WEBGL_lose_context')?.loseContext();
			if (canvas.parentNode === host) host.removeChild(canvas);
		};
	}

	function startBackdrop() {
		teardown?.();
		teardown = null;
		probed = false;
		useFallback = false;

		const host = hostEl;
		if (!host) return;

		const webgl2 = probeWebGL2Support();
		useFallback = shouldUseAuroraFallback(enabled, webgl2);
		probed = true;
		if (useFallback) return;

		try {
			teardown = mountWebGL(host) ?? null;
		} catch (err) {
			console.error('[AuroraBackdrop] 挂载失败，降级 CSS', err);
			useFallback = true;
			teardown = null;
		}

		if (!teardown) useFallback = true;
	}

	$effect(() => {
		void enabled;
		void colorStops;
		void amplitude;
		void blend;
		void speed;
		void hostEl;
		startBackdrop();
		return () => {
			teardown?.();
			teardown = null;
		};
	});

	onDestroy(() => {
		teardown?.();
		teardown = null;
	});
</script>

<div
	class="ratel-aurora"
	class:ratel-aurora-fallback={probed && useFallback}
	bind:this={hostEl}
	aria-hidden="true"
	style:--aurora-c0={colorStops[0]}
	style:--aurora-c1={colorStops[1]}
	style:--aurora-c2={colorStops[2]}
></div>

<style>
	.ratel-aurora {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
		z-index: 0;
	}

	:global(.ratel-aurora-canvas) {
		display: block;
		width: 100%;
		height: 100%;
		background: transparent;
	}

	.ratel-aurora-fallback {
		background:
			radial-gradient(
				ellipse 120% 80% at 50% 100%,
				color-mix(in srgb, var(--aurora-c1) 28%, transparent),
				transparent 70%
			),
			linear-gradient(
				165deg,
				color-mix(in srgb, var(--aurora-c0) 12%, transparent),
				color-mix(in srgb, var(--aurora-c1) 18%, transparent) 45%,
				color-mix(in srgb, var(--aurora-c2) 10%, transparent)
			);
		animation: ratel-aurora-breathe 10s ease-in-out infinite;
	}

	@keyframes ratel-aurora-breathe {
		0%,
		100% {
			opacity: 0.45;
			transform: scale(1);
		}
		50% {
			opacity: 0.72;
			transform: scale(1.02);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-aurora-fallback {
			animation: none;
			opacity: 0.55;
		}
	}
</style>
