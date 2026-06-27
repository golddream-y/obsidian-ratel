/**
 * @file src/ui/chat-error.ts
 * @description Chat 会话内结构化错误 — 复用 formatError 分类,独立 DOM 样式
 * @module ui/chat-error
 * @depends ui/diagnostics/diag-utils
 */

import { formatError, type DiagError } from '../diagnostics/diag-utils';

export type { DiagError };

/**
 * 将 Agent error 事件转为 Chat 用 DiagError。
 *
 * @param code - AgentEvent.error.payload.code(内部错误码,不直接展示给用户)
 * @param message - AgentEvent.error.payload.message
 * @returns 结构化错误,供 renderChatErrorBlock 使用
 */
export function formatChatError(code: string, message: string): DiagError {
	if (code === 'CANCELLED') {
		return { type: 'runtime', message: '已停止生成' };
	}
	// 关键路径:code 是内部英文标识符(LLM_ERROR/TOOL_ERROR/INDEX_NOT_READY),
	// 不直接拼到用户可见消息里;仅传 message 让 formatError 做启发式分类。
	const err = new Error(message);
	// 传递 code 给 formatError 用于分类启发式,但最终消息不含 code。
	(err as Error & { code?: string }).code = code;
	return formatError(err);
}

/**
 * 在 parent 内渲染 Chat 错误块。
 *
 * @param parent - 挂载容器(通常为 assistant 气泡)
 * @param error - 结构化错误
 * @returns 错误块根元素
 */
export function renderChatErrorBlock(parent: HTMLElement, error: DiagError): HTMLElement {
	const el = parent.createDiv({ cls: `ratel-chat-error ratel-chat-error-${error.type}` });
	el.createDiv({ cls: 'ratel-chat-error-msg', text: error.message });
	if (error.suggestion) {
		el.createDiv({ cls: 'ratel-chat-error-suggestion', text: error.suggestion });
	}
	return el;
}

/**
 * 渲染用户取消生成的轻提示(非错误样式)。
 *
 * @param parent - 挂载容器
 * @returns 提示根元素
 */
export function renderCancelledHint(parent: HTMLElement): HTMLElement {
	return parent.createDiv({ cls: 'ratel-chat-cancelled', text: '已停止生成' });
}
