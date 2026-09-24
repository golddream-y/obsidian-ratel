<!--
	@file src/ui/chat/message-stream/TextSegment.svelte
	@description 文本段渲染 — 助手单块 MarkdownView(stable/tail 由 projector 拆分),用户消息纯文本
	@module ui/chat/message-stream/TextSegment
	@depends ../components/MarkdownView.svelte, ../input/slash-commands
-->
<script lang="ts">
	import { splitLeadingSlashCommand } from '../input/slash-commands';
	import MarkdownView from '../../components/MarkdownView.svelte';
	import { t } from '../../../i18n';

	let {
		text,
		isUser = false,
		streaming = false,
		searchResults,
		onOpenPath,
		motionOn = false,
		messageId = '',
		skillNames = [],
		installedSkillNames = [],
	}: {
		text: string;
		isUser?: boolean;
		streaming?: boolean;
		searchResults?: Array<{ docId: string; score: number; path: string; index: number }>;
		onOpenPath?: (path: string) => void;
		motionOn?: boolean;
		messageId?: string;
		skillNames?: readonly string[];
		/** 非内置技能名。气泡里只给这些加「已安装」。 */
		installedSkillNames?: readonly string[];
	} = $props();

	function installedSkill(token: string): boolean {
		const name = token.startsWith('/') ? token.slice(1) : token;
		return installedSkillNames.includes(name);
	}
</script>

{#if isUser}
	<div class="ratel-text-segment ratel-text-user">
		{#each splitLeadingSlashCommand(text, skillNames) as span}
			{#if span.kind === 'command' || span.kind === 'skill'}
				<span class="ratel-slash-token" class:ratel-slash-token--skill={span.kind === 'skill'}>{span.text}</span>
				{#if span.kind === 'skill' && installedSkill(span.text)}
					<span class="ratel-skill-installed">{$t('chat.slashMenu.origin.installed')}</span>
				{/if}
			{:else}{span.text}{/if}
		{/each}
	</div>
{:else}
	<div class="ratel-text-segment ratel-text-assistant">
		<MarkdownView
			content={text}
			{streaming}
			{searchResults}
			{onOpenPath}
			{motionOn}
			{messageId}
		/>
	</div>
{/if}

<style>
	.ratel-text-segment {
		font-size: 13.5px;
		line-height: 1.6;
	}

	.ratel-text-user {
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-normal);
	}

	.ratel-slash-token {
		color: var(--text-accent, var(--interactive-accent));
		font-family: var(--font-monospace);
		font-weight: 600;
	}

	.ratel-slash-token--skill {
		color: var(--color-purple, #7c5cbf);
	}

	.ratel-skill-installed {
		margin-left: 6px;
		font-size: 10px;
		line-height: 1;
		padding: 2px 5px;
		border-radius: 3px;
		color: var(--color-purple, #7c5cbf);
		background: color-mix(in srgb, var(--color-purple, #7c5cbf) 16%, transparent);
		vertical-align: 1px;
	}

	.ratel-text-assistant {
		color: var(--text-normal);
	}
</style>
