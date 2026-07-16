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
	}: {
		expanded: boolean;
		status$: Readable<UserStatusSnapshot>;
		contextUsage$: Readable<ContextUsage>;
		embedKind: 'local' | 'api';
		onCompact: () => void;
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
		max-height: 360px;
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
</style>
