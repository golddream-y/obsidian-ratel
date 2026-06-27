<!--
	@file src/ui/chat/message-stream/SearchResults.svelte
	@description 搜索结果引用列表 — search.result 事件触发渲染
	@module ui/chat/message-stream/SearchResults
	设计:毛玻璃卡片 + 精排徽章 + 等宽路径 + 分数色阶
-->
<script lang="ts">
	/**
	 * 搜索结果列表 props。
	 *
	 * @param results - 扁平化后的搜索结果项(docId / score / path / index)
	 * @param reranked - 是否经过 Rerank 精排(影响徽章显示)
	 */
	let {
		results,
		reranked = false,
	}: {
		results: Array<{ docId: string; score: number; path: string; index: number }>;
		reranked?: boolean;
	} = $props();

	// 关键路径:分数 ≥0.8 高亮,≥0.6 中等,其余弱化。给用户视觉锚点判断相关性。
	function scoreClass(score: number): string {
		if (score >= 0.8) return 'ratel-search-score-high';
		if (score >= 0.6) return 'ratel-search-score-mid';
		return 'ratel-search-score-low';
	}
</script>

{#if results.length > 0}
	<div class="ratel-search">
		<div class="ratel-search-hdr">
			<span class="ratel-search-icon">🔍</span>
			<span class="ratel-search-title">搜索结果</span>
			<span class="ratel-search-count">{results.length}</span>
			{#if reranked}
				<span class="ratel-search-badge">✨ 精排</span>
			{/if}
		</div>
		<div class="ratel-search-list">
			{#each results as r}
				<div class="ratel-search-row">
					<span class="ratel-search-idx">[{r.index}]</span>
					<span class="ratel-search-path" title={r.path}>{r.path}</span>
					<span class="ratel-search-score {scoreClass(r.score)}">{r.score.toFixed(3)}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	/*
	 * 关键路径:毛玻璃卡片 + 微阴影。圆角 6px,边框使用 accent 淡色,
	 * 营造与消息气泡的层次区分。
	 */
	.ratel-search {
		margin-bottom: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--background-tertiary) 75%, transparent);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
		border: 1px solid color-mix(in srgb, var(--text-accent) 10%, var(--background-modifier-border));
		font-size: 12px;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
	}

	.ratel-search-hdr {
		font-weight: 600;
		margin-bottom: 6px;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		gap: 6px;
		padding-bottom: 5px;
		border-bottom: 1px solid color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
	}

	.ratel-search-icon {
		font-size: 0.9em;
		opacity: 0.85;
	}

	.ratel-search-title {
		color: var(--text-normal);
	}

	.ratel-search-count {
		font-family: var(--font-monospace);
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--text-muted) 15%, transparent);
		color: var(--text-muted);
		font-weight: 500;
	}

	.ratel-search-badge {
		margin-left: auto;
		padding: 1px 7px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--text-warning) 15%, transparent);
		color: var(--text-warning);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.2px;
	}

	.ratel-search-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.ratel-search-row {
		display: flex;
		gap: 8px;
		align-items: center;
		padding: 3px 4px;
		border-radius: 4px;
		transition: background 0.12s ease;
	}

	.ratel-search-row:hover {
		background: color-mix(in srgb, var(--text-accent) 6%, transparent);
	}

	.ratel-search-idx {
		font-family: var(--font-monospace);
		font-weight: 700;
		color: var(--text-muted);
		min-width: 26px;
		flex-shrink: 0;
		font-size: 11px;
	}

	.ratel-search-path {
		flex: 1;
		font-family: var(--font-monospace);
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-normal);
	}

	.ratel-search-score {
		font-family: var(--font-monospace);
		font-size: 10px;
		flex-shrink: 0;
		font-weight: 600;
		padding: 1px 5px;
		border-radius: 4px;
	}

	/* 关键路径:分数色阶 — 高/中/低三档,用 color-mix 生成淡背景 */
	.ratel-search-score-high {
		color: var(--text-success);
		background: color-mix(in srgb, var(--text-success) 12%, transparent);
	}

	.ratel-search-score-mid {
		color: var(--text-warning);
		background: color-mix(in srgb, var(--text-warning) 12%, transparent);
	}

	.ratel-search-score-low {
		color: var(--text-faint, var(--text-muted));
		background: color-mix(in srgb, var(--text-muted) 8%, transparent);
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-search-row { transition: none; }
	}
</style>
