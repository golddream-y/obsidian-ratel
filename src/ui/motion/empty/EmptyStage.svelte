<!--
	@file src/ui/motion/empty/EmptyStage.svelte
	@description 空会话欢迎台 — SoftAurora 背景 + 玻璃托盘 + Gradient 主句 + Rotate 副句
	@module ui/motion/empty/EmptyStage
	@depends ./SoftAuroraBackdrop, ./NoiseTray, ./GradientWelcome, ./RotateHint, ./empty-hints, i18n
-->
<script lang="ts">
	import { t } from '../../../i18n';
	import { resolveEmptyHints } from './empty-hints';
	import GradientWelcome from './GradientWelcome.svelte';
	import NoiseTray from './NoiseTray.svelte';
	import RotateHint from './RotateHint.svelte';
	import SoftAuroraBackdrop from './SoftAuroraBackdrop.svelte';

	interface Props {
		motionOn: boolean;
	}

	let { motionOn }: Props = $props();

	const welcome = $derived($t('chat.empty.welcome'));
	const hints = $derived(resolveEmptyHints((k) => $t(k as any)));
</script>

<div class="ratel-empty-stage" data-motion={motionOn ? 'on' : 'off'}>
	{#if motionOn}
		<SoftAuroraBackdrop />
	{/if}
	<div class="ratel-empty-stage-content has-glass">
		<NoiseTray />
		<div class="ratel-empty-stage-text">
			<GradientWelcome text={welcome} play={motionOn} />
			<RotateHint {hints} play={motionOn} />
		</div>
	</div>
</div>

<style>
	.ratel-empty-stage {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		z-index: 0;
	}

	.ratel-empty-stage-content {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		padding: 24px 16px;
		max-width: 100%;
	}

	.has-glass {
		background: color-mix(in srgb, var(--background-primary) 72%, transparent);
		backdrop-filter: blur(12px);
		border-radius: 12px;
		border: 1px solid color-mix(in srgb, var(--text-muted) 12%, transparent);
	}

	.ratel-empty-stage-text {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}
</style>
