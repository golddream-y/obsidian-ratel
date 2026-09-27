<!--
	@file src/ui/chat/ChatProfileMenu.svelte
	@description 顶栏已保存对话配置菜单 — 切换当前套、跳转设置管理
	@module ui/chat/ChatProfileMenu
-->
<script lang="ts">
	import { t } from '../../i18n';
	import type { ChatProfile } from '../../settings/chat-profiles';

	let {
		profiles,
		activeId,
		open = false,
		onSelect,
		onManageInSettings,
	}: {
		profiles: ChatProfile[];
		activeId: string;
		open?: boolean;
		onSelect: (id: string) => void;
		onManageInSettings: () => void;
	} = $props();
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="ratel-chat-profile-menu"
		role="menu"
		aria-label={$t('chat.profileMenu.ariaLabel')}
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<div class="ratel-chat-profile-list">
			{#each profiles as profile (profile.id)}
				{@const isActive = profile.id === activeId}
				<div
					class="ratel-chat-profile-row"
					class:current={isActive}
					role="menuitem"
					tabindex="0"
					aria-current={isActive ? 'true' : undefined}
					onclick={(ev) => {
						ev.stopPropagation();
						onSelect(profile.id);
					}}
					onkeydown={(ev) => {
						if (ev.key === 'Enter' || ev.key === ' ') {
							ev.preventDefault();
							ev.stopPropagation();
							onSelect(profile.id);
						}
					}}
				>
					<div class="ratel-chat-profile-row-body">
						<div class="ratel-chat-profile-name">
							{profile.name}
							{#if isActive}
								<span class="ratel-chat-profile-active-mark">
									{$t('settings.chatProfiles.activeMark')}
								</span>
							{/if}
						</div>
						<div class="ratel-chat-profile-model">{profile.model}</div>
					</div>
				</div>
			{/each}
		</div>
		<div class="ratel-chat-profile-footer">
			<button
				type="button"
				class="ratel-chat-profile-manage"
				onclick={(ev) => {
					ev.stopPropagation();
					onManageInSettings();
				}}
			>
				{$t('chat.profileMenu.manageInSettings')}
			</button>
		</div>
	</div>
{/if}

<style>
	.ratel-chat-profile-menu {
		position: relative;
		width: 280px;
		max-height: 320px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		background-color: #ffffff;
		border: 1px solid var(--background-modifier-border);
		border-radius: 12px;
		z-index: 1;
		isolation: isolate;
	}

	:global(.theme-dark) .ratel-chat-profile-menu {
		background-color: #1e1e1e;
	}

	.ratel-chat-profile-list {
		overflow-y: auto;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 0;
	}

	.ratel-chat-profile-row {
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid transparent;
		cursor: pointer;
		outline: none;
	}

	.ratel-chat-profile-row:hover {
		background: color-mix(in srgb, var(--background-modifier-hover, #000) 6%, transparent);
	}

	.ratel-chat-profile-row.current {
		background: color-mix(in srgb, var(--text-accent, #c9956c) 16%, transparent);
		border-color: color-mix(in srgb, var(--text-accent, #c9956c) 22%, transparent);
	}

	.ratel-chat-profile-row-body {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.ratel-chat-profile-name {
		font-size: 13px;
		font-weight: 550;
		color: var(--text-normal);
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-chat-profile-active-mark {
		margin-left: 6px;
		font-size: 11px;
		font-weight: 500;
		color: var(--text-muted);
	}

	.ratel-chat-profile-model {
		font-size: 11px;
		font-family: 'IBM Plex Mono', var(--font-monospace), ui-monospace, monospace;
		font-weight: 450;
		color: var(--text-muted);
		line-height: 1.35;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-chat-profile-footer {
		flex-shrink: 0;
		padding: 6px 8px 8px;
		border-top: 1px solid var(--background-modifier-border);
	}

	.ratel-chat-profile-manage {
		width: 100%;
		min-height: 32px;
		padding: 6px 10px;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		text-align: left;
		transition: color 0.15s, background 0.15s;
	}

	.ratel-chat-profile-manage:hover {
		color: var(--text-normal);
		background: color-mix(in srgb, var(--background-modifier-hover, #000) 6%, transparent);
	}
</style>
