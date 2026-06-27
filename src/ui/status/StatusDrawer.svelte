<script lang="ts">
	/**
	 * @file src/ui/StatusDrawer.svelte
	 * @description 展开式详情面板 — 向量化/索引区 + 上下文区(max-height 过渡)
	 * @module ui/StatusDrawer
	 * @depends svelte/store, user-feedback/user-status
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot, ContextUsage, PendingAttachment } from '../../user-feedback/user-status';

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
		if (snap.indexDocCount != null && snap.index === 'ready') {
			lbl += ` (${snap.indexDocCount} 篇)`;
		} else if (snap.indexDetail && /^\d+\/\d+$/.test(snap.indexDetail)) {
			lbl += ` ${snap.indexDetail}`;
		}
		return lbl;
	});

	const attachmentTokens = $derived(attachments.reduce((sum, a) => sum + a.estimatedTokens, 0));

	const currentFile = $derived.by(() => {
		if (snap.index === 'processing' && snap.indexDetail) {
			if (!/^\d+\/\d+$/.test(snap.indexDetail) && !snap.indexDetail.includes('待')) {
				return snap.indexDetail;
			}
		}
		return null;
	});
</script>

<div class="ratel-drawer" class:ratel-drawer-open={expanded}>
	<div class="ratel-drawer-inner">
		<div class="ratel-drawer-section-title">向量化 / 索引</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">索引</span>
			<span class="ratel-drawer-value">{indexValue}</span>
		</div>
		{#if snap.index === 'scanning' || snap.index === 'processing' || snap.index === 'queueing'}
			<div class="ratel-drawer-progress">
				<div class="ratel-drawer-progress-fill" style={`width: ${indexProgress}%; background: ${indexBarColor};`}></div>
			</div>
		{/if}
		{#if currentFile}
			<div class="ratel-drawer-row">
				<span class="ratel-drawer-label">当前文件</span>
				<span class="ratel-drawer-value ratel-drawer-mono">{currentFile}</span>
			</div>
		{/if}
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">Embedding</span>
			<span class="ratel-drawer-value">{labelEmbedding(snap.embedding)}</span>
		</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">运行模式</span>
			<span class="ratel-drawer-pill ratel-drawer-pill-warn">{snap.worker === 'inline' ? '内联' : 'Worker'}</span>
		</div>
		{#if snap.degraded}
			<div class="ratel-drawer-degraded">
				<span class="ratel-drawer-degraded-icon">⚠</span>
				<span>{snap.degraded}</span>
			</div>
		{/if}

		<div class="ratel-drawer-section-title">上下文</div>
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
		<div class="ratel-drawer-row ratel-drawer-row-end">
			<button class="ratel-drawer-micro-btn" type="button" onclick={onCompact}>压缩上下文</button>
		</div>
	</div>
</div>

<style>
	.ratel-drawer {
		max-height: 0;
		overflow: hidden;
		background: var(--background-secondary);
		border-top: 1px solid var(--background-modifier-border);
		transition: max-height 0.25s ease;
		flex-shrink: 0;
	}

	.ratel-drawer-open {
		max-height: 380px;
		overflow-y: auto;
	}

	.ratel-drawer-inner {
		padding: 12px 14px 14px;
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.ratel-drawer-section-title {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--text-faint);
		margin-top: 10px;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--background-modifier-border);
		margin-bottom: 6px;
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

	/* 药丸徽章 — mockup: 圆角胶囊,轻量底色,彩色字 */
	.ratel-drawer-pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 1px 8px;
		border-radius: 10px;
		font-size: 11px;
		font-weight: 500;
	}

	.ratel-drawer-pill-warn {
		color: var(--text-warning);
		/* 关键路径:对齐 mockup hint-pill 黄色淡背景,禁止硬编码 */
		background: color-mix(in srgb, var(--text-warning) 12%, transparent);
	}

	/* 降级提示 — mockup: 红色淡背景 + 红字,无边框 */
	.ratel-drawer-degraded {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--text-error) 10%, transparent);
		color: var(--text-error);
		font-size: 11.5px;
		line-height: 1.4;
		display: flex;
		gap: 6px;
		align-items: flex-start;
	}

	.ratel-drawer-degraded-icon {
		flex-shrink: 0;
		line-height: 1.5;
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
</style>
