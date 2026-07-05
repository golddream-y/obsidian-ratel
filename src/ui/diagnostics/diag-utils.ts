/**
 * @file src/ui/diagnostics/diag-utils.ts
 * @description 诊断页面共用工具 — 错误格式化、UI 辅助、样式类名
 * @module ui/diagnostics/diag-utils
 * @depends obsidian
 */

import { setIcon } from 'obsidian';

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
        message: '未知错误',
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
            base.cause = '本地 Embedding 模型尚未加载完成';
            base.suggestion = '请等待 Obsidian 启动后的模型下载/初始化完成(Notice 提示消失后再试),或检查下载是否失败';
        } else if (errWithCode.status === 401 || msg.includes('apikey') || msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
            base.type = 'config';
            base.cause = 'API Key 无效或未配置';
            base.suggestion = '请检查设置页中对应服务的 API Key 是否正确填写,若使用 Ollama 等本地服务可留空 Key';
        } else if (errWithCode.status === 404 || msg.includes('404') || (msg.includes('model') && msg.includes('not found'))) {
            base.type = 'config';
            base.cause = '模型名称或 API 路径错误(404)';
            base.suggestion = '请检查模型名称是否正确、API Base URL 是否正确且包含 /v1 后缀(如需要)';
        } else if (msg.includes('network') || msg.includes('fetch') || msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('timeout') || msg.includes('failed to fetch')) {
            base.type = 'network';
            base.cause = '网络连接失败,无法访问 API 端点';
            base.suggestion = '请检查:1)网络连接是否正常;2)API Base URL 是否正确;3)本地服务(如 Ollama)是否已启动;4)是否需要代理';
        } else if (msg.includes('embedding') || msg.includes('tokenizer') || msg.includes('onnx') || msg.includes('wasm') || msg.includes('模型')) {
            base.type = 'model';
            base.cause = '本地模型加载或推理失败';
            base.suggestion = '请尝试:1)重新加载插件;2)删除插件目录下的 models 文件夹重新下载;3)切换到 API 模式';
        } else if (errWithCode.status === 400 || msg.includes('invalid') || msg.includes('bad request') || msg.includes('400')) {
            base.type = 'runtime';
            base.cause = '请求参数错误';
            base.suggestion = '请检查输入内容、参数设置(temperature/top_p 等)是否合法';
        } else if (errWithCode.status === 429 || msg.includes('rate limit') || msg.includes('429')) {
            base.type = 'network';
            base.cause = 'API 调用频率超限';
            base.suggestion = '请稍等片刻后重试,或检查 API 套餐额度';
        }
    } else if (typeof err === 'string') {
        base.message = context ? `${context}: ${err}` : err;
    } else {
        base.raw = err;
        try {
            base.message = context ? `${context}: ${JSON.stringify(err)}` : JSON.stringify(err);
        } catch {
            base.message = context ? `${context}: [无法序列化的错误对象]` : '[无法序列化的错误对象]';
        }
    }

    return base;
}

/**
 * 错误类型对应的中文标签与颜色类名。
 */
const ERROR_TYPE_META: Record<DiagErrorType, { label: string; cls: string }> = {
    config: { label: '配置错误', cls: 'diag-error-config' },
    network: { label: '网络错误', cls: 'diag-error-network' },
    model: { label: '模型错误', cls: 'diag-error-model' },
    runtime: { label: '运行时错误', cls: 'diag-error-runtime' },
    unknown: { label: '未知错误', cls: 'diag-error-unknown' },
};

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

    const block = container.createDiv({ cls: `diag-error-block ${meta.cls}` });

    // 头部:类型标签 + 消息
    const header = block.createDiv({ cls: 'diag-error-header' });
    header.createSpan({ cls: 'diag-error-tag', text: meta.label });
    header.createSpan({ cls: 'diag-error-msg', text: error.message });

    // 原因与建议
    if (error.cause) {
        const causeRow = block.createDiv({ cls: 'diag-error-row' });
        causeRow.createSpan({ cls: 'diag-error-label', text: '可能原因:' });
        causeRow.createSpan({ cls: 'diag-error-value', text: error.cause });
    }
    if (error.suggestion) {
        const sugRow = block.createDiv({ cls: 'diag-error-row' });
        sugRow.createSpan({ cls: 'diag-error-label', text: '排查建议:' });
        sugRow.createSpan({ cls: 'diag-error-value', text: error.suggestion });
    }

    // 详情折叠
    if (error.stack || error.raw !== undefined) {
        const details = block.createEl('details', { cls: 'diag-error-details' });
        const summary = details.createEl('summary', { text: '详细信息 (调试用)' });
        setIcon(summary.createSpan(), 'chevron-down');

        if (error.stack) {
            details.createEl('pre', { cls: 'diag-error-stack', text: error.stack });
        }
        if (error.raw !== undefined) {
            let rawText: string;
            try {
                rawText = typeof error.raw === 'string' ? error.raw : JSON.stringify(error.raw, null, 2);
            } catch {
                rawText = String(error.raw);
            }
            details.createEl('pre', { cls: 'diag-error-raw', text: rawText });
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
    const btn = container.createEl('button', { cls: 'diag-btn' });
    // 关键路径:图标 span 与文本 span 分开,避免重置 textContent 时把 SVG 抹掉。
    let iconSpan: HTMLSpanElement | null = null;
    if (icon) {
        iconSpan = btn.createSpan({ cls: 'diag-btn-icon' });
        setIcon(iconSpan, icon);
    }
    const textSpan = btn.createSpan({ cls: 'diag-btn-text', text });

    // 关键路径:用 void 包裹 async 回调,避免 addEventListener 的 async listener
    // 产生浮动 Promise(若 onClick 抛错会变成未处理的 rejection)。
    const handleClick = async (): Promise<void> => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.addClass('diag-btn-loading');
        textSpan.textContent = '执行中...';
        try {
            await onClick();
        } finally {
            btn.disabled = false;
            btn.removeClass('diag-btn-loading');
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
    const wrapper = container.createDiv({ cls: 'diag-result' });
    wrapper.createEl('h4', { text: title });
    const content = wrapper.createDiv({ cls: 'diag-result-content' });
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
        throw new Error(`向量维度不匹配:${a.length} vs ${b.length}`);
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
