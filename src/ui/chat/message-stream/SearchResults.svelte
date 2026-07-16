<!--
	@file src/ui/chat/message-stream/SearchResults.svelte
	@description 检索引用芯片行 — 取代分数墙大卡(S-CHAT-UI-V3 §5.5)
	@module ui/chat/message-stream/SearchResults
	设计:序号 + 截断 path;点击走注入的 onOpenPath;无 emoji / 无分数色阶
-->
<script lang="ts">
	import { t } from '../../../i18n';

	let {
		results,
		reranked = false,
		onOpenPath,
	}: {
		results: Array<{ docId: string; score: number; path: string; index: number }>;
		reranked?: boolean;
		onOpenPath: (path: string) => void;
	} = $props();

	function truncatePath(path: string): string {
		if (path.length <= 42) return path;
		return '…' + path.slice(-40);
	}
</script>

{#if results.length > 0}
	<div class="ratel-cites">
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
					<span class="ratel-cite-chip-path">{truncatePath(r.path)}</span>
				</button>
			{/each}
		</div>
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
