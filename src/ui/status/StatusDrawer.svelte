<script lang="ts">
	/**
	 * @file src/ui/status/StatusDrawer.svelte
	 * @description 展开式详情面板 — 向量化/索引区 + 上下文区(max-height 过渡)
	 * @module ui/status/StatusDrawer
	 * @depends svelte/store, user-feedback/user-status
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot, ContextUsage } from '../../user-feedback/user-status';
	import { t } from '../../i18n';
	import { clampContextPct } from './strip-label';

	let {
		expanded,
		status$,
		contextUsage$,
		embedKind,
		onCompact,
		onFeedback,
		onMemory,
		onMcp,
		onSponsor,
	}: {
		expanded: boolean;
		status$: Readable<UserStatusSnapshot>;
		contextUsage$: Readable<ContextUsage>;
		embedKind: 'local' | 'api';
		onCompact: () => void;
		/** 问题反馈入口(可选) */
		onFeedback?: () => void;
		/** 记忆管理入口(可选) */
		onMemory?: () => void;
		/** MCP 管理入口(可选) */
		onMcp?: () => void;
		/** 赞助页入口(可选);按界面语言打开对应文档 */
		onSponsor?: () => void;
	} = $props();

	const snap = $derived($status$);
	const usage = $derived($contextUsage$);

	function labelIndex(index: UserStatusSnapshot['index']): string {
		switch (index) {
			case 'ready': return $t('status.indexLabel.ready');
			case 'scanning': return $t('status.indexLabel.scanning');
			case 'queueing': return $t('status.indexLabel.queued');
			case 'processing': return $t('status.indexLabel.processing');
			case 'paused': return $t('status.indexLabel.paused');
			case 'failed': return $t('status.indexLabel.failed');
			case 'init': return $t('status.indexLabel.initializing');
			case 'diffing': return $t('status.indexLabel.checkingChanges');
			case 'idle': return $t('status.indexLabel.idle');
			default: return $t('status.indexLabel.unknown');
		}
	}

	function labelEmbedding(embedding: UserStatusSnapshot['embedding']): string {
		switch (embedding) {
			case 'ready': return $t('status.embedding.ready');
			case 'loading': return $t('status.embedding.loading');
			case 'unavailable': return $t('status.embedding.notConfigured');
			default: return $t('status.embedding.unknown');
		}
	}

	const indexBarColor = $derived.by(() => {
		const idx = snap.index;
		if (idx === 'processing' || idx === 'scanning' || idx === 'queueing') return 'var(--text-warning)';
		if (idx === 'ready') return 'var(--text-success)';
		return 'var(--text-muted)';
	});

	const indexProgress = $derived.by(() => {
		const detail = snap.indexDetail;
		if (!detail) return snap.index === 'ready' ? 100 : 0;
		const m = detail.match(/(\d+)\/(\d+)/);
		if (m) return Math.round((parseInt(m[1]!) / parseInt(m[2]!)) * 100);
		return snap.index === 'ready' ? 100 : 0;
	});

	const indexValue = $derived.by(() => {
		let lbl = labelIndex(snap.index);
		// 修复:0 篇时不拼括号,避免「就绪 (0 篇)」看起来像异常
		if (snap.indexDocCount != null && snap.indexDocCount > 0 && snap.index === 'ready') {
			lbl += ' ' + $t('status.drawer.docCount', { count: snap.indexDocCount });
		} else if (snap.indexDetail && /^\d+\/\d+$/.test(snap.indexDetail)) {
			lbl += ` ${snap.indexDetail}`;
		}
		return lbl;
	});

	const ctxPct = $derived(clampContextPct(usage.percentage));

	const currentFile = $derived.by(() => {
		if (snap.index === 'processing' && snap.indexDetail) {
			// 关键路径:排除进度格式("数字/数字")和 pending 消息("数字 + 空格 + 文字"),
			// 剩余的视为当前文件名。文件名通常不以数字开头。不依赖具体语言匹配。
			if (/^\d+\/\d+$/.test(snap.indexDetail)) return null;
			if (/^\d+\s/.test(snap.indexDetail)) return null;
			return snap.indexDetail;
		}
		return null;
	});
</script>

<div class="ratel-drawer" class:ratel-drawer-open={expanded}>
	<div class="ratel-drawer-inner">
		<div class="ratel-drawer-section-title">{$t('status.drawer.section.index')}</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">{$t('status.drawer.label.index')}</span>
			<span class="ratel-drawer-value">{indexValue}</span>
		</div>
		{#if snap.index === 'scanning' || snap.index === 'processing' || snap.index === 'queueing'}
			<div class="ratel-drawer-progress">
				<div class="ratel-drawer-progress-fill" style={`width: ${indexProgress}%; background: ${indexBarColor};`}></div>
			</div>
		{/if}
		{#if currentFile}
			<div class="ratel-drawer-row">
				<span class="ratel-drawer-label">{$t('status.drawer.label.currentFile')}</span>
				<span class="ratel-drawer-value ratel-drawer-mono">{currentFile}</span>
			</div>
		{/if}
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">{$t('status.drawer.label.embedding')}</span>
			<span class="ratel-drawer-value">{labelEmbedding(snap.embedding)}</span>
		</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">{$t('status.drawer.label.embedKind')}</span>
			<span class="ratel-drawer-value">
				{embedKind === 'api' ? $t('status.drawer.embedKind.api') : $t('status.drawer.embedKind.local')}
			</span>
		</div>
		<div class="ratel-drawer-section-title">{$t('status.drawer.section.context')}</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">{$t('status.drawer.label.usedMax')}</span>
			<span class="ratel-drawer-value ratel-drawer-mono">{usage.usedTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} tokens</span>
		</div>
		<div
			class="ratel-drawer-meter"
			role="progressbar"
			aria-valuenow={ctxPct}
			aria-valuemin={0}
			aria-valuemax={100}
		>
			<div class="ratel-drawer-meter-fill" style={`width: ${ctxPct}%;`}></div>
		</div>
		<div class="ratel-drawer-row ratel-drawer-row-end">
			<button class="ratel-drawer-micro-btn" type="button" onclick={onCompact}>{$t('status.drawer.compactButton')}</button>
		</div>
		{#if onFeedback || onMemory || onMcp || onSponsor}
			<!-- 左功能(记忆/MCP) · 右反馈类(反馈/赞助);无 aria-label,避免 Obsidian「相关操作」提示 -->
			<nav class="ratel-drawer-actions">
				{#if onMemory}
					<button type="button" class="ratel-drawer-action" onclick={onMemory}>
						<svg class="ratel-drawer-action-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
							<path
								d="M6 4.5h9.5A2.5 2.5 0 0 1 18 7v12.2l-3.2-1.6L12 19l-2.8-1.4L6 19.2V7A2.5 2.5 0 0 1 8.5 4.5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linejoin="round"
							/>
						</svg>
						<span>{$t('status.drawer.memory')}</span>
					</button>
				{/if}
				{#if onMcp}
					<button type="button" class="ratel-drawer-action" onclick={onMcp}>
						<svg class="ratel-drawer-action-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
							<path
								d="M4 7.5A2.5 2.5 0 0 1 6.5 5H14l2 2h3.5A2.5 2.5 0 0 1 22 9.5v9A2.5 2.5 0 0 1 19.5 21h-15A2.5 2.5 0 0 1 2 18.5v-11Z"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linejoin="round"
							/>
							<path
								d="M8 10.5h8M8 14h5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linecap="round"
							/>
						</svg>
						<span>{$t('status.drawer.mcp')}</span>
					</button>
				{/if}
				{#if onFeedback}
					<button type="button" class="ratel-drawer-action" onclick={onFeedback}>
						<svg class="ratel-drawer-action-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
							<path
								d="M5 5.5A2.5 2.5 0 0 1 7.5 3h9A2.5 2.5 0 0 1 19 5.5v7A2.5 2.5 0 0 1 16.5 15H12l-3.6 3.2a.6.6 0 0 1-1 .4V15H7.5A2.5 2.5 0 0 1 5 12.5v-7Z"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linejoin="round"
							/>
							<path
								d="M8.5 8h7M8.5 11h4.5"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linecap="round"
							/>
						</svg>
						<span>{$t('status.drawer.feedback')}</span>
					</button>
				{/if}
				{#if onSponsor}
					<button type="button" class="ratel-drawer-action" onclick={onSponsor}>
						<svg class="ratel-drawer-action-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
							<path
								d="M5 8h11.5a2.5 2.5 0 0 1 0 5H16"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
							<path
								d="M5 8v7.5A2.5 2.5 0 0 0 7.5 18H14"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
							<path
								d="M8 8V6.5A1.5 1.5 0 0 1 9.5 5h3A1.5 1.5 0 0 1 14 6.5V8"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linejoin="round"
							/>
						</svg>
						<span>{$t('status.drawer.sponsor')}</span>
					</button>
				{/if}
			</nav>
		{/if}
	</div>
</div>

<style>
	.ratel-drawer {
		max-height: 0;
		overflow: hidden;
		background: var(--background-secondary);
		border-top: 1px solid transparent;
		opacity: 0;
		/* 关键路径:max-height + opacity 同开合,避免硬切;内容区约 280px,留余量防裁切 */
		transition:
			max-height 0.28s cubic-bezier(0.22, 1, 0.36, 1),
			opacity 0.2s ease,
			border-color 0.2s ease;
		flex-shrink: 0;
	}

	.ratel-drawer-open {
		/* 内容区含记忆入口后略增高,留余量防裁切 */
		max-height: 400px;
		overflow-y: auto;
		opacity: 1;
		border-top-color: var(--background-modifier-border);
	}

	.ratel-drawer-inner {
		padding: 12px 14px 14px;
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.ratel-drawer-section-title {
		font-size: 11.5px;
		font-weight: 600;
		letter-spacing: 0.2px;
		color: var(--text-muted);
		margin-top: 2px;
		padding: 6px 0;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.ratel-drawer-section-title:first-child {
		margin-top: 0;
	}

	.ratel-drawer-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 12px;
		padding: 3px 0;
		gap: 12px;
	}

	.ratel-drawer-row-end {
		justify-content: flex-end;
		margin-top: 6px;
	}

	.ratel-drawer-label {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.ratel-drawer-value {
		color: var(--text-normal);
		font-weight: 500;
		text-align: right;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-drawer-mono {
		font-family: var(--font-monospace);
		font-size: 11px;
		font-weight: 400;
		max-width: 65%;
	}

	.ratel-drawer-progress {
		width: 100%;
		height: 4px;
		background: var(--background-modifier-border);
		border-radius: 2px;
		overflow: hidden;
		margin: 4px 0 6px;
	}

	.ratel-drawer-progress-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.3s;
	}

	.ratel-drawer-meter {
		width: 100%;
		height: 4px;
		background: var(--background-modifier-border);
		border-radius: 2px;
		overflow: hidden;
		margin: 6px 0 4px;
	}

	.ratel-drawer-meter-fill {
		height: 100%;
		border-radius: 2px;
		/* 关键路径:默认不改渐变随阈值变红,阈值只作用 Strip 文字(spec §5.7.1) */
		background: linear-gradient(
			90deg,
			var(--ratel-meter-from, var(--interactive-accent)) 0%,
			var(--ratel-meter-to, var(--text-success)) 100%
		);
		transition: width 0.35s ease;
	}

	/* 微按钮 — 强制重置 Obsidian 默认 button 样式 */
	.ratel-drawer-micro-btn {
		padding: 3px 10px;
		border-radius: 4px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-modifier-form-field);
		color: var(--text-muted);
		font-size: 11px;
		font-family: inherit;
		cursor: pointer;
		transition: border-color 0.15s, color 0.15s;
		box-shadow: none;
		-webkit-appearance: none;
		appearance: none;
	}

	.ratel-drawer-micro-btn:hover {
		color: var(--text-normal);
		border-color: var(--text-success);
	}

	.ratel-drawer-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px 18px;
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px solid var(--background-modifier-border);
	}

	/*
	 * 低频入口 — 静默文字链,非按钮皮。
	 * 关键路径:Obsidian 全局 button 带边框/阴影/固定高度,scoped 常被盖住;
	 * 完整重置放 styles.css 的 button.ratel-drawer-action,此处作组件内兜底。
	 */
	.ratel-drawer-action {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: auto;
		min-height: 0;
		padding: 2px 0;
		margin: 0;
		border: none;
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		color: var(--text-muted);
		font-size: 11.5px;
		font-weight: inherit;
		font-family: inherit;
		line-height: 1.45;
		cursor: pointer;
		-webkit-appearance: none;
		appearance: none;
	}

	.ratel-drawer-action-ico {
		flex-shrink: 0;
		opacity: 0.9;
	}

	.ratel-drawer-action:hover {
		color: var(--text-normal);
		background: transparent;
		box-shadow: none;
	}

	.ratel-drawer-action:focus-visible {
		outline: 2px solid var(--interactive-accent);
		outline-offset: 2px;
		border-radius: 2px;
	}
</style>
