<!--
	@file src/ui/chat/message-stream/ToolSegment.svelte
	@description 工具段渲染 — 可折叠,折叠态显示 displayName + 结果摘要,展开态显示 args/result
	@module ui/chat/message-stream/ToolSegment
	@depends ../components/Collapsible.svelte, ./types
	设计:状态色 accent(success/warning/error)+ calling pulse + 等宽参数/结果
-->
<script lang="ts">
	import Collapsible from '../../components/Collapsible.svelte';
	import type { ToolCallEntry } from './types';

	let { toolCall }: { toolCall: ToolCallEntry } = $props();

	// 关键路径:calling 状态默认展开(让用户看到正在执行),done/failed 默认折叠
	let expanded = $state(toolCall.status === 'calling');

	// 关键路径:status 从 calling→done/failed 时自动折叠(用户可手动展开)
	let userToggled = $state(false);
	$effect(() => {
		if (toolCall.status !== 'calling' && !userToggled) {
			expanded = false;
		}
	});

	function handleToggle(next: boolean) {
		userToggled = true;
		expanded = next;
	}

	function formatResult(result: unknown): string {
		if (Array.isArray(result)) return `找到 ${result.length} 项`;
		if (typeof result === 'string') return result.length > 60 ? result.slice(0, 60) + '…' : result;
		if (result && typeof result === 'object') {
			const json = JSON.stringify(result);
			return json.length > 60 ? json.slice(0, 60) + '…' : json;
		}
		return String(result);
	}

	function icon(): string {
		// 关键路径:calling 状态返回占位符,Collapsible 的 CSS ::after 渲染 pulsing dot
		if (toolCall.status === 'calling') return '\u00A0';
		if (toolCall.status === 'failed') return '✗';
		return '✓';
	}

	function iconClass(): string {
		if (toolCall.status === 'calling') return 'calling';
		if (toolCall.status === 'failed') return 'failed';
		return 'done';
	}

	function titleClass(): string {
		if (toolCall.status === 'failed') return 'failed';
		if (toolCall.status === 'done') return 'done';
		return '';
	}

	function title(): string {
		const summary = toolCall.status === 'failed'
			? toolCall.errorMessage ?? '失败'
			: toolCall.status === 'done' && toolCall.result != null
				? `— ${formatResult(toolCall.result)}`
				: '';
		return `${toolCall.displayName} ${summary}`.trim();
	}

	function prettyArgs(): string {
		try {
			return JSON.stringify(toolCall.args, null, 2);
		} catch {
			return String(toolCall.args);
		}
	}

	function prettyResult(): string {
		if (toolCall.result == null) return '(无结果)';
		try {
			return JSON.stringify(toolCall.result, null, 2);
		} catch {
			return String(toolCall.result);
		}
	}
</script>

<Collapsible
	title={title()}
	icon={icon()}
	iconClass={iconClass()}
	titleClass={titleClass()}
	variant="tool"
	bind:expanded
	onToggle={handleToggle}
>
	{#if toolCall.status === 'calling'}
		<div class="ratel-tool-calling">
			<span class="ratel-tool-dot"></span>
			<span>执行中…</span>
		</div>
	{/if}
	<div class="ratel-tool-section">
		<div class="ratel-tool-label">参数</div>
		<pre class="ratel-tool-pre">{prettyArgs()}</pre>
	</div>
	{#if toolCall.result != null}
		<div class="ratel-tool-section">
			<div class="ratel-tool-label">结果</div>
			<pre class="ratel-tool-pre">{prettyResult()}</pre>
		</div>
	{/if}
	{#if toolCall.status === 'failed' && toolCall.errorMessage}
		<div class="ratel-tool-err">{toolCall.errorMessage}</div>
	{/if}
</Collapsible>

<style>
	/*
	 * 关键路径:calling 状态显示 pulse 动画点,与 ThinkSegment 的光标区分。
	 * 参数/结果用等宽字体 + muted 色,标签用大写小字号增强视觉层次。
	 */
	.ratel-tool-calling {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--text-warning);
		font-size: 11px;
		margin-bottom: 8px;
		font-family: var(--font-monospace);
	}

	.ratel-tool-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-warning);
		animation: ratel-tool-pulse 1.2s infinite;
		flex-shrink: 0;
		box-shadow: 0 0 0 0 color-mix(in srgb, var(--text-warning) 50%, transparent);
	}

	@keyframes ratel-tool-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.ratel-tool-section {
		margin-bottom: 8px;
	}

	.ratel-tool-section:last-child {
		margin-bottom: 0;
	}

	.ratel-tool-label {
		font-size: 10px;
		color: var(--text-faint, var(--text-muted));
		text-transform: uppercase;
		letter-spacing: 0.6px;
		margin-bottom: 4px;
		font-weight: 600;
	}

	.ratel-tool-pre {
		margin: 0;
		font-family: var(--font-monospace);
		font-size: 11px;
		color: var(--text-muted);
		white-space: pre-wrap;
		word-break: break-all;
		line-height: 1.5;
		padding: 6px 8px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--background-primary) 40%, transparent);
		border: 1px solid color-mix(in srgb, var(--background-modifier-border) 50%, transparent);
	}

	.ratel-tool-err {
		margin-top: 6px;
		padding: 5px 8px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--text-error) 10%, transparent);
		color: var(--text-error);
		font-size: 11px;
		border-left: 2px solid var(--text-error);
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-tool-dot { animation: none; }
	}
</style>
