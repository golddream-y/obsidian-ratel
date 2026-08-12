<!--
	@file src/ui/motion/empty/EmptyStage.svelte
	@description 空会话欢迎台 — SoftAurora 背景 + Blur 主句 + Type 副句
	@module ui/motion/empty/EmptyStage
	@depends ./SoftAuroraBackdrop, ./WelcomeBlurText, ./WelcomeTypeLine, i18n
-->
<script lang="ts">
	import { t } from '../../../i18n';
	import SoftAuroraBackdrop from './SoftAuroraBackdrop.svelte';
	import WelcomeBlurText from './WelcomeBlurText.svelte';
	import WelcomeTypeLine from './WelcomeTypeLine.svelte';

	interface Props {
		motionOn: boolean;
	}

	let { motionOn }: Props = $props();

	const welcome = $derived($t('chat.empty.welcome'));
	const hint = $derived($t('chat.empty.hint'));
</script>

<div class="ratel-empty-stage" data-motion={motionOn ? 'on' : 'off'}>
	{#if motionOn}
		<SoftAuroraBackdrop />
	{/if}
	<div class="ratel-empty-stage-content">
		<WelcomeBlurText text={welcome} play={motionOn} />
		<WelcomeTypeLine text={hint} play={motionOn} />
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
</style>
