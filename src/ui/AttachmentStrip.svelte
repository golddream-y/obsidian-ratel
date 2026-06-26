<script lang="ts">
	/**
	 * @file src/ui/AttachmentStrip.svelte
	 * @description 图片附件预览条 — 缩略图 + 删除按钮
	 * @module ui/AttachmentStrip
	 * @depends svelte/store, user-feedback/user-status
	 */
	import type { Readable } from 'svelte/store';
	import type { PendingAttachment } from '../user-feedback/user-status';

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
	<div class="ratel-attachment-strip">
		{#each attachments as att}
			<div class="ratel-attachment-thumb" title={att.fileName}>
				<img src="data:{att.mimeType};base64,{att.base64}" alt={att.fileName} />
				<button
					class="ratel-attachment-remove"
					type="button"
					onclick={() => onRemove(att.id)}
					aria-label="删除附件 {att.fileName}"
				>×</button>
				<span class="ratel-attachment-tokens">~{att.estimatedTokens}t</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.ratel-attachment-strip {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		padding: 4px 0;
		margin-bottom: 4px;
		flex-shrink: 0;
	}

	.ratel-attachment-thumb {
		position: relative;
		width: 56px;
		height: 56px;
		border-radius: 4px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-modifier-form-field);
		flex-shrink: 0;
		overflow: hidden;
	}

	.ratel-attachment-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.ratel-attachment-remove {
		position: absolute;
		top: 0;
		right: 0;
		width: 16px;
		height: 16px;
		padding: 0;
		border: none;
		border-radius: 0 4px 0 4px;
		background: var(--background-modifier-error);
		color: var(--text-on-accent);
		font-size: 12px;
		line-height: 1;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.ratel-attachment-tokens {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		font-size: 9px;
		font-family: var(--font-monospace);
		text-align: center;
		background: var(--background-secondary);
		color: var(--text-muted);
		padding: 1px 0;
	}
</style>
