<!--
	@file src/ui/motion/chrome/CountUp.svelte
	@origin https://github.com/DavidHDev/react-bits (CountUp 参数级)
	@description StatusLine 上下文占用 % — rAF ease-out 计数
	@module ui/motion/chrome/CountUp
	@depends ./count-up
-->
<script lang="ts">
	import { easeOutCount, lerpCount } from './count-up';

	interface Props {
		value: number;
		enabled: boolean;
		durationMs?: number;
	}

	let { value, enabled, durationMs = 360 }: Props = $props();

	let display = $state(value);

	$effect(() => {
		const target = value;

		if (!enabled) {
			display = target;
			return;
		}

		const from = display;
		const to = target;
		if (from === to) return;

		// 关键路径: 上限 400ms，避免上下文 % 跳动拖尾
		const duration = Math.min(durationMs, 400);
		const startTime = performance.now();
		let rafId: number | null = null;

		const tick = (now: number): void => {
			const elapsed = now - startTime;
			const t = Math.min(elapsed / duration, 1);
			display = lerpCount(from, to, easeOutCount(t));
			if (t < 1) {
				rafId = requestAnimationFrame(tick);
			}
		};

		rafId = requestAnimationFrame(tick);

		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	});
</script>

{Math.round(display)}
