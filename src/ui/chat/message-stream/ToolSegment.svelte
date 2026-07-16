<!--
	@file src/ui/chat/message-stream/ToolSegment.svelte
	@description 工具段渲染 — Trace 时间线行;折叠态单行 mono,展开态轻量 detail
	@module ui/chat/message-stream/ToolSegment
	@depends ./types, i18n
	设计:左边线 + ✓/✗/脉冲● + displayName + 右侧摘要;无 emoji、无厚卡片阴影
-->
<script lang="ts">
	import type { ToolCallEntry } from './types';
	import { t } from '../../../i18n';

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

	function toggle() {
		userToggled = true;
		expanded = !expanded;
	}

	/**
	 * 折叠行右侧短摘要 — 结果条数 / 截断字符串 / 失败文案;calling 无摘要。
	 */
	function formatSummary(result: unknown): string {
		if (Array.isArray(result)) return $t('chat.tool.found', { count: result.length });
		if (typeof result === 'string') return result.length > 60 ? result.slice(0, 60) + '…' : result;
		if (result && typeof result === 'object') {
			const json = JSON.stringify(result);
			return json.length > 60 ? json.slice(0, 60) + '…' : json;
		}
		return String(result);
	}

	function glyph(): string {
		if (toolCall.status === 'calling') return '●';
		if (toolCall.status === 'failed') return '✗';
		return '✓';
	}

	function statusClass(): string {
		if (toolCall.status === 'calling') return 'calling';
		if (toolCall.status === 'failed') return 'failed';
		return 'done';
	}

	const summary = $derived.by(() => {
		if (toolCall.status === 'failed') {
			return toolCall.errorMessage ?? $t('chat.tool.failed');
		}
		if (toolCall.status === 'done' && toolCall.result != null) {
			return formatSummary(toolCall.result);
		}
		return '';
	});

	function prettyArgs(): string {
		try {
			return JSON.stringify(toolCall.args, null, 2);
		} catch {
			return String(toolCall.args);
		}
	}

	function prettyResult(): string {
		if (toolCall.result == null) return $t('chat.tool.noResult');
		try {
			return JSON.stringify(toolCall.result, null, 2);
		} catch {
			return String(toolCall.result);
		}
	}
</script>

<div
	class="ratel-trace ratel-trace-{statusClass()}"
	class:ratel-trace-expanded={expanded}
>
	<button
		class="ratel-trace-row"
		type="button"
		aria-expanded={expanded}
		onclick={toggle}
	>
		<span class="ratel-trace-glyph" class:ratel-trace-glyph-pulse={toolCall.status === 'calling'}>{glyph()}</span>
		<span class="ratel-trace-name">{toolCall.displayName}</span>
		{#if summary}
			<span class="ratel-trace-summary">{summary}</span>
		{/if}
	</button>
	{#if expanded}
		<div class="ratel-trace-detail">
			{#if toolCall.status === 'calling'}
				<div class="ratel-tool-calling">
					<span class="ratel-tool-dot"></span>
					<span>{$t('chat.tool.executing')}</span>
				</div>
			{/if}
			<div class="ratel-tool-section">
				<div class="ratel-tool-label">{$t('chat.tool.params')}</div>
				<pre class="ratel-tool-pre">{prettyArgs()}</pre>
			</div>
			{#if toolCall.result != null}
				<div class="ratel-tool-section">
					<div class="ratel-tool-label">{$t('chat.tool.result')}</div>
					<pre class="ratel-tool-pre">{prettyResult()}</pre>
				</div>
			{/if}
			{#if toolCall.status === 'failed' && toolCall.errorMessage}
				<div class="ratel-tool-err">{toolCall.errorMessage}</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	/*
	 * Trace 时间线外壳 — 左边线 1px muted(对齐原型 v3),无厚卡片 / box-shadow。
	 * 关键路径:calling 行用脉冲 ●,与正文气泡视觉权重分离。
	 */
	.ratel-trace {
		margin: 2px 0 4px;
		padding-left: 2px;
		margin-left: 4px;
		border-left: 1px solid var(--background-modifier-border);
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
		background: color-mix(in srgb, var(--text-normal) 4%, transparent);
	}

	.ratel-trace-glyph {
		flex-shrink: 0;
		width: 14px;
		text-align: center;
		font-size: 11px;
		font-weight: 600;
		line-height: 1.4;
		font-family: var(--font-monospace);
	}

	.ratel-trace-done .ratel-trace-glyph { color: var(--text-success); }
	.ratel-trace-failed .ratel-trace-glyph { color: var(--text-error); }
	.ratel-trace-calling .ratel-trace-glyph { color: var(--text-warning); }

	.ratel-trace-glyph-pulse {
		animation: ratel-trace-pulse 1.2s infinite;
	}

	@keyframes ratel-trace-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}

	.ratel-trace-name {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		font-family: var(--font-monospace);
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-trace-done .ratel-trace-name { color: color-mix(in srgb, var(--text-success) 70%, var(--text-muted)); }
	.ratel-trace-failed .ratel-trace-name { color: color-mix(in srgb, var(--text-error) 75%, var(--text-muted)); }
	.ratel-trace-calling .ratel-trace-name { color: var(--text-normal); }

	.ratel-trace-summary {
		flex-shrink: 1;
		max-width: 42%;
		font-size: 11px;
		font-family: var(--font-monospace);
		color: var(--text-faint, var(--text-muted));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: right;
	}

	.ratel-trace-failed .ratel-trace-summary {
		color: var(--text-error);
	}

	/* 展开态轻量 detail — 无大阴影,边框轻 */
	.ratel-trace-detail {
		margin: 2px 0 6px 16px;
		padding: 8px 10px;
		border-radius: 6px;
		border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
		background: color-mix(in srgb, var(--background-secondary) 55%, transparent);
	}

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
		animation: ratel-trace-pulse 1.2s infinite;
		flex-shrink: 0;
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
		.ratel-trace-glyph-pulse,
		.ratel-tool-dot {
			animation: none;
		}
		.ratel-trace-row {
			transition: none;
		}
	}
</style>
