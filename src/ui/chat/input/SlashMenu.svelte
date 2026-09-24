<script lang="ts">
	/**
	 * @file src/ui/SlashMenu.svelte
	 * @description 斜杠命令弹窗 — 输入 / 时弹出,过滤/键盘导航/选中执行
	 * @module ui/SlashMenu
	 * @depends ui/slash-commands
	 */
	import {
		completeUniqueSlashItem,
		filterSlashMenu,
		type SlashMenuItem,
		type SlashSkillCandidate,
	} from './slash-commands';
	import { t } from '../../../i18n';
	import { isChatMotionEnabled } from '../../motion/prefs';
	import { settings$ } from '../../settings-store';
	import { staggerDelayMs } from '../../motion/chrome/animated-list-policy';
	import { tick } from 'svelte';

	let {
		input,
		skills = [],
		onSelect,
		onComplete,
		onClose,
	}: {
		input: string;
		skills?: readonly SlashSkillCandidate[];
		onSelect: (item: SlashMenuItem) => void;
		/** Tab 补全写入输入框,不执行命令 */
		onComplete: (filled: string) => void;
		onClose: () => void;
	} = $props();

	const commands = $derived.by(() => {
		// 关键路径:引用 $t 让 derived 追踪 langStore 变化,
		// 语言切换时 filterSlashMenu 内部用新语言重求值 description。
		void $t;
		return filterSlashMenu(input, skills);
	});
	let selectedIndex = $state(0);
	let listEl = $state<HTMLDivElement | null>(null);
	const listKey = $derived(commands.map((cmd) => `${cmd.kind}:${cmd.name}`).join('\0'));

	const motionOn = $derived(isChatMotionEnabled($settings$));

	// 筛选结果一变就把高亮放回第一行。只剩一条时也一定是激活行。
	$effect(() => {
		void listKey;
		selectedIndex = 0;
	});

	$effect(() => {
		const index = selectedIndex;
		void commands.length;
		void tick().then(() => scrollSelectedIntoView(index));
	});

	/** 键盘移动时只滚菜单自己,避免把整页聊天一起带走。 */
	function scrollSelectedIntoView(index: number): void {
		const root = listEl;
		if (!root) return;
		const item = root.querySelectorAll<HTMLElement>('.ratel-sm-item')[index];
		if (!item) return;
		const rootRect = root.getBoundingClientRect();
		const itemRect = item.getBoundingClientRect();
		if (itemRect.top < rootRect.top) {
			root.scrollTop -= rootRect.top - itemRect.top;
		} else if (itemRect.bottom > rootRect.bottom) {
			root.scrollTop += itemRect.bottom - rootRect.bottom;
		}
	}

	/**
	 * 处理键盘事件 — 上下键移动,回车执行,Tab 补全,Esc 关闭。
	 * @returns true 表示事件已处理
	 */
	export function handleKeydown(e: KeyboardEvent): boolean {
		if (commands.length === 0) return false;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % commands.length;
			return true;
		}
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + commands.length) % commands.length;
			return true;
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			const cmd = commands[selectedIndex];
			if (cmd) onSelect(cmd);
			return true;
		}
		if (e.key === 'Tab') {
			e.preventDefault();
			const unique = completeUniqueSlashItem(input, skills);
			if (unique) {
				onComplete(unique);
				return true;
			}
			const cmd = commands[selectedIndex];
			if (cmd) onComplete(cmd.kind === 'skill' ? `/${cmd.name} ` : `${cmd.name} `);
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

{#if commands.length > 0}
	<div class="ratel-sm" role="listbox" bind:this={listEl}>
		<div class="ratel-sm-header">{$t('chat.slashMenu.header')}</div>
		{#each commands as cmd, i}
			<div
				class="ratel-sm-item"
				class:ratel-sm-enter={motionOn}
				class:ratel-sm-active={i === selectedIndex}
				style:animation-delay={motionOn ? `${staggerDelayMs(i) ?? 0}ms` : '0ms'}
				role="option"
				aria-selected={i === selectedIndex}
				onclick={() => onSelect(cmd)}
			>
				<span class="ratel-sm-cmd">{cmd.name}</span>
				<span class="ratel-sm-desc">{cmd.description}</span>
				{#if cmd.origin}
					<span class="ratel-sm-tag ratel-sm-origin" class:ratel-sm-origin--installed={cmd.origin !== 'builtin'}>
						{cmd.origin === 'builtin' ? $t('chat.slashMenu.origin.builtin') : $t('chat.slashMenu.origin.installed')}
					</span>
				{/if}
				<span class="ratel-sm-tag" class:ratel-sm-tag--skill={cmd.kind === 'skill'}>
					{cmd.kind === 'skill' ? $t('chat.slashMenu.tag.skill') : $t('chat.slashMenu.tag.command')}
				</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.ratel-sm {
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 8px;
		max-height: 240px;
		overflow-y: auto;
	}

	.ratel-sm-header {
		padding: 6px 12px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--text-faint, var(--text-muted));
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.ratel-sm-item {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 12px;
		cursor: pointer;
		font-size: 12.5px;
	}

	.ratel-sm-item:hover {
		background: var(--background-modifier-hover);
	}

	.ratel-sm-active {
		background: color-mix(in srgb, var(--interactive-accent) 16%, var(--background-secondary));
		box-shadow: inset 2px 0 0 var(--interactive-accent);
	}

	.ratel-sm-cmd {
		font-family: var(--font-monospace);
		color: var(--text-accent, var(--interactive-accent));
		font-weight: 600;
		min-width: 72px;
		flex-shrink: 0;
	}

	.ratel-sm-desc {
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}

	.ratel-sm-tag {
		flex-shrink: 0;
		font-size: 10px;
		line-height: 1;
		padding: 2px 5px;
		border-radius: 3px;
		color: var(--text-muted);
		background: var(--background-modifier-hover);
	}

	.ratel-sm-tag--skill {
		color: var(--text-accent, var(--interactive-accent));
		background: color-mix(in srgb, var(--interactive-accent) 16%, transparent);
	}

	.ratel-sm-origin--installed {
		color: var(--color-purple);
		background: color-mix(in srgb, var(--color-purple) 16%, transparent);
	}

	.ratel-sm-enter {
		animation: ratel-sm-enter 220ms ease both;
	}

	@keyframes ratel-sm-enter {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-sm-enter {
			animation: none;
		}
	}
</style>
