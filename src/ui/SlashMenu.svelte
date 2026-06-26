<script lang="ts">
	/**
	 * @file src/ui/SlashMenu.svelte
	 * @description 斜杠命令弹窗 — 输入 / 时弹出,过滤/选择/执行
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

	// 关键路径:input 变化时自动重算过滤结果
	const commands = $derived(filterCommands(input));
	// 选中索引:commands 变化时重置为 0
	let selectedIndex = $state(0);

	// 关键路径:commands 长度变化时 clamp selectedIndex
	$effect(() => {
		if (selectedIndex >= commands.length) {
			selectedIndex = Math.max(0, commands.length - 1);
		}
	});

	/**
	 * 处理键盘事件 — 上下键移动,回车确认,Esc 关闭。
	 * 由 ChatView 在输入框 onkeydown 时转发到此。
	 *
	 * @returns true 表示事件已处理(阻止默认行为);false 表示未处理(放行)
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
	<div class="ratel-slash-menu" role="listbox">
		{#each commands as cmd, i}
			<button
				class="ratel-slash-item"
				class:ratel-slash-selected={i === selectedIndex}
				type="button"
				role="option"
				aria-selected={i === selectedIndex}
				onclick={() => onSelect(cmd)}
			>
				<span class="ratel-slash-icon">{cmd.icon}</span>
				<span class="ratel-slash-name">{cmd.name}</span>
				<span class="ratel-slash-desc">{cmd.description}</span>
			</button>
		{/each}
	</div>
{/if}

<style>
	.ratel-slash-menu {
		position: absolute;
		bottom: 100%;
		left: 0;
		right: 0;
		background: var(--background-secondary);
		border: 1px solid var(--background-modifier-border);
		border-radius: 6px;
		max-height: 240px;
		overflow-y: auto;
		z-index: 10;
		margin-bottom: 4px;
	}

	.ratel-slash-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 10px;
		background: none;
		border: none;
		color: var(--text-normal);
		font: inherit;
		font-size: 0.85em;
		text-align: left;
		cursor: pointer;
	}

	.ratel-slash-item:hover {
		background: var(--background-modifier-border-hover);
	}

	.ratel-slash-selected {
		background: var(--background-modifier-border-hover);
	}

	.ratel-slash-icon {
		flex-shrink: 0;
		width: 18px;
		text-align: center;
	}

	.ratel-slash-name {
		font-family: var(--font-monospace);
		font-weight: 600;
		flex-shrink: 0;
		min-width: 72px;
	}

	.ratel-slash-desc {
		color: var(--text-muted);
		font-size: 0.9em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
