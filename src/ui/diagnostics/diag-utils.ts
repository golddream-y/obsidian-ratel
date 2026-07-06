/**
 * @file src/ui/diagnostics/diag-utils.ts
 * @description 诊断页面共用工具 — 错误格式化、UI 辅助、样式类名
 * @module ui/diagnostics/diag-utils
 * @depends obsidian
 */

import { setIcon } from 'obsidian';
import { tNow } from '../../i18n';
import type { StringKey } from '../../i18n/types';

/**
 * 诊断错误分类 — 用于区分错误来源,给出针对性排查建议。
 */
export type DiagErrorType = 'config' | 'network' | 'model' | 'runtime' | 'unknown';

/**
 * 结构化诊断错误 — 调试页面所有错误都转成这个形态,确保信息完整。
 */
export interface DiagError {
    type: DiagErrorType;
    message: string;
    cause?: string;
    suggestion?: string;
    raw?: unknown;
    stack?: string;
}

/**
 * 把任意异常值(Error / string / 对象)格式化为 DiagError。
 *
 * 关键路径:调试页面要暴露尽可能多的信息,因此:
 * - 保留原始 stack
 * - 尝试从 HTTP 响应 / fetch error 中提取状态码与端点
 * - 根据错误特征自动分类
 */
export function formatError(err: unknown, context?: string): DiagError {
    const base: DiagError = {
        type: 'unknown',
        message: tNow('diag.errorUnknown'),
    };

    if (context) {
        base.message = `${context}: ${base.message}`;
    }

    if (err instanceof Error) {
        base.message = context ? `${context}: ${err.message}` : err.message;
        base.stack = err.stack;
        base.raw = err;

        // 错误分类启发式
        const errWithCode = err as Error & { code?: string; status?: number };
        const msg = err.message.toLowerCase();

        if (err.name === 'IndexNotReadyError' || errWithCode.code === 'INDEX_NOT_READY' || msg.includes('尚未加载') || msg.includes('未就绪')) {
            base.type = 'model';
            base.cause = tNow('diag.errorCause.modelNotLoaded');
            base.suggestion = tNow('diag.errorSuggestion.modelNotLoaded');
        } else if (errWithCode.status === 401 || msg.includes('apikey') || msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
            base.type = 'config';
            base.cause = tNow('diag.errorCause.invalidKey');
            base.suggestion = tNow('diag.errorSuggestion.invalidKey');
        } else if (errWithCode.status === 404 || msg.includes('404') || (msg.includes('model') && msg.includes('not found'))) {
            base.type = 'config';
            base.cause = tNow('diag.errorCause.modelNotFound');
            base.suggestion = tNow('diag.errorSuggestion.modelNotFound');
        } else if (msg.includes('network') || msg.includes('fetch') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('timeout') || msg.includes('failed to fetch')) {
            base.type = 'network';
            base.cause = tNow('diag.errorCause.networkFailed');
            base.suggestion = tNow('diag.errorSuggestion.networkFailed');
        } else if (msg.includes('embedding') || msg.includes('tokenizer') || msg.includes('onnx') || msg.includes('wasm') || msg.includes('模型')) {
            base.type = 'model';
            base.cause = tNow('diag.errorCause.localModelFailed');
            base.suggestion = tNow('diag.errorSuggestion.localModelFailed');
        } else if (errWithCode.status === 400 || msg.includes('invalid') || msg.includes('bad request') || msg.includes('400')) {
            base.type = 'runtime';
            base.cause = tNow('diag.errorCause.badRequest');
            base.suggestion = tNow('diag.errorSuggestion.badRequest');
        } else if (errWithCode.status === 429 || msg.includes('rate limit') || msg.includes('429')) {
            base.type = 'network';
            base.cause = tNow('diag.errorCause.rateLimit');
            base.suggestion = tNow('diag.errorSuggestion.rateLimit');
        }
    } else if (typeof err === 'string') {
        base.message = context ? `${context}: ${err}` : err;
    } else {
        base.raw = err;
        try {
            base.message = context ? `${context}: ${JSON.stringify(err)}` : JSON.stringify(err);
        } catch {
            // 修复:不可序列化的错误对象用占位文案,避免 JSON.stringify 抛错二次崩溃
            base.message = context ? `${context}: ${tNow('diag.errorUnserializable')}` : tNow('diag.errorUnserializable');
        }
    }

    return base;
}

/**
 * 错误类型对应的颜色类名 — label 走 i18n 动态查询以跟随当前语言。
 *
 * 关键路径:不在常量里固化 label,改在 renderError 里用 tNow('diag.errorType.{type}') 取,
 * 否则用户切换语言后旧标签不会刷新。
 */
const ERROR_TYPE_META: Record<DiagErrorType, { cls: string }> = {
    config: { cls: 'ratel-diag-error-config' },
    network: { cls: 'ratel-diag-error-network' },
    model: { cls: 'ratel-diag-error-model' },
    runtime: { cls: 'ratel-diag-error-runtime' },
    unknown: { cls: 'ratel-diag-error-unknown' },
};

/**
 * 取错误类型对应的本地化标签。
 *
 * @param type - 错误分类
 * @returns 当前语言下的标签文案(如 zh 下 '配置错误',en 下 'Configuration error')
 */
function errorTypeLabel(type: DiagErrorType): string {
    const keyMap: Record<DiagErrorType, StringKey> = {
        config: 'diag.errorType.config',
        network: 'diag.errorType.network',
        model: 'diag.errorType.model',
        runtime: 'diag.errorType.runtime',
        unknown: 'diag.errorType.unknown',
    };
    return tNow(keyMap[type]);
}

/**
 * 在容器中渲染一个结构化错误展示块。
 *
 * 设计要点:
 * - 顶部红色粗条显示错误类型与核心消息
 * - "可能原因"与"排查建议"分行展示
 * - "详细信息"折叠区包含 stack 与 raw error,默认收起避免干扰
 * - 同一容器可多次调用,新错误追加到末尾(清空由调用方负责)
 */
export function renderError(container: HTMLElement, error: DiagError): void {
    const meta = ERROR_TYPE_META[error.type];

    const block = container.createDiv({ cls: `ratel-diag-error-block ${meta.cls}` });

    // 头部:类型标签 + 消息
    const header = block.createDiv({ cls: 'ratel-diag-error-header' });
    header.createSpan({ cls: 'ratel-diag-error-tag', text: errorTypeLabel(error.type) });
    header.createSpan({ cls: 'ratel-diag-error-msg', text: error.message });

    // 原因与建议
    if (error.cause) {
        const causeRow = block.createDiv({ cls: 'ratel-diag-error-row' });
        causeRow.createSpan({ cls: 'ratel-diag-error-label', text: tNow('diag.errorMeta.possibleCauses') });
        causeRow.createSpan({ cls: 'ratel-diag-error-value', text: error.cause });
    }
    if (error.suggestion) {
        const sugRow = block.createDiv({ cls: 'ratel-diag-error-row' });
        sugRow.createSpan({ cls: 'ratel-diag-error-label', text: tNow('diag.errorMeta.troubleshoot') });
        sugRow.createSpan({ cls: 'ratel-diag-error-value', text: error.suggestion });
    }

    // 详情折叠
    if (error.stack || error.raw !== undefined) {
        const details = block.createEl('details', { cls: 'ratel-diag-error-details' });
        const summary = details.createEl('summary', { text: tNow('diag.errorMeta.details') });
        setIcon(summary.createSpan(), 'chevron-down');

        if (error.stack) {
            details.createEl('pre', { cls: 'ratel-diag-error-stack', text: error.stack });
        }
        if (error.raw !== undefined) {
            let rawText: string;
            try {
                rawText = typeof error.raw === 'string' ? error.raw : JSON.stringify(error.raw, null, 2);
            } catch {
                rawText = String(error.raw);
            }
            details.createEl('pre', { cls: 'ratel-diag-error-raw', text: rawText });
        }
    }
}

/**
 * 创建一个按钮,带加载状态与图标支持。
 *
 * - 点击时自动 disabled 并显示 spinner
 * - 异步回调完成/失败后恢复状态
 */
export function createActionButton(
    container: HTMLElement,
    text: string,
    onClick: () => Promise<void>,
    icon?: string,
): HTMLButtonElement {
    const btn = container.createEl('button', { cls: 'ratel-diag-btn' });
    // 关键路径:图标 span 与文本 span 分开,避免重置 textContent 时把 SVG 抹掉。
    let iconSpan: HTMLSpanElement | null = null;
    if (icon) {
        iconSpan = btn.createSpan({ cls: 'ratel-diag-btn-icon' });
        setIcon(iconSpan, icon);
    }
    const textSpan = btn.createSpan({ cls: 'ratel-diag-btn-text', text });

    // 关键路径:用 void 包裹 async 回调,避免 addEventListener 的 async listener
    // 产生浮动 Promise(若 onClick 抛错会变成未处理的 rejection)。
    const handleClick = async (): Promise<void> => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.addClass('ratel-diag-btn-loading');
        textSpan.textContent = tNow('diag.executing');
        try {
            await onClick();
        } finally {
            btn.disabled = false;
            btn.removeClass('ratel-diag-btn-loading');
            textSpan.textContent = text;
        }
    };
    btn.addEventListener('click', () => void handleClick());

    return btn;
}

/**
 * 创建结果区域容器 — 统一的留白与边框。
 */
export function createResultArea(container: HTMLElement, title: string): HTMLElement {
    const wrapper = container.createDiv({ cls: 'ratel-diag-result' });
    wrapper.createEl('h4', { text: title });
    const content = wrapper.createDiv({ cls: 'ratel-diag-result-content' });
    return content;
}

/**
 * 清空容器中所有子元素。
 */
export function clearContainer(el: HTMLElement): void {
    el.empty();
}

/**
 * 计算余弦相似度 — 两个等长向量的相似度,范围 [-1, 1]。
 *
 * 关键路径:纯函数,不依赖任何外部模块,便于在诊断页直接使用。
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error(tNow('error.embedding.dimMismatch', { expected: a.length, actual: b.length }));
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        const av = a[i] as number;
        const bv = b[i] as number;
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return 0;
    return dot / denom;
}

// 修复:诊断页面样式已迁移到 styles.css(由 Obsidian 自动加载插件 CSS),
// 不再运行时创建 <style> 元素(Obsidian linter 禁止该模式)。
