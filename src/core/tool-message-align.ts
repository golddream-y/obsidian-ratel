/**
 * @file src/core/tool-message-align.ts
 * @description 工具消息对齐 — 消除孤立 role=tool,避免 OpenAI 兼容网关 400
 * @module core/tool-message-align
 * @depends ports/llm ChatMessage
 */

import type { ChatMessage } from '../ports/llm';

/**
 * 判断 tool 消息在 `prefix` 末尾是否已有匹配的 assistant(tool_calls)。
 *
 * 协议约束:role=tool 必须紧跟在带对应 tool_call_id 的 assistant 之后
 * (中间只允许同轮的其他 tool 结果)。
 *
 * @param prefix - 已接受的消息前缀
 * @param tool - 候选 tool 消息
 */
function hasMatchingAssistantBefore(prefix: ChatMessage[], tool: ChatMessage): boolean {
	const id = tool.toolCallId;
	if (!id) return false;
	for (let i = prefix.length - 1; i >= 0; i--) {
		const prev = prefix[i]!;
		if (prev.role === 'tool') continue;
		return prev.role === 'assistant' && prev.toolCallId === id;
	}
	return false;
}

/**
 * 丢弃无法配对的 `role:tool` 消息,保持其余顺序不变。
 *
 * 用于 LLM 上送前双保险 — 已持久化的坏历史也不会发出孤立 tool。
 *
 * @param messages - 待清洗的会话消息
 * @returns 无孤立 tool 的新数组
 */
export function sanitizeToolMessageOrder(messages: readonly ChatMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const m of messages) {
		if (m.role === 'tool') {
			if (hasMatchingAssistantBefore(out, m)) {
				out.push(m);
			}
			// 否则丢弃孤立 tool
			continue;
		}
		out.push(m);
	}
	return out;
}

/**
 * 对齐 compact 保留窗口 — 去掉因 `slice(-N)` 产生的孤立 tool。
 *
 * 典型坏窗口:`[tool A, asst B, tool B]` → `[asst B, tool B]`。
 * 不读盘、不改消息内容,只删无法配对的 tool。
 *
 * @param messages - 通常为 `allMessages.slice(-N)` 的候选保留集
 * @returns 对齐后的保留消息(可能短于输入)
 */
export function alignPreservedToolMessages(messages: readonly ChatMessage[]): ChatMessage[] {
	return sanitizeToolMessageOrder(messages);
}
