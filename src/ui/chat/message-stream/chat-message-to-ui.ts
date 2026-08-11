/**
 * @file src/ui/chat/message-stream/chat-message-to-ui.ts
 * @description ChatMessage(persistence 层) → Message(UI 层) 转换器 - 用于 /compact 等 session 重置场景
 * @module ui/chat/message-stream/chat-message-to-ui
 * @depends ../../../ports/llm, ./types, ./new-message-id
 */

import type { ChatMessage } from '../../../ports/llm';
import { newMessageId } from './new-message-id';
import type { Message } from './types';

/**
 * 把持久化的 ChatMessage[] 转成 UI 渲染用的 Message[]。
 *
 * 关键路径:ChatMessage 含 system/tool 角色,但 UI Message 只支持 user/assistant。
 * 此函数过滤掉 system/tool(摘要已捕获要点,UI 不渲染中间过程),只保留 user/assistant,
 * 把 content string 包装为 segments 数组(UI 渲染约定)。
 *
 * @param messages - 持久化层的 ChatMessage 数组
 * @returns UI 层 Message 数组(只含 user/assistant,system/tool 被过滤)
 */
export function preservedChatMessagesToUi(messages: ChatMessage[]): Message[] {
	return messages
		.filter((m): m is ChatMessage & { role: 'user' | 'assistant' } =>
			m.role === 'user' || m.role === 'assistant')
		.map((m) => ({
			id: newMessageId(),
			role: m.role,
			segments: [{ type: 'text' as const, text: m.content }],
		}));
}
