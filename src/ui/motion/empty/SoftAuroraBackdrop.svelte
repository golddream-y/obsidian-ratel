<!--
	@file src/ui/motion/empty/SoftAuroraBackdrop.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Backgrounds/SoftAurora/SoftAurora.tsx
	@description 空会话 SoftAurora 柔光背景：原生 WebGL2，无 ogl；不可用时双径向 CSS 呼吸降级
	@module ui/motion/empty/SoftAuroraBackdrop
	@depends ./soft-aurora-shaders, ./aurora-fallback
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { hexToRgb01, probeWebGL2Support, shouldUseAuroraFallback } from './aurora-fallback';
	import { SOFT_AURORA_FRAG, SOFT_AURORA_VERT } from './soft-aurora-shaders';

	interface Props {
		enabled?: boolean;
		speed?: number;
		scale?: number;
		brightness?: number;
		color1?: string;
		color2?: string;
		noiseFrequency?: number;
		noiseAmplitude?: number;
		bandHeight?: number;
		bandSpread?: number;
		octaveDecay?: number;
		layerOffset?: number;
		colorSpeed?: number;
		enableMouseInteraction?: boolean;
		mouseInfluence?: number;
	}

	let {
		enabled = true,
		speed = 0.6,
		scale = 1.5,
		brightness = 1.15,
		color1 = '#e8c49a',
		color2 = '#3d5a56',
		noiseFrequency = 2.5,
		noiseAmplitude = 1,
		bandHeight = 0.52,
		bandSpread = 1,
		octaveDecay = 0.1,
		layerOffset = 0,
		colorSpeed = 1,
		enableMouseInteraction = false,
		mouseInfluence = 0.25,
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
			throw new Error(`SoftAurora shader 编译失败: ${log}`);
		}
		return shader;
	}

	function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
		const vs = compileShader(gl, gl.VERTEX_SHADER, SOFT_AURORA_VERT);
		const fs = compileShader(gl, gl.FRAGMENT_SHADER, SOFT_AURORA_FRAG);
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
			throw new Error(`SoftAurora program 链接失败: ${log}`);
		}
		return program;
	}

	function mountWebGL(host: HTMLDivElement): (() => void) | null {
		const canvas = document.createElement('canvas');
		canvas.className = 'ratel-soft-aurora-canvas';
		canvas.setAttribute('aria-hidden', 'true');
		host.appendChild(canvas);

		const gl = canvas.getContext('webgl2', {
			alpha: true,
			premultipliedAlpha: false,
			antialias: true,
		});
		if (!gl) {
			host.removeChild(canvas);
			return null;
		}

		gl.clearColor(0, 0, 0, 0);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

		let program: WebGLProgram;
		try {
			program = createProgram(gl);
		} catch (err) {
			console.error('[SoftAuroraBackdrop] WebGL 初始化失败', err);
			host.removeChild(canvas);
			return null;
		}

		const posLoc = gl.getAttribLocation(program, 'position');
		const vertices = new Float32Array([-1, -1, 3, -1, -1, 3]);
		const vbo = gl.createBuffer();
		const vao = gl.createVertexArray();
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
		gl.bindVertexArray(vao);
		gl.enableVertexAttribArray(posLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
		gl.bindVertexArray(null);

		const uniforms = {
			time: gl.getUniformLocation(program, 'uTime'),
			resolution: gl.getUniformLocation(program, 'uResolution'),
			speed: gl.getUniformLocation(program, 'uSpeed'),
			scale: gl.getUniformLocation(program, 'uScale'),
			brightness: gl.getUniformLocation(program, 'uBrightness'),
			color1: gl.getUniformLocation(program, 'uColor1'),
			color2: gl.getUniformLocation(program, 'uColor2'),
			noiseFrequency: gl.getUniformLocation(program, 'uNoiseFreq'),
			noiseAmplitude: gl.getUniformLocation(program, 'uNoiseAmp'),
			bandHeight: gl.getUniformLocation(program, 'uBandHeight'),
			bandSpread: gl.getUniformLocation(program, 'uBandSpread'),
			octaveDecay: gl.getUniformLocation(program, 'uOctaveDecay'),
			layerOffset: gl.getUniformLocation(program, 'uLayerOffset'),
			colorSpeed: gl.getUniformLocation(program, 'uColorSpeed'),
			mouse: gl.getUniformLocation(program, 'uMouse'),
			mouseInfluence: gl.getUniformLocation(program, 'uMouseInfluence'),
			enableMouse: gl.getUniformLocation(program, 'uEnableMouse'),
		};

		let width = 0;
		let height = 0;
		let currentMouse: [number, number] = [0.5, 0.5];
		let targetMouse: [number, number] = [0.5, 0.5];

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

		const onMouseMove = (event: MouseEvent) => {
			const rect = canvas.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return;
			targetMouse = [
				(event.clientX - rect.left) / rect.width,
				1 - (event.clientY - rect.top) / rect.height,
			];
		};

		const onMouseLeave = () => {
			targetMouse = [0.5, 0.5];
		};

		if (enableMouseInteraction) {
			canvas.addEventListener('mousemove', onMouseMove);
			canvas.addEventListener('mouseleave', onMouseLeave);
		}

		const draw = (timeMs: number) => {
			currentMouse = [
				currentMouse[0] + 0.05 * (targetMouse[0] - currentMouse[0]),
				currentMouse[1] + 0.05 * (targetMouse[1] - currentMouse[1]),
			];

			gl.useProgram(program);
			gl.bindVertexArray(vao);
			gl.uniform1f(uniforms.time, timeMs * 0.001);
			gl.uniform3f(uniforms.resolution, width, height, width / Math.max(height, 1));
			gl.uniform1f(uniforms.speed, speed);
			gl.uniform1f(uniforms.scale, scale);
			gl.uniform1f(uniforms.brightness, brightness);
			gl.uniform3fv(uniforms.color1, hexToRgb01(color1));
			gl.uniform3fv(uniforms.color2, hexToRgb01(color2));
			gl.uniform1f(uniforms.noiseFrequency, noiseFrequency);
			gl.uniform1f(uniforms.noiseAmplitude, noiseAmplitude);
			gl.uniform1f(uniforms.bandHeight, bandHeight);
			gl.uniform1f(uniforms.bandSpread, bandSpread);
			gl.uniform1f(uniforms.octaveDecay, octaveDecay);
			gl.uniform1f(uniforms.layerOffset, layerOffset);
			gl.uniform1f(uniforms.colorSpeed, colorSpeed);
			gl.uniform2f(uniforms.mouse, currentMouse[0], currentMouse[1]);
			gl.uniform1f(uniforms.mouseInfluence, mouseInfluence);
			gl.uniform1i(uniforms.enableMouse, enableMouseInteraction ? 1 : 0);
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
		const loop = (time: number) => {
			if (!running) return;
			draw(time);
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

		const onVisibilityChange = () => {
			if (document.visibilityState === 'hidden') stop();
			else if (visible) start();
		};
		document.addEventListener('visibilitychange', onVisibilityChange);

		if (!io || (visible && document.visibilityState !== 'hidden')) start();

		return () => {
			stop();
			ro?.disconnect();
			io?.disconnect();
			document.removeEventListener('visibilitychange', onVisibilityChange);
			if (enableMouseInteraction) {
				canvas.removeEventListener('mousemove', onMouseMove);
				canvas.removeEventListener('mouseleave', onMouseLeave);
			}
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

		// 关键路径: enabled=false 不探测 WebGL2，直接 CSS 降级（不创建 GL 上下文）
		if (!enabled) {
			useFallback = true;
			probed = true;
			return;
		}

		const webgl2 = probeWebGL2Support();
		useFallback = shouldUseAuroraFallback(enabled, webgl2);
		probed = true;
		if (useFallback) return;

		try {
			teardown = mountWebGL(host);
		} catch (err) {
			console.error('[SoftAuroraBackdrop] 挂载失败，降级 CSS', err);
			useFallback = true;
			teardown = null;
		}

		if (!teardown) useFallback = true;
	}

	$effect(() => {
		void enabled;
		void speed;
		void scale;
		void brightness;
		void color1;
		void color2;
		void noiseFrequency;
		void noiseAmplitude;
		void bandHeight;
		void bandSpread;
		void octaveDecay;
		void layerOffset;
		void colorSpeed;
		void enableMouseInteraction;
		void mouseInfluence;
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
	class="ratel-soft-aurora"
	class:ratel-soft-aurora-fallback={probed && useFallback}
	class:ratel-soft-aurora-disabled={!enabled}
	bind:this={hostEl}
	aria-hidden="true"
	style:--soft-aurora-c1={color1}
	style:--soft-aurora-c2={color2}
></div>

<style>
	.ratel-soft-aurora {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
	}

	:global(.ratel-soft-aurora-canvas) {
		display: block;
		width: 100%;
		height: 100%;
		background: transparent;
	}

	.ratel-soft-aurora-fallback {
		background:
			radial-gradient(
				ellipse 92% 72% at 28% 76%,
				color-mix(in srgb, var(--soft-aurora-c1) 30%, transparent),
				transparent 72%
			),
			radial-gradient(
				ellipse 88% 68% at 76% 32%,
				color-mix(in srgb, var(--soft-aurora-c2) 24%, transparent),
				transparent 74%
			);
		animation: ratel-soft-aurora-breathe 10s ease-in-out infinite;
	}

	.ratel-soft-aurora-disabled {
		animation: none;
		opacity: 0.55;
	}

	@keyframes ratel-soft-aurora-breathe {
		0%,
		100% {
			opacity: 0.46;
			transform: scale(1);
		}
		50% {
			opacity: 0.72;
			transform: scale(1.025);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-soft-aurora-fallback {
			animation: none;
			opacity: 0.55;
		}
	}
</style>
