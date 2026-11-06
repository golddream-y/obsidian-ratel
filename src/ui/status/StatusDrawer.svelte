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
	import { indexProgressView } from './index-progress';

	let {
		expanded,
		status$,
		contextUsage$,
		embedKind,
		onCompact,
		onFeedback,
		onMemory,
		onGoal,
		onMcp,
		onSkill,
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
		/** 目标管理入口(可选,S-GOAL v1.7) */
		onGoal?: () => void;
		/** MCP 管理入口(可选) */
		onMcp?: () => void;
		/** 技能管理入口(可选,S-SKILL-UX) */
		onSkill?: () => void;
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

	// 关键路径:阶段与须知是 T4/T5/T6 新增的展示面 —— 停滞/正在停止/迁移不改变 index 状态语义,
	// 但必须可见,否则用户会把停滞看成「正在索引」。
	function labelPhase(phase: UserStatusSnapshot['indexPhase']): string | undefined {
		switch (phase) {
			case 'stalled': return $t('status.phase.stalled');
			case 'stopping': return $t('status.phase.stopping');
			case 'migrating': return $t('status.phase.migrating');
			case 'scanning': return $t('status.indexLabel.scanning');
			case 'processing': return $t('status.indexLabel.processing');
			case 'paused': return $t('status.indexLabel.paused');
			case 'ready': return $t('status.indexLabel.ready');
			case 'failed':
			case 'partial-failure': return $t('status.indexLabel.failed');
			default: return undefined;
		}
	}

	function labelNotice(notice: UserStatusSnapshot['indexNotice']): string | undefined {
		switch (notice) {
			case 'stalled': return $t('status.detail.stalled');
			case 'resumed': return $t('status.detail.resumed');
			case 'stopping': return $t('status.detail.stopping');
			case 'migrating': return $t('status.detail.migrating');
			case 'disk-failure': return $t('status.detail.diskFailure');
			case 'epoch-missing': return $t('status.detail.epochMissing');
			case 'records-unknown': return $t('status.detail.recordsUnknown');
			case 'config-mismatch': return $t('status.detail.configMismatch');
			// 关键路径(T7/I2/T6):降级与配置漂移都必须可见,不允许静默
			case 'index-unavailable': return $t('status.detail.indexUnavailable');
			case 'config-drift': return $t('status.detail.configDrift');
			default: return undefined;
		}
	}

	/**
	 * 迁移/回收结论面的诊断行(T7/I4)。
	 *
	 * 关键路径:只在真的有结论面(发生过迁移或新建前回收)时出现;枚举与布尔值用语言中立的记号,
	 * 不引入第二套用户文案。落点只放结论,不含笔记正文、路径清单或密钥。
	 */
	const indexDiagnosticsText = $derived.by(() => {
		const diag = snap.indexDiagnostics;
		if (!diag || (!diag.migration && !diag.reconcile)) return undefined;
		return $t('status.drawer.indexDiagnostics.value', {
			phase: diag.migration?.phase ?? '—',
			reused: diag.migration?.reused ?? 0,
			reindex: diag.migration?.reindex ?? 0,
			persisted: (diag.migration?.statePersisted ?? true) ? '✓' : '✗',
			orphans: diag.reconcile?.orphanDirectories ?? 0,
			quarantineTx: diag.reconcile?.quarantinedTransactions ?? 0,
			blocked: diag.reconcile?.blocked === true ? (diag.reconcile.blockedReason ?? 'blocked') : '—',
			quarantined: diag.quarantinedGenerations.length > 0 ? diag.quarantinedGenerations.join(', ') : '—',
		});
	});

	const progress = $derived(indexProgressView(snap));
	// 错误和暂停优先于阶段；正常运行只保留一个主状态，避免排队中/处理中并列。
	const indexValue = $derived(
		snap.index === 'failed' || snap.index === 'paused'
			? labelIndex(snap.index)
			: labelPhase(snap.indexPhase) ?? labelIndex(snap.index),
	);
	const indexing = $derived(['scanning', 'processing', 'queueing', 'diffing', 'init'].includes(snap.index));

	const indexNoticeText = $derived.by(() => {
		const notice = labelNotice(snap.indexNotice);
		if (notice !== undefined) return notice;
		if (snap.index === 'failed' && snap.indexDetail) return snap.indexDetail;
		// 关键路径:部分可用没有被宣告为 ready,但已有可检索版本,必须说明而不是只显示进度。
		if (snap.indexPartial === true) return $t('status.drawer.searchAvailable');
		// 关键路径:「正在生成向量并写入索引」会持续较长时间,必须说清这段在做什么、
		// 以及已有结果是否可用,否则用户只能看到一个长时间不动的状态标签。
		if (snap.index === 'processing') return $t('status.detail.embeddingWriting');
		return undefined;
	});

	const indexBarColor = $derived.by(() => {
		const idx = snap.index;
		if (snap.indexPhase === 'stalled' || snap.indexPhase === 'stopping') return 'var(--text-warning)';
		if (idx === 'failed') return 'var(--text-error)';
		if (idx === 'processing' || idx === 'scanning' || idx === 'queueing') return 'var(--interactive-accent)';
		if (idx === 'ready') return 'var(--text-success)';
		return 'var(--text-muted)';
	});

	const ctxPct = $derived(clampContextPct(usage.percentage));


</script>

{#snippet indexCount()}
	{#if progress.total > 0}
		<span class="ratel-index-count">{$t('status.drawer.indexedCount', { count: progress.completed, total: progress.total })}</span>
	{/if}
{/snippet}

<div class="ratel-drawer" class:ratel-drawer-open={expanded}>
	<div class="ratel-drawer-inner">
		<div class="ratel-drawer-section-title ratel-drawer-section-title--with-aside">
			<span>{$t('status.drawer.section.index')}</span>
			<span class="ratel-embed-badge" title={$t('status.drawer.label.embedding')}>
				{embedKind === 'api' ? $t('status.drawer.embedBadge.api') : $t('status.drawer.embedBadge.local')}
			</span>
		</div>
		<!-- 关键路径(2026-11-06):ready 时顶部状态栏已显示「就绪」,抽屉不再重复;
		     完成的语义由满格进度条与计数表达。计数在 ready 时靠左占据主数据位,
		     避免左半边全空导致版面发虚。 -->
		{#if snap.index !== 'ready' || progress.total > 0}
		<div class="ratel-index-heading">
			{#if snap.index === 'ready'}
				{@render indexCount()}
			{:else}
				<span class="ratel-index-state">{indexValue}</span>
				<span class="ratel-index-aside">
					{@render indexCount()}
					{#if snap.indexSecondsPerBlock !== undefined && indexing}
						<span class="ratel-index-rate">{$t('status.drawer.indexSecondsPerBlock', { seconds: snap.indexSecondsPerBlock })}</span>
					{/if}
				</span>
			{/if}
		</div>
		{/if}
		{#if (indexing || snap.index === 'paused' || snap.index === 'failed' || snap.index === 'ready') && progress.total > 0}
			<div class="ratel-drawer-progress" role="progressbar"
				aria-label={$t('status.drawer.label.index')}
				aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage ?? undefined}>
				<div class="ratel-drawer-progress-fill" class:ratel-progress-unknown={progress.percentage === null && indexing}
					style={`width: ${progress.percentage ?? (indexing ? 28 : 0)}%; background: ${indexBarColor};`}></div>
			</div>
		{/if}
		{#if progress.total === 0 || progress.failed > 0}
			<!-- 关键路径(2026-11-06 版面收敛):「已完成 X%」「剩余 X 篇」与标题的
			     「8 / 97 篇」是同一份数据的三次重复表达;比例交给进度条,其余不再写文字。
			     失败为 0 时不占位,只有真失败才提示。 -->
			<div class="ratel-index-metrics">
				{#if progress.total === 0}<span>{$t('status.drawer.totalUnknown')}</span>{/if}
				{#if progress.failed > 0}
					<span class="ratel-index-failed">{$t('status.drawer.failedCount', { count: progress.failed })}</span>
				{/if}
			</div>
		{/if}
		{#if indexNoticeText}
			<p class="ratel-index-notice" class:ratel-index-warning={snap.indexNotice !== undefined}>{indexNoticeText}</p>
		{/if}
		{#if indexDiagnosticsText}
			<details class="ratel-index-diagnostics">
				<summary>{$t('status.drawer.label.indexDiagnostics')}</summary>
				<p>{indexDiagnosticsText}</p>
			</details>
		{/if}
		<div class="ratel-drawer-section-title ratel-drawer-section-title--with-aside">
			<span>{$t('status.drawer.section.context')}</span>
			<button class="ratel-drawer-micro-btn ratel-drawer-micro-btn--inline" type="button" onclick={onCompact}>
				{$t('status.drawer.compactButton')}
			</button>
		</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">{$t('status.drawer.label.usedMax')}</span>
			<span class="ratel-drawer-value ratel-drawer-mono">
				{usage.usedTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} tokens
				· {usage.source === 'api' ? $t('status.drawer.contextSource.api') : $t('status.drawer.contextSource.estimate')}
			</span>
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
		{#if onFeedback || onMemory || onGoal || onMcp || onSkill || onSponsor}
			<!-- 左功能(目标/记忆/MCP) · 右反馈类(反馈/赞助);无 aria-label,避免 Obsidian「相关操作」提示 -->
			<nav class="ratel-drawer-actions">
				{#if onGoal}
					<button type="button" class="ratel-drawer-action" onclick={onGoal}>
						<svg class="ratel-drawer-action-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
							<circle
								cx="12"
								cy="12"
								r="7.25"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
							/>
							<circle cx="12" cy="12" r="2.4" fill="currentColor" />
						</svg>
						<span>{$t('status.drawer.goal')}</span>
					</button>
				{/if}
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
				{#if onSkill}
					<button type="button" class="ratel-drawer-action" onclick={onSkill}>
						<svg class="ratel-drawer-action-ico" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
							<path
								d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"
								fill="none"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linejoin="round"
							/>
						</svg>
						<span>{$t('status.drawer.skill')}</span>
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

	/* 层次 1/3:分组标签 — 最弱,靠细线与上间距划分区块,不与主状态争夺注意力。 */
	.ratel-drawer-section-title {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		/* 关键路径:行高固定,不让右侧按钮/数值决定行高 —— 否则同一 class 的
		   两个分组标题会因右侧元素不同而高度不同,视觉上显得字号不等。 */
		min-height: 16px;
		font-size: 11px;
		font-weight: 500;
		letter-spacing: 0.4px;
		color: var(--text-muted);
		margin-top: 10px;
		padding: 0 0 5px;
		border-bottom: 1px solid var(--background-modifier-border);
	}

	.ratel-drawer-section-title:first-child {
		margin-top: 0;
	}

	/* 关键路径:嵌入来源放在分组标题右侧,不再单独占一行;badge 用边框+背景明确
	   它是一个可识别的标识,而不是一行灰色弱文字。 */
	/* 标题内文字显式声明,避免继承漂移。 */
	.ratel-drawer-section-title > span:first-child {
		font-size: 11px;
		font-weight: 500;
		color: var(--text-muted);
	}
	/* 关键路径:这里是**只读信息**,不是可点控件。边框 + 背景会把它画成按钮,
	   与真正的操作控件(压缩上下文)混淆;因此只保留弱化文字,不用任何控件外观。 */
	.ratel-embed-badge {
		font-size: 11px;
		font-weight: 400;
		letter-spacing: 0;
		color: var(--text-faint);
		white-space: nowrap;
	}
	/* 标题行内的操作按钮 — 比常规微按钮更小,不撑高分组标题。 */
	.ratel-drawer-micro-btn--inline {
		flex-shrink: 0;
		padding: 0 6px;
		height: 16px;
		line-height: 14px;
		font-size: 11px;
	}
	.ratel-index-rate {
		font-size: 11px;
		font-weight: 400;
		color: var(--text-normal);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* 层次 2/3:主状态 + 唯一计数 — 该区唯一的强权重行。 */
	.ratel-index-heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 4px 12px;
		padding: 8px 0 6px;
	}

	.ratel-index-state {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-normal);
	}
	/* 右侧数值组 — 无主状态文字时（ready）仍靠右对齐。 */
	.ratel-index-aside {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin-left: auto;
	}
	/* 数据值统一规格 — 索引计数、速率、tokens 同号同色同字重。
	   标签(faint)与标题(muted/500)都比它弱,保证"数值是这一区最亮的信息"。 */
	.ratel-index-count {
		font-size: 11px;
		font-weight: 400;
		color: var(--text-normal);
		font-variant-numeric: tabular-nums;
	}
	.ratel-index-metrics {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		padding: 4px 0 8px;
		font-size: 11px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.ratel-index-failed { color: var(--text-error); }
	/* 层次 3/3:辅助说明 — 左侧细线 + 缩进表明「这是主状态的注解」,不与属性行齐平。 */
	.ratel-index-notice {
		margin: 0 0 10px;
		padding-left: 8px;
		border-left: 2px solid var(--background-modifier-border);
		font-size: 11px;
		line-height: 1.5;
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.ratel-index-warning { color: var(--text-warning); }
	.ratel-index-diagnostics { margin: 4px 0 10px; font-size: 11px; color: var(--text-muted); }
	.ratel-index-diagnostics summary { cursor: pointer; }
	.ratel-index-diagnostics p { line-height: 1.6; overflow-wrap: anywhere; }
	.ratel-progress-unknown { animation: ratel-index-indeterminate 1.6s ease-in-out infinite alternate; }
	@keyframes ratel-index-indeterminate { from { transform: translateX(0); } to { transform: translateX(250%); } }
	@media (prefers-reduced-motion: reduce) { .ratel-progress-unknown { animation: none; } }

	.ratel-drawer-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 11px;
		padding: 3px 0;
		gap: 12px;
	}

	.ratel-drawer-label {
		font-size: 11px;
		color: var(--text-faint);
		flex-shrink: 0;
	}

	.ratel-drawer-value {
		color: var(--text-normal);
		font-weight: 400;
		text-align: right;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-drawer-mono {
		font-family: var(--font-monospace);
		font-size: 11px;
		font-weight: 400;
		color: var(--text-normal);
		max-width: 65%;
		font-variant-numeric: tabular-nums;
	}

	/* 关键路径:索引与上下文两条进度条共用同一组值,避免视觉节奏不一致。 */
	.ratel-drawer-progress,
	.ratel-drawer-meter {
		width: 100%;
		height: 4px;
		background: var(--background-modifier-border);
		border-radius: 2px;
		overflow: hidden;
		margin: 4px 0;
	}

	.ratel-drawer-progress-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.3s;
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
		font-size: 11px;
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
