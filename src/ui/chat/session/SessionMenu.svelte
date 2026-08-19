<!--
	@file src/ui/chat/session/SessionMenu.svelte
	@description Header 会话历史小菜单 — 最近列表,行内编辑标题 / 删除(新对话为顶栏独立按钮)
	@module ui/chat/session/SessionMenu
-->
<script lang="ts">
	import { t } from '../../../i18n';
	import type { SessionIndexEntry } from '../../../ports/persistence';
	import { deriveShortTitle } from './session-title';
	import { staggerDelayMs } from '../../motion/chrome/animated-list-policy';

	let {
		entries,
		currentId,
		loadingId = null,
		open = false,
		motionOn = false,
		onSelect,
		onRename,
		onDelete,
	}: {
		entries: SessionIndexEntry[];
		currentId: string;
		loadingId?: string | null;
		open?: boolean;
		motionOn?: boolean;
		onSelect: (id: string) => void;
		onRename: (id: string) => void;
		onDelete: (id: string) => void;
	} = $props();

	function formatWhen(ts: number): string {
		const diff = Date.now() - ts;
		if (diff < 60_000) return '·';
		if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
		if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`;
		return `${Math.floor(diff / 86400_000)}d`;
	}

	function rowShort(e: SessionIndexEntry): string {
		return (
			e.shortTitle?.trim() ||
			deriveShortTitle(e.title) ||
			$t('chat.session.emptyTitle')
		);
	}

	function rowFull(e: SessionIndexEntry): string {
		return e.title?.trim() || rowShort(e);
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="ratel-session-menu"
		role="menu"
		aria-label={$t('chat.session.ariaHistory')}
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<div class="ratel-session-menu-head">
			<span class="ratel-session-menu-label">{$t('chat.session.menuRecent')}</span>
		</div>
		<div class="ratel-session-list">
			{#each entries as e, i (e.id)}
				{@const short = rowShort(e)}
				{@const full = rowFull(e)}
				<!-- 安全路径:行主体不用 button — Obsidian 主题常给 button 固定 height,多行标题会被纵向裁切 -->
				<div
					class="ratel-session-row"
					class:ratel-session-enter={motionOn}
					class:current={e.id === currentId}
					class:is-loading={loadingId === e.id}
					style:animation-delay={motionOn ? `${staggerDelayMs(i) ?? 0}ms` : '0ms'}
					role="menuitem"
					tabindex="0"
					onclick={(ev) => {
						ev.stopPropagation();
						onSelect(e.id);
					}}
					onkeydown={(ev) => {
						if (ev.key === 'Enter' || ev.key === ' ') {
							ev.preventDefault();
							ev.stopPropagation();
							onSelect(e.id);
						}
					}}
				>
					<div class="ratel-session-row-body">
					<div class="ratel-session-title-short">{short}</div>
					{#if full !== short}
						<div class="ratel-session-title-full">{full}</div>
					{/if}
					<div class="ratel-session-when">{formatWhen(e.updatedAt)}</div>
				</div>
				<div class="ratel-session-row-actions">
					<button
						type="button"
						class="ratel-session-act"
						title={$t('chat.session.rename')}
						aria-label={$t('chat.session.rename')}
						onclick={(ev) => {
							ev.stopPropagation();
							onRename(e.id);
						}}
					>
						✎
					</button>
					<button
						type="button"
						class="ratel-session-act ratel-session-del"
						title={$t('chat.session.delete')}
						aria-label={$t('chat.session.delete')}
						onclick={(ev) => {
							ev.stopPropagation();
							onDelete(e.id);
						}}
					>
						×
					</button>
				</div>
				</div>
			{/each}
		</div>
	</div>
{/if}

<style>
	.ratel-session-menu {
		/* 由外层 .ratel-session-menu-float 定位(对齐原型 header-actions 内绝对定位) */
		position: relative;
		top: auto;
		right: auto;
		width: 280px;
		max-height: 300px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		/* 实色:不用可能带 alpha 的 CSS 变量 */
		background-color: #ffffff;
		border: 1px solid var(--background-modifier-border);
		border-radius: 12px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
		z-index: 1;
		isolation: isolate;
	}

	:global(.theme-dark) .ratel-session-menu {
		background-color: #1e1e1e;
	}

	.ratel-session-menu-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 10px 12px 8px;
		border-bottom: 1px solid var(--background-modifier-border);
		flex-shrink: 0;
	}

	.ratel-session-menu-label {
		font-size: 11px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
		font-weight: 550;
	}

	.ratel-session-list {
		overflow-y: auto;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 0;
	}

	.ratel-session-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 4px;
		align-items: start;
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid transparent;
		cursor: pointer;
		outline: none;
	}

	.ratel-session-row:hover {
		background: color-mix(in srgb, var(--background-modifier-hover, #000) 6%, transparent);
	}

	.ratel-session-row.current {
		background: color-mix(in srgb, var(--text-accent, #c9956c) 16%, transparent);
		border-color: color-mix(in srgb, var(--text-accent, #c9956c) 22%, transparent);
	}

	.ratel-session-row-body {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 4px;
		min-width: 0;
		overflow: visible;
	}

	.ratel-session-title-short {
		font-size: 13px;
		font-weight: 550;
		color: var(--text-normal);
		line-height: 1.4;
		/* 只做横向省略,纵向绝不裁切字形 */
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-height: 1.4em;
	}

	.ratel-session-title-full {
		font-size: 11.5px;
		font-weight: 450;
		color: var(--text-muted);
		line-height: 1.4;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.ratel-session-row.is-loading .ratel-session-title-short::after {
		content: '';
		display: inline-block;
		width: 10px;
		height: 10px;
		margin-left: 8px;
		vertical-align: -1px;
		border: 1.5px solid var(--background-modifier-border);
		border-top-color: var(--text-accent, #c9956c);
		border-radius: 50%;
		animation: ratel-session-spin 0.65s linear infinite;
	}

	.ratel-session-when {
		font-size: 11px;
		color: var(--text-faint, var(--text-muted));
		line-height: 1.3;
		min-height: 1.3em;
	}

	.ratel-session-row-actions {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		flex-shrink: 0;
	}

	/* 行内操作(编辑/删除):悬停行才现身,与原删除交互一致 */
	.ratel-session-act {
		width: 22px;
		height: 22px;
		min-height: 22px;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		opacity: 0;
		font-size: 13px;
		line-height: 1;
		padding: 0;
		flex-shrink: 0;
	}

	.ratel-session-row:hover .ratel-session-act,
	.ratel-session-act:focus-visible {
		opacity: 1;
	}

	.ratel-session-act:hover {
		color: var(--text-normal);
		background: color-mix(in srgb, var(--background-modifier-hover, #000) 8%, transparent);
	}

	.ratel-session-del:hover {
		color: var(--text-error, #d0887a);
	}

	.ratel-session-enter {
		animation: ratel-session-enter 220ms ease both;
	}

	@keyframes ratel-session-enter {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes ratel-session-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-session-row.is-loading .ratel-session-title-short::after {
			animation: none;
		}

		.ratel-session-enter {
			animation: none;
		}
	}
</style>
