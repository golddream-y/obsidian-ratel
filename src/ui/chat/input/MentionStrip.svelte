<script lang="ts">
	/**
	 * @file src/ui/chat/input/MentionStrip.svelte
	 * @description @mention chip 条 — 展示已引用路径,可删除
	 * @module ui/chat/input/MentionStrip
	 */
	import { t } from '../../../i18n';
	import { mentionBasename } from './mention-suggest';

	let {
		paths,
		onRemove,
	}: {
		paths: string[];
		onRemove: (path: string) => void;
	} = $props();
</script>

{#if paths.length > 0}
	<div class="ratel-ms" role="list" aria-label={$t('chat.mention.stripAria')}>
		{#each paths as path (path)}
			<span class="ratel-ms-chip" role="listitem" title={path}>
				<span class="ratel-ms-at">@</span>
				<span class="ratel-ms-name">{mentionBasename(path)}</span>
				<button
					class="ratel-ms-x"
					type="button"
					onclick={() => onRemove(path)}
					aria-label={$t('chat.mention.removeAria', { name: mentionBasename(path) })}
				>×</button>
			</span>
		{/each}
	</div>
{/if}

<style>
	.ratel-ms {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		padding: 4px 0;
		flex-shrink: 0;
	}

	.ratel-ms-chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		max-width: 100%;
		padding: 2px 6px 2px 8px;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: color-mix(in srgb, var(--interactive-accent) 12%, var(--background-secondary));
		font-size: 12px;
		line-height: 1.4;
	}

	.ratel-ms-at {
		color: var(--text-accent, var(--interactive-accent));
		font-weight: 700;
	}

	.ratel-ms-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 160px;
		color: var(--text-normal);
	}

	.ratel-ms-x {
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		padding: 0 2px;
		font-size: 14px;
		line-height: 1;
	}

	.ratel-ms-x:hover {
		color: var(--text-error);
	}
</style>
