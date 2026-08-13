<!--
	@file src/ui/motion/empty/LineWavesBackdrop.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Backgrounds/LineWaves/LineWaves.tsx
	@description 空会话 Line Waves 线波背景：原生 WebGL2，无 ogl；不可用时斜线 CSS 降级
	@module ui/motion/empty/LineWavesBackdrop
	@depends ./line-waves-shaders, ./aurora-fallback
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { hexToRgb01, probeWebGL2Support, shouldUseAuroraFallback } from './aurora-fallback';
	import { LINE_WAVES_FRAG, LINE_WAVES_VERT } from './line-waves-shaders';

	interface Props {
		enabled?: boolean;
		speed?: number;
		innerLineCount?: number;
		outerLineCount?: number;
		warpIntensity?: number;
		rotation?: number;
		edgeFadeWidth?: number;
		colorCycleSpeed?: number;
		brightness?: number;
		color1?: string;
		color2?: string;
		color3?: string;
		enableMouseInteraction?: boolean;
		mouseInfluence?: number;
	}

	let {
		enabled = true,
		speed = 0.3,
		innerLineCount = 32,
		outerLineCount = 36,
		warpIntensity = 1,
		rotation = -45,
		edgeFadeWidth = 0,
		colorCycleSpeed = 0.22,
		brightness = 0.32,
		color1 = '#e8c49a',
		color2 = '#f3eadc',
		color3 = '#cbb89a',
		enableMouseInteraction = false,
		mouseInfluence = 2,
	}: Props = $props();

	let hostEl = $state<HTMLDivElement | undefined>();
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
			throw new Error(`LineWaves shader 编译失败: ${log}`);
		}
		return shader;
	}

	function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
		const vs = compileShader(gl, gl.VERTEX_SHADER, LINE_WAVES_VERT);
		const fs = compileShader(gl, gl.FRAGMENT_SHADER, LINE_WAVES_FRAG);
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
			throw new Error(`LineWaves program 链接失败: ${log}`);
		}
		return program;
	}

	function mountWebGL(host: HTMLDivElement): (() => void) | null {
		const canvas = document.createElement('canvas');
		canvas.className = 'ratel-line-waves-canvas';
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
			console.error('[LineWavesBackdrop] WebGL 初始化失败', err);
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
			innerLines: gl.getUniformLocation(program, 'uInnerLines'),
			outerLines: gl.getUniformLocation(program, 'uOuterLines'),
			warpIntensity: gl.getUniformLocation(program, 'uWarpIntensity'),
			rotation: gl.getUniformLocation(program, 'uRotation'),
			edgeFadeWidth: gl.getUniformLocation(program, 'uEdgeFadeWidth'),
			colorCycleSpeed: gl.getUniformLocation(program, 'uColorCycleSpeed'),
			brightness: gl.getUniformLocation(program, 'uBrightness'),
			color1: gl.getUniformLocation(program, 'uColor1'),
			color2: gl.getUniformLocation(program, 'uColor2'),
			color3: gl.getUniformLocation(program, 'uColor3'),
			mouse: gl.getUniformLocation(program, 'uMouse'),
			mouseInfluence: gl.getUniformLocation(program, 'uMouseInfluence'),
			enableMouse: gl.getUniformLocation(program, 'uEnableMouse'),
		};

		let width = 0;
		let height = 0;
		let currentMouse: [number, number] = [0.5, 0.5];
		let targetMouse: [number, number] = [0.5, 0.5];
		const rotationRad = (rotation * Math.PI) / 180;

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
			gl.uniform1f(uniforms.innerLines, innerLineCount);
			gl.uniform1f(uniforms.outerLines, outerLineCount);
			gl.uniform1f(uniforms.warpIntensity, warpIntensity);
			gl.uniform1f(uniforms.rotation, rotationRad);
			gl.uniform1f(uniforms.edgeFadeWidth, edgeFadeWidth);
			gl.uniform1f(uniforms.colorCycleSpeed, colorCycleSpeed);
			gl.uniform1f(uniforms.brightness, brightness);
			gl.uniform3fv(uniforms.color1, hexToRgb01(color1));
			gl.uniform3fv(uniforms.color2, hexToRgb01(color2));
			gl.uniform3fv(uniforms.color3, hexToRgb01(color3));
			gl.uniform2f(uniforms.mouse, currentMouse[0], currentMouse[1]);
			gl.uniform1f(uniforms.mouseInfluence, mouseInfluence);
			gl.uniform1i(uniforms.enableMouse, enableMouseInteraction ? 1 : 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
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
			console.error('[LineWavesBackdrop] 挂载失败，降级 CSS', err);
			useFallback = true;
			teardown = null;
		}

		if (!teardown) useFallback = true;
	}

	$effect(() => {
		void enabled;
		void speed;
		void innerLineCount;
		void outerLineCount;
		void warpIntensity;
		void rotation;
		void edgeFadeWidth;
		void colorCycleSpeed;
		void brightness;
		void color1;
		void color2;
		void color3;
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
	class="ratel-line-waves"
	class:ratel-line-waves-fallback={probed && useFallback}
	class:ratel-line-waves-disabled={!enabled}
	bind:this={hostEl}
	aria-hidden="true"
	style:--line-waves-c1={color1}
	style:--line-waves-c2={color2}
></div>

<style>
	.ratel-line-waves {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
	}

	:global(.ratel-line-waves-canvas) {
		display: block;
		width: 100%;
		height: 100%;
		background: transparent;
	}

	.ratel-line-waves-fallback {
		background:
			repeating-linear-gradient(
				-45deg,
				transparent 0 10px,
				color-mix(in srgb, var(--line-waves-c1) 18%, transparent) 10px 11px
			),
			repeating-linear-gradient(
				-42deg,
				transparent 0 16px,
				color-mix(in srgb, var(--line-waves-c2) 10%, transparent) 16px 17px
			);
		opacity: 0.7;
	}

	.ratel-line-waves-disabled {
		opacity: 0.4;
	}
</style>
