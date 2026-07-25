/**
 * @file src/ui/chat/message-stream/hydrate-session-messages.ts
 * @description 将持久化 ChatMessage[] 还原为 UI Message[](含 think/tool/text Trace)
 * @module ui/chat/message-stream/hydrate-session-messages
 * @depends ports/llm, format-tool-display, ./types
 */

import type { ChatMessage } from '../../../ports/llm';
import { formatToolDisplayName } from '../format-tool-display';
import type { Message, MessageSegment, ToolCallEntry } from './types';

/**
 * 从落盘消息 hydrate 出 Chat UI 消息流。
 *
 * 规则:
 * - 跳过 system
 * - user → 单 text 段
 * - 连续 assistant(+tool) + 配对 tool 折叠为同一条 UI assistant
 *
 * @param messages - Session.messages
 */
export function hydrateSessionMessages(messages: ChatMessage[]): Message[] {
	const out: Message[] = [];
	let i = 0;
	while (i < messages.length) {
		const m = messages[i]!;
		if (m.role === 'system') {
			i++;
			continue;
		}
		if (m.role === 'user') {
			out.push({
				role: 'user',
				segments: [{ type: 'text', text: m.content }],
			});
			i++;
			continue;
		}
		if (m.role === 'tool') {
			// 孤立 tool — 跳过(协议破损历史)
			i++;
			continue;
		}
		if (m.role === 'assistant') {
			const segments: MessageSegment[] = [];
			let sawReasoning = false;

			const pushReasoning = (reasoning?: string) => {
				if (reasoning && reasoning.trim() && !sawReasoning) {
					segments.push({ type: 'think', text: reasoning });
					sawReasoning = true;
				}
			};

			// 消费连续 assistant / tool 直到下一条 user 或结束
			while (i < messages.length) {
				const cur = messages[i]!;
				if (cur.role === 'user' || cur.role === 'system') break;
				if (cur.role === 'assistant') {
					pushReasoning(cur.reasoning);
					if (cur.toolName && cur.toolCallId) {
						if (cur.content.trim()) {
							segments.push({ type: 'text', text: cur.content });
						}
						const toolCallId = cur.toolCallId;
						const toolName = cur.toolName;
						const toolArgs = cur.toolArgs ?? {};
						i++;
						let result: unknown = undefined;
						let status: ToolCallEntry['status'] = 'done';
						if (i < messages.length && messages[i]!.role === 'tool' && messages[i]!.toolCallId === toolCallId) {
							const toolMsg = messages[i]!;
							try {
								result = JSON.parse(toolMsg.content) as unknown;
							} catch {
								result = toolMsg.content;
							}
							if (typeof toolMsg.content === 'string' && toolMsg.content.startsWith('Error:')) {
								status = 'failed';
							}
							i++;
						}
						const entry: ToolCallEntry = {
							name: toolName,
							displayName: formatToolDisplayName(toolName, toolArgs),
							args: toolArgs,
							status,
							result,
							startAt: 0,
						};
						segments.push({ type: 'tool', toolCall: entry });
						continue;
					}
					// 纯文本 assistant
					pushReasoning(cur.reasoning);
					if (cur.content.trim()) {
						segments.push({ type: 'text', text: cur.content });
					}
					i++;
					continue;
				}
				// role tool without preceding assistant tool — skip
				i++;
			}

			if (segments.length > 0) {
				out.push({ role: 'assistant', segments });
			}
			continue;
		}
		i++;
	}
	return out;
}
