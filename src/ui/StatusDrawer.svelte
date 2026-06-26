<script lang="ts">
	/**
	 * @file src/ui/StatusDrawer.svelte
	 * @description 展开式详情面板 — 向量化/索引区 + 上下文区
	 * @module ui/StatusDrawer
	 * @depends svelte/store, user-feedback/user-status
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot, ContextUsage, PendingAttachment } from '../user-feedback/user-status';

	let {
		expanded,
		status$,
		contextUsage$,
		pendingAttachments$,
		onCompact,
	}: {
		expanded: boolean;
		status$: Readable<UserStatusSnapshot>;
		contextUsage$: Readable<ContextUsage>;
		pendingAttachments$: Readable<PendingAttachment[]>;
		onCompact: () => void;
	} = $props();

	const snap = $derived($status$);
	const usage = $derived($contextUsage$);
	const attachments = $derived($pendingAttachments$);

	// 索引区文字映射(原 StatusBar.svelte 已删除,逻辑迁入此处)
	function labelIndex(index: UserStatusSnapshot['index']): string {
		switch (index) {
			case 'ready': return '就绪';
			case 'scanning': return '扫描中';
			case 'queueing': return '排队中';
			case 'processing': return '处理中';
			case 'paused': return '已暂停';
			case 'failed': return '失败';
			case 'init': return '初始化';
			case 'idle': return '空闲';
			default: return '…';
		}
	}

	function labelEmbedding(embedding: UserStatusSnapshot['embedding']): string {
		switch (embedding) {
			case 'ready': return '就绪';
			case 'loading': return '加载中';
			case 'unavailable': return '未配置';
			default: return '…';
		}
	}

	// 索引进度条颜色:处理中黄,就绪绿,其他灰
	const indexBarColor = $derived(
		snap.index === 'processing' || snap.index === 'scanning' || snap.index === 'queueing'
			? 'var(--text-warning)'
			: snap.index === 'ready'
				? 'var(--text-success)'
				: 'var(--text-muted)',
	);

	// 附件 token 汇总
	const attachmentTokens = $derived(
		attachments.reduce((sum, a) => sum + a.estimatedTokens, 0),
	);
</script>

<div class="ratel-status-drawer" data-expanded={expanded}>
	<!-- ==================== 区域 1:向量化 / 索引 ==================== -->
	<div class="ratel-drawer-section">
		<div class="ratel-drawer-title">向量化 / 索引</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">索引</span>
			<span class="ratel-drawer-value">{labelIndex(snap.index)}{snap.indexDetail ? ` (${snap.indexDetail})` : ''}{snap.indexDocCount != null && snap.index === 'ready' ? ` · ${snap.indexDocCount} 篇` : ''}</span>
		</div>
		<div class="ratel-drawer-row">
			<div class="ratel-drawer-progress">
				<div class="ratel-drawer-progress-fill" style="background: {indexBarColor};"></div>
			</div>
		</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">Embedding</span>
			<span class="ratel-drawer-value">{labelEmbedding(snap.embedding)}</span>
		</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">运行模式</span>
			<span class="ratel-drawer-hint-pill">{snap.worker === 'inline' ? '内联' : 'Worker'}</span>
		</div>
		{#if snap.degraded}
			<div class="ratel-drawer-degraded">⚠ {snap.degraded}</div>
		{/if}
	</div>

	<!-- ==================== 区域 2:上下文 ==================== -->
	<div class="ratel-drawer-section">
		<div class="ratel-drawer-title">上下文</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">已用 / 上限</span>
			<span class="ratel-drawer-value ratel-drawer-mono">{usage.usedTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} tokens</span>
		</div>
		{#if attachments.length > 0}
			<div class="ratel-drawer-row">
				<span class="ratel-drawer-label">附件</span>
				<span class="ratel-drawer-value">{attachments.length} 张图片 (估 {attachmentTokens} tokens)</span>
			</div>
		{/if}
		<div class="ratel-drawer-row ratel-drawer-row-action">
			<button class="ratel-drawer-compact-btn" type="button" onclick={onCompact}>压缩上下文</button>
		</div>
	</div>
</div>

<style>
	.ratel-status-drawer {
		max-height: 0;
		overflow: hidden;
		transition: max-height 0.25s ease;
		background: var(--background-secondary);
		border-bottom: 1px solid var(--background-modifier-border);
		flex-shrink: 0;
	}

	.ratel-status-drawer[data-expanded='true'] {
		max-height: 380px;
		overflow-y: auto;
	}

	.ratel-drawer-section {
		padding: 8px 12px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.ratel-drawer-section:last-child {
		border-bottom: none;
	}

	.ratel-drawer-title {
		font-size: 10px;
		text-transform: uppercase;
		color: var(--text-muted);
		padding-bottom: 4px;
		border-bottom: 1px solid var(--background-modifier-border);
		margin-bottom: 6px;
		letter-spacing: 0.05em;
	}

	.ratel-drawer-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 3px 0;
		font-size: 0.85em;
	}

	.ratel-drawer-label {
		color: var(--text-muted);
	}

	.ratel-drawer-value {
		color: var(--text-normal);
	}

	.ratel-drawer-mono {
		font-family: var(--font-monospace);
		font-size: 0.9em;
	}

	.ratel-drawer-progress {
		width: 100%;
		height: 4px;
		background: var(--background-modifier-border);
		border-radius: 2px;
		overflow: hidden;
		margin: 4px 0;
	}

	.ratel-drawer-progress-fill {
		height: 100%;
		width: 100%;
		transition: background 0.2s ease;
	}

	.ratel-drawer-hint-pill {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 4px;
		background: var(--background-modifier-form-field);
		color: var(--text-normal);
		font-size: 0.85em;
	}

	.ratel-drawer-degraded {
		margin-top: 6px;
		padding: 4px 8px;
		font-size: 0.8em;
		color: var(--text-warning);
		font-style: italic;
	}

	.ratel-drawer-row-action {
		justify-content: flex-end;
		margin-top: 6px;
	}

	.ratel-drawer-compact-btn {
		padding: 3px 10px;
		border-radius: 4px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-modifier-form-field);
		color: var(--text-normal);
		font-size: 0.8em;
		cursor: pointer;
	}

	.ratel-drawer-compact-btn:hover {
		border-color: var(--interactive-accent);
	}
</style>
