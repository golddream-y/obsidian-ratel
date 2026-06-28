<!--
	@file src/ui/chat/message-stream/ThinkSegment.svelte
	@description think 段渲染 — 可折叠思考过程,流式中默认展开,结束后折叠
	@module ui/chat/message-stream/ThinkSegment
	@depends ../components/Collapsible.svelte
	设计:warning 色 accent + 流式光标 + 等宽字体 + 结束后自动折叠
-->
<script lang="ts">
	import Collapsible from '../../components/Collapsible.svelte';

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
	});

	function handleToggle(next: boolean) {
		userToggled = true;
		expanded = next;
	}
</script>

<div class="ratel-think-wrap" class:ratel-think-streaming={streaming}>
	<Collapsible
		title={streaming ? '思考过程…' : '思考过程'}
		icon="💭"
		iconClass="think"
		variant="think"
		bind:expanded
		onToggle={handleToggle}
	>
		<div class="ratel-think-content" class:ratel-think-streaming-text={streaming}>
			{text}{#if streaming}<span class="ratel-think-cursor">▋</span>{/if}
		</div>
	</Collapsible>
</div>

<style>
	.ratel-think-wrap {
		width: 100%;
	}

	/*
	 * 关键路径:think 内容用等宽字体 + muted 色,与正文文本视觉区分。
	 * 流式时光标闪烁,增强"正在思考"的反馈。
	 */
	.ratel-think-content {
		font-size: 12px;
		color: var(--text-muted);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: var(--font-monospace);
		line-height: 1.6;
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
	}
</style>
