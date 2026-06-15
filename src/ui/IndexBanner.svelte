<!--
  @file src/ui/IndexBanner.svelte
  @description 索引状态 banner — 订阅 IndexManager.status$,Scanning/Queueing/Paused/Failed 时显示
  @module ui/IndexBanner
  @depends svelte/store, core/index-manager
-->
<script lang="ts">
    import type { Readable } from 'svelte/store';
    import type { IndexStatus } from '../core/index-manager';

    export let status$: Readable<IndexStatus>;

    $: status = $status$;
    $: visible = ['Scanning', 'Queueing', 'Paused', 'Failed'].includes(status.state);
    $: message = formatMessage(status);

    function formatMessage(s: IndexStatus): string {
        switch (s.state) {
            case 'Scanning': return `正在索引 ${s.scanned}/${s.total}…`;
            case 'Queueing': return `有 ${s.pending} 个文件待索引`;
            case 'Paused': return `索引已暂停(${s.pending} 待处理)`;
            case 'Failed': return `索引失败:${s.reason}`;
            default: return '';
        }
    }
</script>

{#if visible}
    <div class="ratel-index-banner" data-state={status.state}>
        {message}
    </div>
{/if}

<style>
    .ratel-index-banner {
        padding: 4px 8px;
        font-size: 0.85em;
        background: var(--background-secondary);
        border-bottom: 1px solid var(--background-modifier-border);
    }
    .ratel-index-banner[data-state='Failed'] {
        background: var(--background-modifier-error);
        color: var(--text-error);
    }
</style>
