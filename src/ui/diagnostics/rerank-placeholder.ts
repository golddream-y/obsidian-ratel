/**
 * @file src/ui/diagnostics/rerank-placeholder.ts
 * @description Rerank 诊断占位区 — Reranker 适配器尚未实现,显示配置状态与提示
 * @module ui/diagnostics/rerank-placeholder
 * @depends obsidian, ../../main, ./diag-utils
 */

import type RatelVaultPlugin from '../../main';
import { hasRerankApiKey, getRerankSecretId } from '../../secrets/ratel-secrets';

/**
 * 渲染 Rerank 占位区。
 *
 * 当前 Reranker 端口与适配器尚未实现,仅展示:
 * - 当前配置摘要(百炼 Base / Model / 钥匙串密钥状态)
 * - 灰态占位提示,说明功能待实现
 * - 预留未来功能的输入区(禁用态)
 */
export function renderRerankPlaceholder(container: HTMLElement, plugin: RatelVaultPlugin): void {
    container.empty();

    // ==================== 配置状态 ====================
    const statusArea = container.createDiv({ cls: 'diag-config-summary' });
    renderRerankStatus(statusArea, plugin);

    // ==================== 占位提示 ====================
    const placeholder = container.createDiv({ cls: 'diag-placeholder' });
    placeholder.createDiv({ cls: 'diag-placeholder-icon', text: '🚧' });
    placeholder.createEl('h3', { text: 'Reranker 测试功能待实现' });
    placeholder.createEl('p', { text: 'Reranker 适配器与端口尚未开发,敬请期待。' });
    placeholder.createEl('p', { attr: { style: 'font-size:12px;' }, text: '计划支持:Cohere / Jina / SiliconFlow / 自定义 OpenAI 兼容端点' });

    // ==================== 预留输入区(禁用态展示未来形态) ====================
    const previewSection = container.createDiv({ cls: 'diag-section', attr: { style: 'opacity: 0.5; pointer-events: none;' } });
    previewSection.createEl('h4', { text: '预览界面(禁用)', attr: { style: 'color: var(--text-faint);' } });

    previewSection.createEl('label', { cls: 'diag-label', text: 'Query' });
    previewSection.createEl('textarea', {
        cls: 'diag-textarea',
        attr: { placeholder: '查询文本...', rows: '2', disabled: 'true' },
    });

    previewSection.createEl('label', { cls: 'diag-label', text: '候选文档(每行一个,粘贴 Embedding 召回的 Top-K 结果)' });
    previewSection.createEl('textarea', {
        cls: 'diag-textarea',
        attr: { placeholder: '候选1\n候选2\n...', rows: '5', disabled: 'true' },
    });

    const btnRow = previewSection.createDiv({ cls: 'diag-row' });
    btnRow.createEl('button', { cls: 'diag-btn', text: 'Rerank', attr: { disabled: 'true' } });

    const resultArea = previewSection.createDiv({ cls: 'diag-result' });
    resultArea.createEl('h4', { text: '重排结果' });
    resultArea.createDiv({ cls: 'diag-result-content diag-result-empty', text: '功能尚未实现' });
}

/**
 * 渲染当前 Reranker 配置状态摘要。
 */
function renderRerankStatus(container: HTMLElement, plugin: RatelVaultPlugin): void {
    const s = plugin.settings;
    const enabled = hasRerankApiKey(plugin.app);

    container.empty();
    container.createSpan({ cls: `diag-status-dot ${enabled ? 'diag-status-ok' : 'diag-status-warn'}` });
    container.createSpan({ text: '当前配置: ' });
    container.createEl('code', { text: 'Reranker' });
    container.createSpan({ text: ' | ' });
    // 关键路径:Rerank v1 仅支持百炼,密钥走钥匙串;未配置时自动关闭。
    container.createSpan({ text: `百炼 | Base: ${s.rerankerApiBase} | 模型: ${s.rerankerModel} | 密钥: ${getRerankSecretId()} | 状态: ${enabled ? '已配置' : '未配置(关闭)'}` });
}
