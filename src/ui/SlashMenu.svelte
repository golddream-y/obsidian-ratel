<script lang="ts">
	/**
	 * @file src/ui/SlashMenu.svelte
	 * @description 斜杠命令弹窗 — 输入 / 时弹出,过滤/键盘导航/选中执行
	 * @module ui/SlashMenu
	 * @depends ui/slash-commands
	 */
	import { filterCommands, type SlashCommand } from './slash-commands';

	let {
		input,
		onSelect,
		onClose,
	}: {
		input: string;
		onSelect: (cmd: SlashCommand) => void;
		onClose: () => void;
	} = $props();

	const commands = $derived(filterCommands(input));
	let selectedIndex = $state(0);

	$effect(() => {
		if (selectedIndex >= commands.length) {
			selectedIndex = Math.max(0, commands.length - 1);
		}
	});

	/**
	 * 处理键盘事件 — 上下键移动,回车确认,Esc 关闭。
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
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
			return true;
		}
		return false;
	}
</script>

{#if commands.length > 0}
	<div class="ratel-sm" role="listbox">
		<div class="ratel-sm-header">命令</div>
		{#each commands as cmd, i}
			<div
				class="ratel-sm-item"
				class:ratel-sm-active={i === selectedIndex}
				role="option"
				aria-selected={i === selectedIndex}
				onclick={() => onSelect(cmd)}
			>
				<span class="ratel-sm-cmd">{cmd.name}</span>
				<span class="ratel-sm-desc">{cmd.description}</span>
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

	.ratel-sm-item:hover,
	.ratel-sm-active {
		background: var(--background-modifier-form-field);
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
	}
</style>
