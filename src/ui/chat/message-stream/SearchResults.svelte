<!--
	@file src/ui/chat/message-stream/SearchResults.svelte
	@description 检索引用芯片行 — 默认折叠「来源 N 篇」，展开后显示 chip
	@module ui/chat/message-stream/SearchResults
	设计:序号 + formatCitePath 截断 path;点击走注入的 onOpenPath;无 emoji / 无分数色阶
-->
<script lang="ts">
	import { t } from '../../../i18n';
	import { formatCitePath } from '../cite-path-display';

	let {
		results,
		reranked = false,
		onOpenPath,
	}: {
		results: Array<{ docId: string; score: number; path: string; index: number }>;
		reranked?: boolean;
		onOpenPath: (path: string) => void;
	} = $props();

	let expanded = $state(false);
</script>

{#if results.length > 0}
	<div class="ratel-cites">
		<button
			type="button"
			class="ratel-cites-toggle"
			aria-expanded={expanded}
			aria-label={expanded ? $t('chat.cite.sourcesCollapseAria') : $t('chat.cite.sourcesExpandAria')}
			onclick={() => (expanded = !expanded)}
		>
			<span class="ratel-cites-toggle-label"
				>{$t('chat.cite.sourcesCollapsed', { n: results.length })}</span
			>
			<span class="ratel-cites-toggle-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
		</button>
		{#if expanded}
			{#if reranked}
				<div class="ratel-cites-hint">{$t('chat.search.rerankHint')}</div>
			{/if}
			<div class="ratel-cites-row" role="list">
				{#each results as r}
					<button
						type="button"
						class="ratel-cite-chip"
						role="listitem"
						aria-label={$t('chat.cite.openNote', { path: r.path })}
						title={r.path}
						onclick={() => onOpenPath(r.path)}
					>
						<span class="ratel-cite-chip-n">{r.index}</span>
						<span class="ratel-cite-chip-path">{formatCitePath(r.path)}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	.ratel-cites {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 4px;
	}

	.ratel-cites-hint {
		font-size: 11px;
		color: var(--text-muted);
		line-height: 1.3;
	}

	/* 组件内兜底；压过 Obsidian button 的完整重置在 styles.css */
	.ratel-cites-toggle {
		display: inline-flex;
		align-items: center;
		align-self: flex-start;
		gap: 6px;
		box-sizing: border-box;
		height: auto;
		min-height: 0;
		padding: 4px 10px;
		margin: 0;
		border: 1px solid var(--background-modifier-border);
		border-radius: 999px;
		background: var(--background-secondary);
		box-shadow: none;
		color: var(--text-muted);
		font-size: 11.5px;
		font-family: inherit;
		font-weight: 500;
		line-height: 1.25;
		letter-spacing: 0.01em;
		cursor: pointer;
		text-decoration: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.ratel-cites-toggle:hover {
		color: var(--text-normal);
		border-color: color-mix(
			in srgb,
			var(--ratel-cite, var(--interactive-accent)) 40%,
			var(--background-modifier-border)
		);
		background: color-mix(
			in srgb,
			var(--ratel-cite, var(--interactive-accent)) 10%,
			var(--background-secondary)
		);
	}

	.ratel-cites-toggle:focus-visible {
		outline: 2px solid var(--interactive-accent);
		outline-offset: 2px;
	}

	.ratel-cites-toggle-label {
		line-height: 1.25;
	}

	.ratel-cites-toggle-caret {
		flex-shrink: 0;
		font-size: 10px;
		line-height: 1;
		opacity: 0.75;
	}

	.ratel-cites-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.ratel-cite-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 100%;
		padding: 5px 10px 5px 8px;
		border-radius: 999px;
		border: 1px solid var(--background-modifier-border);
		background: color-mix(in srgb, var(--ratel-cite, var(--interactive-accent)) 12%, transparent);
		color: var(--text-muted);
		font-size: 11.5px;
		font-family: inherit;
		cursor: pointer;
		transition: border-color 0.15s, background 0.15s, color 0.15s;
		-webkit-appearance: none;
		appearance: none;
		text-align: left;
	}

	.ratel-cite-chip:hover {
		border-color: color-mix(in srgb, var(--ratel-cite, var(--interactive-accent)) 55%, var(--background-modifier-border));
		background: color-mix(in srgb, var(--ratel-cite, var(--interactive-accent)) 20%, transparent);
		color: var(--text-normal);
	}

	.ratel-cite-chip-n {
		flex-shrink: 0;
		min-width: 1.2em;
		padding: 0;
		border-radius: 0;
		background: transparent;
		color: var(--ratel-cite, var(--interactive-accent));
		font-family: var(--font-monospace);
		font-size: 10px;
		font-weight: 500;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.ratel-cite-chip-path {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 200px;
		font-family: var(--font-monospace);
		font-size: 11px;
	}
</style>
