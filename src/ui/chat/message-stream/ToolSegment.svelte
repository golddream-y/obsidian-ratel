<!--
	@file src/ui/chat/message-stream/ToolSegment.svelte
	@description 工具 Trace 行 — 折叠短 meta;展开结构化自然语言旁注(i18n)
	@module ui/chat/message-stream/ToolSegment
	@depends ./types, ../format-tool-detail, i18n
	设计:无独立左边线(由父级 .ratel-trace 提供脊柱);旁注非裸 JSON
-->
<script lang="ts">
	import type { ToolCallEntry } from './types';
	import { normalizeToolDetail } from '../normalize-tool-detail';
	import { metaShortFromModel, renderToolDetail } from '../render-tool-detail';
	import { isMcpToolName } from '../../mcp/parse-mcp-tool-name';
	import { t } from '../../../i18n';

	let { toolCall }: { toolCall: ToolCallEntry } = $props();

	// 安全路径:calling 只高亮行,默认不展开 dump;done/failed 默认折叠
	let expanded = $state(false);

	function toggle() {
		expanded = !expanded;
	}

	function statusClass(): string {
		if (toolCall.status === 'calling') return 'calling';
		if (toolCall.status === 'failed') return 'failed';
		return 'done';
	}

	function glyph(): string {
		if (toolCall.status === 'calling') return '●';
		if (toolCall.status === 'failed') return '✗';
		return '✓';
	}

	// 安全路径:一次 normalize,meta/detail 同源,避免双次形状探测漂移
	const model = $derived(
		normalizeToolDetail({
			name: toolCall.name,
			args: toolCall.args,
			result: toolCall.result,
			errorMessage: toolCall.status === 'failed' ? toolCall.errorMessage : undefined,
			status: toolCall.status,
		}),
	);
	const meta = $derived(metaShortFromModel(model));
	const detail = $derived(renderToolDetail(model));
</script>

<div class="ratel-trace-item ratel-trace-{statusClass()}">
	<button
		class="ratel-trace-row"
		type="button"
		aria-expanded={expanded}
		onclick={toggle}
	>
		<span class="ratel-trace-ico" class:ratel-trace-ico-pulse={toolCall.status === 'calling'}>{glyph()}</span>
		{#if isMcpToolName(toolCall.name)}
			<span class="ratel-trace-mcp-badge">{$t('chat.tool.mcpBadge')}</span>
		{/if}
		<span class="ratel-trace-label">{toolCall.displayName}</span>
		{#if meta}
			<span class="ratel-trace-meta">{meta}</span>
		{/if}
	</button>
	{#if expanded}
		<pre class="ratel-trace-detail">{detail}</pre>
	{/if}
</div>

<style>
	/*
	 * 修复:不用 display:contents — Electron/Obsidian 下会破坏 scoped 状态色与展开布局。
	 * 左边线仍由父级 .ratel-trace 提供。
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
		line-height: 1.4;
		font-family: var(--font-monospace);
		color: var(--text-faint, var(--text-muted));
	}

	.ratel-trace-done .ratel-trace-ico {
		color: var(--text-success);
	}

	.ratel-trace-failed .ratel-trace-ico {
		color: var(--text-error);
	}

	.ratel-trace-calling .ratel-trace-ico {
		color: var(--text-warning);
	}

	.ratel-trace-ico-pulse {
		animation: ratel-trace-pulse 1.4s ease-in-out infinite;
	}

	.ratel-trace-mcp-badge {
		flex-shrink: 0;
		font-size: 9px;
		line-height: 1;
		letter-spacing: 0.04em;
		padding: 2px 5px;
		border-radius: 3px;
		border: 1px solid var(--background-modifier-border);
		color: var(--text-muted);
		background: color-mix(in srgb, var(--background-secondary) 80%, transparent);
	}

	@keyframes ratel-trace-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}

	.ratel-trace-label {
		flex: 1;
		min-width: 0;
		font-family: var(--font-monospace);
		font-size: 11px;
		color: var(--text-faint, var(--text-muted));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* 安全路径:done 行 label 保持 muted,不把 success 绿渗进整行 */
	.ratel-trace-done .ratel-trace-label {
		color: var(--text-muted);
	}

	.ratel-trace-calling .ratel-trace-label {
		color: var(--text-warning);
	}

	.ratel-trace-failed .ratel-trace-label {
		color: var(--text-muted);
	}

	.ratel-trace-meta {
		flex-shrink: 0;
		font-family: var(--font-monospace);
		font-size: 10px;
		color: var(--text-faint, var(--text-muted));
	}

	.ratel-trace-failed .ratel-trace-meta {
		color: var(--text-error);
	}

	/* 轻量旁注 — 可滚动看全量,不被父级裁切 */
	.ratel-trace-detail {
		margin: 0 10px 6px 26px;
		padding: 8px 10px;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: color-mix(in srgb, var(--background-secondary) 75%, transparent);
		font-family: var(--font-monospace);
		font-size: 10.5px;
		line-height: 1.5;
		color: var(--text-faint, var(--text-muted));
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
		overflow-y: auto;
		max-height: min(40vh, 320px);
		/* 重置 pre 默认边距,避免被当成「截断卡片」 */
		box-sizing: border-box;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-trace-ico-pulse { animation: none; }
		.ratel-trace-row { transition: none; }
	}
</style>
