/**
 * @file src/ui/chat/session/session-content.ts
 * @description 判断会话是否「有内容」— /new 时决定归档保留还是丢弃空场
 * @module ui/chat/session/session-content
 * @depends ports/llm
 */

import type { ChatMessage } from '../../../ports/llm';

/**
 * 当前场是否含有效对话内容。
 *
 * 有内容 = 至少一条非空 user，或 assistant/tool 含非空 content / reasoning / toolName。
 * 用于 `/new`：有内容则归档，无内容则删除空场。
 *
 * @param messages - 持久化层 ChatMessage 列表
 * @returns 是否视为有内容
 */
export function sessionHasContent(messages: ChatMessage[]): boolean {
	for (const m of messages) {
		if (m.role === 'user' && m.content.trim().length > 0) return true;
		if (m.role === 'assistant') {
			if (m.content.trim().length > 0) return true;
			if (m.reasoning && m.reasoning.trim().length > 0) return true;
			if (m.toolName) return true;
		}
		if (m.role === 'tool' && m.content.trim().length > 0) return true;
	}
	return false;
}
