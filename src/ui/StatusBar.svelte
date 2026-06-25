<script lang="ts">
	/**
	 * @file src/ui/StatusBar.svelte
	 * @description Chat 侧栏持久状态条 — 订阅 userStatus.statusBar$,全就绪时折叠单行摘要
	 * @module ui/StatusBar
	 * @depends svelte/store, user-feedback/user-status
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot } from '../user-feedback/user-status';

	export let status$: Readable<UserStatusSnapshot>;

	$: snap = $status$;
	$: expanded =
		snap.model !== 'ready' ||
		snap.index !== 'ready' ||
		snap.embedding !== 'ready' ||
		!!snap.degraded;
	$: tone = computeTone(snap);
	$: workerTag = snap.worker === 'inline' ? ' · 内联' : '';
	$: summary = `模型${labelModel(snap)} · 索引${snap.indexDocCount ?? 0} 篇 · Embedding${labelEmbedding(snap.embedding)}${workerTag}`;

	/**
	 * 根据快照判定状态条色调 — 绿(就绪)、黄(进行中/降级)、红(失败)。
	 *
	 * @param s - 当前 UserStatus 快照
	 * @returns 供 data-tone 使用的色调标识
	 */
	function computeTone(s: UserStatusSnapshot): 'ready' | 'warning' | 'error' {
		if (s.model === 'failed' || s.index === 'failed') return 'error';
		if (
			s.model !== 'ready' ||
			s.index !== 'ready' ||
			s.embedding !== 'ready' ||
			s.degraded
		) {
			return 'warning';
		}
		return 'ready';
	}

	/**
	 * 将模型子状态映射为中文短标签。
	 *
	 * @param s - 当前 UserStatus 快照
	 * @returns 面向用户的状态文案
	 */
	function labelModel(s: UserStatusSnapshot): string {
		switch (s.model) {
			case 'ready':
				return '就绪';
			case 'downloading':
				return `下载中${s.modelDetail ? ` ${s.modelDetail}` : ''}`;
			case 'failed':
				return '失败';
			case 'checking':
				return '检查中';
			case 'initializing':
				return '初始化中';
			case 'idle':
				return '空闲';
			default:
				return '…';
		}
	}

	/**
	 * 将索引子状态映射为中文短标签。
	 *
	 * @param index - 索引状态枚举
	 * @returns 面向用户的状态文案
	 */
	function labelIndex(index: UserStatusSnapshot['index']): string {
		switch (index) {
			case 'ready':
				return '就绪';
			case 'scanning':
				return '扫描中';
			case 'queueing':
				return '排队中';
			case 'processing':
				return '处理中';
			case 'paused':
				return '已暂停';
			case 'failed':
				return '失败';
			case 'init':
				return '初始化';
			case 'idle':
				return '空闲';
			default:
				return '…';
		}
	}

	/**
	 * 将 Embedding 子状态映射为中文短标签。
	 *
	 * @param embedding - Embedding 状态枚举
	 * @returns 面向用户的状态文案
	 */
	function labelEmbedding(embedding: UserStatusSnapshot['embedding']): string {
		switch (embedding) {
			case 'ready':
				return '就绪';
			case 'loading':
				return '加载中';
			case 'unavailable':
				return '不可用';
			default:
				return '…';
		}
	}
</script>

<div class="ratel-status-bar" data-expanded={expanded} data-tone={tone}>
	{#if expanded}
		<div>模型: {labelModel(snap)}{snap.modelDetail && snap.model !== 'downloading' ? ` — ${snap.modelDetail}` : ''}</div>
		<div>索引: {labelIndex(snap.index)}{snap.indexDetail ? ` (${snap.indexDetail})` : ''}{snap.indexDocCount != null && snap.index === 'ready' ? ` · ${snap.indexDocCount} 篇` : ''}</div>
		<div>Embedding: {labelEmbedding(snap.embedding)}</div>
		{#if snap.worker === 'inline'}
			<div class="ratel-status-degraded">运行模式: 主线程内联(大库索引较慢)</div>
		{/if}
		{#if snap.degraded}
			<div class="ratel-status-degraded">{snap.degraded}</div>
		{/if}
	{:else}
		<div>{summary}</div>
	{/if}
</div>

<style>
	.ratel-status-bar {
		padding: 4px 8px;
		font-size: 0.85em;
		border-bottom: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		color: var(--text-normal);
	}

	.ratel-status-bar[data-tone='ready'] {
		background: var(--background-modifier-success, rgba(46, 160, 67, 0.12));
		color: var(--text-success, var(--text-normal));
	}

	.ratel-status-bar[data-tone='warning'] {
		background: var(--background-modifier-border-hover, rgba(210, 153, 34, 0.15));
		color: var(--text-warning, var(--text-muted));
	}

	.ratel-status-bar[data-tone='error'] {
		background: var(--background-modifier-error);
		color: var(--text-error);
	}

	.ratel-status-degraded {
		margin-top: 2px;
		font-style: italic;
	}
</style>
