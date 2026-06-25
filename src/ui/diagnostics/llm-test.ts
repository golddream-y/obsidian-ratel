/**
 * @file src/ui/diagnostics/llm-test.ts
 * @description LLM 诊断测试区 — 单轮对话、参数调优、流式输出
 * @module ui/diagnostics/llm-test
 * @depends obsidian, ../../main, ./diag-utils
 */

import type RatelVaultPlugin from '../../main';
import type { ChatMessage } from '../../ports/llm';
import { formatError, renderError } from './diag-utils';
import { devLogger } from '../../logging/dev-logger';

/**
 * 渲染 LLM 测试区。
 *
 * 功能:
 * 1. 当前配置摘要(Base URL / 模型 / Key 状态)
 * 2. 可选 System Prompt
 * 3. 用户消息输入
 * 4. 参数调优:temperature、top_p、max_tokens
 * 5. 发送/停止按钮
 * 6. 流式输出区域(逐 chunk 追加)
 * 7. 错误信息结构化展示
 * 8. 耗时/token 估算统计
 */
export function renderLLMTest(container: HTMLElement, plugin: RatelVaultPlugin): void {
    container.empty();

    // ==================== 配置状态 ====================
    const statusArea = container.createDiv({ cls: 'diag-config-summary' });
    renderLLMStatus(statusArea, plugin);

    // ==================== 输入区 ====================
    const inputSection = container.createDiv({ cls: 'diag-section' });

    // System Prompt(可选)
    inputSection.createEl('label', { cls: 'diag-label', text: 'System Prompt (可选)' });
    const systemInput = inputSection.createEl('textarea', {
        cls: 'diag-textarea',
        attr: { placeholder: '例如:你是一个有用的助手。用中文回答,简洁明了。', rows: '2' },
    });

    // User Message
    inputSection.createEl('label', { cls: 'diag-label', text: '用户消息' });
    const userInput = inputSection.createEl('textarea', {
        cls: 'diag-textarea',
        attr: { placeholder: '输入你的问题...', rows: '4' },
    });

    // 参数调优
    inputSection.createEl('h4', { text: '生成参数(临时覆盖,不保存)' });
    const paramGroup = inputSection.createDiv({ cls: 'diag-param-group' });

    // Temperature
    const tempRow = paramGroup.createDiv({ cls: 'diag-param-row' });
    tempRow.createEl('label', { text: 'Temperature' });
    const tempInput = tempRow.createEl('input', {
        cls: 'diag-input',
        type: 'number',
        attr: { min: '0', max: '2', step: '0.1', value: '1.0' },
    });
    tempRow.createSpan({ attr: { style: 'font-size:11px;color:var(--text-faint);width:60px;' }, text: '0=确定' });

    // Top P
    const topPRow = paramGroup.createDiv({ cls: 'diag-param-row' });
    topPRow.createEl('label', { text: 'Top P' });
    const topPInput = topPRow.createEl('input', {
        cls: 'diag-input',
        type: 'number',
        attr: { min: '0', max: '1', step: '0.05', value: '1.0' },
    });

    // Max Tokens
    const maxTokensRow = paramGroup.createDiv({ cls: 'diag-param-row' });
    maxTokensRow.createEl('label', { text: 'Max Tokens' });
    const maxTokensInput = maxTokensRow.createEl('input', {
        cls: 'diag-input',
        type: 'number',
        attr: { min: '1', max: '8192', step: '10', placeholder: '默认(模型上限)' },
    });

    // 按钮行
    const btnRow = inputSection.createDiv({ cls: 'diag-row' });
    const sendBtn = btnRow.createEl('button', { cls: 'diag-btn', text: '发送' });
    const stopBtn = btnRow.createEl('button', { cls: 'diag-btn diag-btn-secondary', text: '停止' });
    stopBtn.disabled = true;
    const clearBtn = btnRow.createEl('button', { cls: 'diag-btn diag-btn-secondary', text: '清空输出' });

    // ==================== 输出区 ====================
    const outputSection = container.createDiv({ cls: 'diag-section' });
    const metaInfo = outputSection.createDiv({ attr: { style: 'font-size:12px;color:var(--text-faint);margin-bottom:8px;min-height:16px;' } });
    const streamArea = outputSection.createDiv({ cls: 'diag-llm-stream' });
    streamArea.createDiv({ cls: 'diag-result-empty', text: '点击"发送"开始测试' });
    const errorArea = outputSection.createDiv();

    // 内部状态
    let running = false;
    let stopped = false;
    let fullResponse = '';
    let t0 = 0;
    let chunkCount = 0;

    /** 重置输出区状态 */
    const resetOutput = () => {
        fullResponse = '';
        chunkCount = 0;
        streamArea.empty();
        errorArea.empty();
        metaInfo.empty();
    };

    /** 更新 meta 信息 */
    const updateMeta = () => {
        const elapsed = performance.now() - t0;
        const tokens = plugin.llm.countTokens(fullResponse);
        metaInfo.empty();
        metaInfo.createSpan({ text: `状态: ${running ? '生成中...' : '完成'} | 耗时: ${elapsed.toFixed(0)}ms | 块数: ${chunkCount} | 估算 token: ~${tokens}` });
    };

    /** 停止生成 */
    const stop = () => {
        if (!running) return;
        stopped = true;
        running = false;
        sendBtn.disabled = false;
        sendBtn.textContent = '发送';
        stopBtn.disabled = true;
        metaInfo.empty();
        const elapsed = performance.now() - t0;
        metaInfo.createSpan({ text: `已停止 | 耗时: ${elapsed.toFixed(0)}ms | 已输出 ${fullResponse.length} 字符` });
    };

    /** 发送请求 */
    const send = async () => {
        const userMsg = userInput.value.trim();
        if (!userMsg) {
            errorArea.empty();
            renderError(errorArea, formatError('请输入用户消息', '输入校验失败'));
            return;
        }

        if (!plugin.settings.chatApiKey && !plugin.settings.chatApiBase.includes('localhost') && !plugin.settings.chatApiBase.includes('127.0.0.1')) {
            errorArea.empty();
            const warn = errorArea.createDiv({ cls: 'diag-error-block', attr: { style: 'border-left-color: var(--text-warning);' } });
            warn.createDiv({ cls: 'diag-error-header' })
                .createSpan({ cls: 'diag-error-tag', attr: { style: 'background: var(--text-warning);' }, text: '注意' });
            warn.createDiv({ text: 'API Key 为空。如果使用需要鉴权的端点(非本地服务),请求将失败。' });
        }

        resetOutput();
        running = true;
        stopped = false;
        t0 = performance.now();
        sendBtn.disabled = true;
        sendBtn.textContent = '生成中...';
        stopBtn.disabled = false;

        // 构造消息
        const messages: ChatMessage[] = [];
        const sysPrompt = systemInput.value.trim();
        if (sysPrompt) {
            messages.push({ role: 'system', content: sysPrompt });
        }
        messages.push({ role: 'user', content: userMsg });

        // 解析参数
        const temperature = parseFloat(tempInput.value);
        const topP = parseFloat(topPInput.value);
        const maxTokens = maxTokensInput.value ? parseInt(maxTokensInput.value, 10) : undefined;

        const options: { temperature?: number; topP?: number; maxTokens?: number } = {};
        if (!isNaN(temperature) && temperature >= 0 && temperature <= 2) options.temperature = temperature;
        if (!isNaN(topP) && topP >= 0 && topP <= 1) options.topP = topP;
        if (maxTokens && maxTokens > 0) options.maxTokens = maxTokens;

        // 为了让测试页的参数不影响插件主 LLM,临时创建一个独立客户端
        // (如果不临时创建,plugin.llm 是全局的,参数改了也只在这次请求生效,
        // 但 DeepSeekLLM 构造时只存了 config,options 是每次请求传的,所以直接用 plugin.llm 即可)
        const llm = plugin.llm;

        try {
            updateMeta();
            const metaTimer = setInterval(updateMeta, 200);

            try {
                for await (const delta of llm.chat({ messages, options })) {
                    if (stopped) break;
                    if (delta.text) {
                        fullResponse += delta.text;
                        chunkCount++;
                        // 流式追加到 DOM
                        if (streamArea.querySelector('.diag-result-empty')) {
                            streamArea.empty();
                        }
                        streamArea.appendText(delta.text);
                        updateMeta();
                    }
                }
            } finally {
                clearInterval(metaTimer);
            }

            if (!stopped) {
                running = false;
                sendBtn.disabled = false;
                sendBtn.textContent = '发送';
                stopBtn.disabled = true;
                updateMeta();
            }
        } catch (err) {
            running = false;
            stopped = false;
            sendBtn.disabled = false;
            sendBtn.textContent = '发送';
            stopBtn.disabled = true;
            // 关键路径:LLM 异常属调试事件,仅写开发者 console,不弹 Notice(诊断页用户已看到错误块)。
            devLogger.error('main', 'LLM test failed', err);
            renderError(errorArea, formatError(err, 'LLM 请求失败'));
        }
    };

    sendBtn.addEventListener('click', () => void send());
    stopBtn.addEventListener('click', stop);
    clearBtn.addEventListener('click', () => {
        resetOutput();
        streamArea.createDiv({ cls: 'diag-result-empty', text: '点击"发送"开始测试' });
    });

    // 支持 Ctrl/Cmd+Enter 发送
    userInput.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (!running) void send();
        }
    });

    // 默认填入示例
    userInput.value = '用一句话解释什么是 RAG,不要超过 50 个字。';
}

/**
 * 渲染当前 LLM 配置状态摘要。
 */
function renderLLMStatus(container: HTMLElement, plugin: RatelVaultPlugin): void {
    const s = plugin.settings;
    const hasKey = s.chatApiKey.length > 0;
    const isLocal = s.chatApiBase.includes('localhost') || s.chatApiBase.includes('127.0.0.1');

    container.empty();
    container.createSpan({ cls: `diag-status-dot ${hasKey || isLocal ? 'diag-status-ok' : 'diag-status-warn'}` });
    container.createSpan({ text: '当前配置: ' });
    container.createEl('code', { text: 'LLM / Chat' });
    container.createSpan({ text: ' | ' });
    container.createSpan({ text: `Base: ${s.chatApiBase} | 模型: ${s.chatModel} | Key: ${hasKey ? '已配置(' + s.chatApiKey.slice(0, 6) + '...)' : isLocal ? '本地服务(无 Key)' : '未配置'}` });
}
