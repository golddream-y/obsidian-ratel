<script lang="ts">
	/**
	 * @file src/ui/AttachmentStrip.svelte
	 * @description 图片附件预览条 — 缩略图 + 右上角 × 删除按钮(横向滚动)
	 * @module ui/AttachmentStrip
	 * @depends svelte/store, user-feedback/user-status
	 */
	import type { Readable } from 'svelte/store';
	import type { PendingAttachment } from '../../../user-feedback/user-status';

	let {
		pendingAttachments$,
		onRemove,
	}: {
		pendingAttachments$: Readable<PendingAttachment[]>;
		onRemove: (id: string) => void;
	} = $props();

	const attachments = $derived($pendingAttachments$);
</script>

{#if attachments.length > 0}
	<div class="ratel-as">
		{#each attachments as att}
			<div class="ratel-as-thumb" title={att.fileName}>
				<img src="data:{att.mimeType};base64,{att.base64}" alt={att.fileName} />
				<button
					class="ratel-as-remove"
					type="button"
					onclick={() => onRemove(att.id)}
					aria-label="删除附件 {att.fileName}"
				>×</button>
				<span class="ratel-as-tokens">~{att.estimatedTokens}t</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.ratel-as {
		display: flex;
		gap: 8px;
		overflow-x: auto;
		padding: 4px 0;
		flex-shrink: 0;
	}

	.ratel-as-thumb {
		position: relative;
		width: 56px;
		height: 56px;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--background-modifier-border);
		flex-shrink: 0;
	}

	.ratel-as-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.ratel-as-remove {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 16px;
		height: 16px;
		padding: 0;
		border: none;
		border-radius: 50%;
		background: rgba(0, 0, 0, 0.7);
		color: #fff;
		font-size: 10px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.ratel-as-remove:hover {
		background: rgba(0, 0, 0, 0.9);
	}

	.ratel-as-tokens {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		font-size: 9px;
		font-family: var(--font-monospace);
		text-align: center;
		background: rgba(0, 0, 0, 0.6);
		color: var(--text-muted, #aaa);
		padding: 1px 0;
	}
</style>
