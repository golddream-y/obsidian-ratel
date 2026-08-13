<!--
	@file src/ui/motion/empty/EmptyStage.svelte
	@description 空会话欢迎台 — 词标落在柔光上 + 玻璃托盘欢迎句（无顶栏条）
	@module ui/motion/empty/EmptyStage
	@depends ./NoiseTray, ./GradientWelcome, ./RotateHint, ../title/ParticleText, ./empty-hints, i18n
-->
<script lang="ts">
	import { t } from '../../../i18n';
	import ParticleText from '../title/ParticleText.svelte';
	import { resolveEmptyHints } from './empty-hints';
	import GradientWelcome from './GradientWelcome.svelte';
	import NoiseTray from './NoiseTray.svelte';
	import RotateHint from './RotateHint.svelte';

	interface Props {
		motionOn: boolean;
	}

	let { motionOn }: Props = $props();

	const welcome = $derived($t('chat.empty.welcome'));
	const hints = $derived(resolveEmptyHints($t));
</script>

<div class="ratel-empty-stage" data-motion={motionOn ? 'on' : 'off'}>
	<div class="ratel-empty-brand">
		<ParticleText
			text={`${$t('chat.header.title')}.`}
			playToken={1}
			{motionOn}
			particleSize={0.7}
			density={1}
			scatter={140}
			gatherDuration={1800}
			stagger={340}
		/>
		<span class="ratel-empty-tagline">{$t('chat.header.tagline')}</span>
	</div>
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
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 18px;
		padding: 56px 12px 24px;
		pointer-events: none;
		z-index: 1;
		overflow: visible;
	}

	.ratel-empty-brand {
		position: relative;
		z-index: 2;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: center;
		gap: 14px;
		max-width: 100%;
		overflow: visible;
	}

	.ratel-empty-brand :global(.ratel-particle) {
		font-size: 28px;
		font-weight: 700;
		letter-spacing: -0.03em;
		color: var(--text-normal);
		line-height: 1;
		/* 句点是字号里偏大的圆点，给 tagline 留出空隙，避免和 graph-native 贴在一起 */
		padding-right: 0.18em;
	}

	.ratel-empty-tagline {
		font-size: 12px;
		font-weight: 450;
		line-height: 1;
		color: var(--text-faint, var(--text-muted));
	}

	.ratel-empty-stage-content {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		box-sizing: border-box;
		width: min(22rem, 100%);
		min-width: 0;
		padding: 20px clamp(14px, 5%, 32px) 18px;
		overflow: hidden;
	}

	/*
	 * 关键路径:填色必须低，backdrop 才能糊到后面的 Orb。
	 * 72% 同色灰底会把玻璃抹平；铜边 + 顶沿高光 + saturate 才像一块托盘。
	 */
	.has-glass {
		background:
			linear-gradient(
				165deg,
				color-mix(in srgb, #f3eadc 18%, transparent) 0%,
				transparent 42%
			),
			color-mix(in srgb, var(--background-primary) 34%, transparent);
		backdrop-filter: blur(28px) saturate(1.45);
		-webkit-backdrop-filter: blur(28px) saturate(1.45);
		border-radius: 14px;
		border: 1px solid color-mix(in srgb, #e8c49a 32%, var(--background-modifier-border));
		box-shadow:
			inset 0 1px 0 color-mix(in srgb, #ffffff 22%, transparent),
			inset 0 -1px 0 color-mix(in srgb, #000000 14%, transparent),
			inset 0 0 28px color-mix(in srgb, #e8c49a 10%, transparent),
			0 12px 40px color-mix(in srgb, #000000 28%, transparent);
	}

	.has-glass::before {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		pointer-events: none;
		background: linear-gradient(
			180deg,
			color-mix(in srgb, #ffffff 16%, transparent),
			transparent 40%
		);
		z-index: 0;
	}

	.ratel-empty-stage-text {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
	}
</style>
