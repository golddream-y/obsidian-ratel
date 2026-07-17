<!--
	@file src/ui/chat/message-stream/ThinkSegment.svelte
	@description think 段渲染 — Trace 时间线行;流式默认展开,结束后自动折叠
	@module ui/chat/message-stream/ThinkSegment
	@depends i18n
	设计:无独立左边线(由 TraceGroup 提供脊柱);◇ 字形 + muted 色;无厚卡片
-->
<script lang="ts">
	import { t } from '../../../i18n';

	/**
	 * think 段 props。
	 *
	 * @param text - 思考过程文本(DeepSeek reasoning_content)
	 * @param streaming - 流式中为 true,默认展开;流式结束后外部改为 false,触发自动折叠
	 */
	let {
		text,
		streaming = false,
	}: {
		text: string;
		streaming?: boolean;
	} = $props();

	// 关键路径:流式中默认展开,结束后折叠(用户手动切换后不再自动折叠)
	let expanded = $state(streaming);
	let userToggled = $state(false);

	// 关键路径:streaming 从 true→false 时自动折叠(若用户未手动操作过)
	$effect(() => {
		if (!streaming && !userToggled) {
			expanded = false;
		}
		if (streaming && !userToggled) {
			expanded = true;
		}
	});

	function toggle() {
		userToggled = true;
		expanded = !expanded;
	}
</script>

<div
	class="ratel-trace-item ratel-trace-think"
	class:ratel-trace-open={expanded}
	class:ratel-trace-streaming={streaming}
>
	<button
		class="ratel-trace-row"
		type="button"
		aria-expanded={expanded}
		onclick={toggle}
	>
		<span class="ratel-trace-ico">◇</span>
		<span class="ratel-trace-label">
			{streaming ? $t('chat.thinking') : $t('chat.thinking.done')}
		</span>
	</button>
	{#if expanded}
		<div class="ratel-trace-detail">
			<span class="ratel-think-body" class:ratel-think-streaming-text={streaming}
				>{text}{#if streaming}<span class="ratel-think-cursor">▋</span>{/if}</span
			>
		</div>
	{/if}
</div>

<style>
	/*
	 * 修复:不用 display:contents — 与 ToolSegment 一致,避免展开区被布局裁切。
	 * 左边线由父级 .ratel-trace 提供。
	 */
	.ratel-trace-item {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.ratel-trace-row {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 5px 10px 5px 12px;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
		user-select: none;
		text-align: left;
		border-radius: 0 6px 6px 0;
		transition: background 0.12s ease, color 0.12s ease;
	}

	.ratel-trace-row:hover {
		background: color-mix(in srgb, var(--text-normal) 3%, transparent);
	}

	.ratel-trace-ico {
		flex-shrink: 0;
		width: 14px;
		text-align: center;
		font-size: 11px;
		font-weight: 600;
		line-height: 1.4;
		color: var(--text-faint, var(--text-muted));
		font-family: var(--font-monospace);
	}

	.ratel-trace-label {
		flex: 1;
		min-width: 0;
		font-size: 11px;
		font-weight: 500;
		font-family: var(--font-monospace);
		color: var(--text-faint, var(--text-muted));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-trace-streaming .ratel-trace-label {
		color: var(--text-muted);
	}

	.ratel-trace-detail {
		margin: 0 10px 6px 26px;
		padding: 8px 10px;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: color-mix(in srgb, var(--background-secondary) 70%, transparent);
		font-family: var(--font-monospace);
		font-size: 10.5px;
		line-height: 1.5;
		color: var(--text-faint, var(--text-muted));
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
		overflow-y: auto;
		max-height: min(40vh, 320px);
		box-sizing: border-box;
	}

	.ratel-think-body {
		display: inline;
	}

	.ratel-think-streaming-text {
		color: var(--text-normal);
	}

	.ratel-think-cursor {
		color: var(--text-warning);
		font-weight: 600;
		margin-left: 1px;
		animation: ratel-think-blink 1s steps(2, start) infinite;
	}

	@keyframes ratel-think-blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-think-cursor { animation: none; opacity: 0.6; }
		.ratel-trace-row { transition: none; }
	}
</style>
