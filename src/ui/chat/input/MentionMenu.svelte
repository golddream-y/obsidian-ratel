<script lang="ts">
	/**
	 * @file src/ui/chat/input/MentionMenu.svelte
	 * @description @mention 补全弹窗 — 对标 SlashMenu
	 * @module ui/chat/input/MentionMenu
	 */
	import { t } from '../../../i18n';
	import { mentionBasename } from './mention-suggest';

	let {
		items,
		onSelect,
		onClose,
	}: {
		items: string[];
		onSelect: (path: string) => void;
		onClose: () => void;
	} = $props();

	let selectedIndex = $state(0);

	$effect(() => {
		if (selectedIndex >= items.length) {
			selectedIndex = Math.max(0, items.length - 1);
		}
	});

	/**
	 * 处理键盘事件 — 上下/回车/Esc。
	 * @returns true 表示已处理
	 */
	export function handleKeydown(e: KeyboardEvent): boolean {
		if (items.length === 0) return false;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % items.length;
			return true;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + items.length) % items.length;
			return true;
		}
		if (e.key === 'Enter' || e.key === 'Tab') {
			e.preventDefault();
			const path = items[selectedIndex];
			if (path) onSelect(path);
			return true;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return true;
		}
		return false;
	}
</script>

{#if items.length > 0}
	<div class="ratel-mm" role="listbox" aria-label={$t('chat.mention.menuTitle')}>
		<div class="ratel-mm-header">{$t('chat.mention.menuTitle')}</div>
		{#each items as path, i (path)}
			<div
				class="ratel-mm-item"
				class:ratel-mm-active={i === selectedIndex}
				role="option"
				tabindex="0"
				aria-selected={i === selectedIndex}
				onclick={() => onSelect(path)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						onSelect(path);
					}
				}}
			>
				<span class="ratel-mm-base">{mentionBasename(path)}</span>
				<span class="ratel-mm-path">{path}</span>
			</div>
		{/each}
	</div>
{:else}
	<div class="ratel-mm ratel-mm-empty">{$t('chat.mention.empty')}</div>
{/if}

<style>
	.ratel-mm {
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		max-height: 240px;
		overflow-y: auto;
	}

	.ratel-mm-empty {
		padding: 10px 12px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.ratel-mm-header {
		padding: 6px 12px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--text-faint, var(--text-muted));
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.ratel-mm-item {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 12px;
		cursor: pointer;
		font-size: 12.5px;
	}

	.ratel-mm-item:hover,
	.ratel-mm-active {
		background: var(--background-modifier-form-field);
	}

	.ratel-mm-base {
		font-weight: 600;
		color: var(--text-accent, var(--interactive-accent));
	}

	.ratel-mm-path {
		font-size: 11px;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
