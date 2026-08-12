<!--
	@file src/ui/motion/empty/NoiseTray.svelte
	@origin https://github.com/DavidHDev/react-bits/blob/main/src/ts-default/Backgrounds/Noise/Noise.tsx
	@description 空态玻璃托盘 — 静态 SVG fractalNoise 纹理叠层（无每帧重绘）
	@module ui/motion/empty/NoiseTray
	@depends ./noise-opacity
-->
<script lang="ts">
	import { NOISE_OPACITY_MAX } from './noise-opacity';
</script>

<div class="ratel-noise-tray" aria-hidden="true" style:opacity={NOISE_OPACITY_MAX}>
	<svg width="100%" height="100%" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
		<filter id="ratel-noise-filter">
			<feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="4" stitchTiles="stitch" />
		</filter>
		<rect width="100%" height="100%" filter="url(#ratel-noise-filter)" />
	</svg>
</div>

<style>
	.ratel-noise-tray {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 0;
		overflow: hidden;
		border-radius: inherit;
	}

	.ratel-noise-tray svg {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
