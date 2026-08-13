<!--
	@file src/ui/motion/empty/OrbBackdrop.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Backgrounds/Orb/Orb.tsx
	@description 空会话 Orb 能量球：原生 WebGL2，无 ogl；灰底透出，球在中央
	@module ui/motion/empty/OrbBackdrop
	@depends ./orb-shaders, ./aurora-fallback
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { hexToRgb01, probeWebGL2Support, shouldUseAuroraFallback } from './aurora-fallback';
	import { ORB_FRAG, ORB_VERT } from './orb-shaders';

	interface Props {
		enabled?: boolean;
		hue?: number;
		hoverIntensity?: number;
		color1?: string;
		color2?: string;
		color3?: string;
		backgroundColor?: string;
	}

	let {
		enabled = true,
		hue = 0,
		hoverIntensity = 0.18,
		color1 = '#e8c49a',
		color2 = '#c9956c',
		color3 = '#3a322c',
		// 关键路径:保持近黑，extractAlpha 才把球外变成透明，Obsidian 灰底才能透出来
		backgroundColor = '#000000',
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
			throw new Error(`Orb shader 编译失败: ${log}`);
		}
		return shader;
	}

	function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
		const vs = compileShader(gl, gl.VERTEX_SHADER, ORB_VERT);
		const fs = compileShader(gl, gl.FRAGMENT_SHADER, ORB_FRAG);
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
			throw new Error(`Orb program 链接失败: ${log}`);
		}
		return program;
	}

	function mountWebGL(host: HTMLDivElement): (() => void) | null {
		const canvas = document.createElement('canvas');
		canvas.className = 'ratel-orb-canvas';
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
			console.error('[OrbBackdrop] WebGL 初始化失败', err);
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
			time: gl.getUniformLocation(program, 'iTime'),
			resolution: gl.getUniformLocation(program, 'iResolution'),
			hue: gl.getUniformLocation(program, 'hue'),
			hover: gl.getUniformLocation(program, 'hover'),
			rot: gl.getUniformLocation(program, 'rot'),
			hoverIntensity: gl.getUniformLocation(program, 'hoverIntensity'),
			backgroundColor: gl.getUniformLocation(program, 'backgroundColor'),
			color1: gl.getUniformLocation(program, 'uColor1'),
			color2: gl.getUniformLocation(program, 'uColor2'),
			color3: gl.getUniformLocation(program, 'uColor3'),
		};

		let width = 0;
		let height = 0;
		let hover = 0;
		let rot = 0;
		let lastTime = 0;
		let running = false;

		const resize = () => {
			const w = host.offsetWidth;
			const h = host.offsetHeight;
			if (w <= 0 || h <= 0) return;
			const dpr = Math.min(2, window.devicePixelRatio || 1);
			width = Math.floor(w * dpr);
			height = Math.floor(h * dpr);
			canvas.width = width;
			canvas.height = height;
			canvas.style.width = `${w}px`;
			canvas.style.height = `${h}px`;
			gl.viewport(0, 0, width, height);
			// 关键路径:改 canvas 尺寸后旧帧会被浏览器拉伸；立刻重画，球保持正圆
			if (running) draw(performance.now());
		};

		const draw = (timeMs: number) => {
			const dt = lastTime === 0 ? 0 : (timeMs - lastTime) * 0.001;
			lastTime = timeMs;
			hover += (1 - hover) * 0.08;
			rot += dt * 0.3;

			gl.useProgram(program);
			gl.bindVertexArray(vao);
			gl.uniform1f(uniforms.time, timeMs * 0.001);
			gl.uniform3f(uniforms.resolution, width, height, width / Math.max(height, 1));
			gl.uniform1f(uniforms.hue, hue);
			gl.uniform1f(uniforms.hover, hover);
			gl.uniform1f(uniforms.rot, rot);
			gl.uniform1f(uniforms.hoverIntensity, hoverIntensity);
			gl.uniform3fv(uniforms.backgroundColor, hexToRgb01(backgroundColor));
			gl.uniform3fv(uniforms.color1, hexToRgb01(color1));
			gl.uniform3fv(uniforms.color2, hexToRgb01(color2));
			gl.uniform3fv(uniforms.color3, hexToRgb01(color3));
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
			lastTime = 0;
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
			console.error('[OrbBackdrop] 挂载失败，降级 CSS', err);
			useFallback = true;
			teardown = null;
		}

		if (!teardown) useFallback = true;
	}

	$effect(() => {
		void enabled;
		void hue;
		void hoverIntensity;
		void color1;
		void color2;
		void color3;
		void backgroundColor;
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
	class="ratel-orb"
	class:ratel-orb-fallback={probed && useFallback}
	class:ratel-orb-disabled={!enabled}
	bind:this={hostEl}
	aria-hidden="true"
	style:--orb-c1={color1}
></div>

<style>
	.ratel-orb {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
	}

	:global(.ratel-orb-canvas) {
		display: block;
		width: 100%;
		height: 100%;
		background: transparent;
	}

	.ratel-orb-fallback {
		background: radial-gradient(
			circle at 50% 46%,
			color-mix(in srgb, var(--orb-c1) 38%, transparent) 0%,
			transparent 52%
		);
	}

	.ratel-orb-disabled {
		opacity: 0.45;
	}
</style>
