/**
 * @file src/ui/chat/message-stream/hydrate-session-messages.ts
 * @description 将持久化 ChatMessage[] 还原为 UI Message[](含 think/tool/text Trace 与 compact 分隔)
 * @module ui/chat/message-stream/hydrate-session-messages
 * @depends ports/llm, ports/persistence, format-tool-display, ./types, ./new-message-id
 */

import type { ChatMessage } from '../../../ports/llm';
import type { CompactMarker } from '../../../ports/persistence';
import { mapSearchResults } from '../../../core/search-result-mapper';
import { formatToolDisplayName, type FormatToolDisplayOptions } from '../format-tool-display';
import { newMessageId } from './new-message-id';
import type { Message, MessageSegment, ToolCallEntry } from './types';

/** hydrate 可选参数 — 与 live 流式 tool 展示名对齐 */
export interface HydrateSessionMessagesOptions {
	resolveMcpServerLabel?: FormatToolDisplayOptions['resolveMcpServerLabel'];
	/** 全量压缩标记 — 在对应 raw 下标之后插入 compact 分隔行 */
	markers?: CompactMarker[];
}

/** 构建阶段条目 — 记录 UI 消息对应的最后一条 raw 下标 */
interface UiBuildEntry {
	message: Message;
	lastRawIndex: number;
}

/**
 * 从落盘消息 hydrate 出 Chat UI 消息流。
 *
 * 规则:
 * - 跳过 system
 * - user → 单 text 段
 * - 连续 assistant(+tool) + 配对 tool 折叠为同一条 UI assistant
 * - compactMarkers:在 afterIndex 之后的第一条 UI 消息前插入 compact 分隔;无则 append
 *
 * @param messages - Session.messages
 * @param opts - 可选 MCP server label 与 compact 标记
 */
export function hydrateSessionMessages(
	messages: ChatMessage[],
	opts?: HydrateSessionMessagesOptions,
): Message[] {
	const entries = buildUiEntries(messages, opts);
	return insertCompactMarkers(entries, opts?.markers);
}

/**
 * 按现有规则生成 UI 列表,并记录每条 UI 消息的最后 raw 下标。
 */
function buildUiEntries(
	messages: ChatMessage[],
	opts?: HydrateSessionMessagesOptions,
): UiBuildEntry[] {
	const out: UiBuildEntry[] = [];
	let i = 0;
	while (i < messages.length) {
		const m = messages[i]!;
		if (m.role === 'system') {
			i++;
			continue;
		}
		if (m.role === 'user') {
			out.push({
				message: {
					id: newMessageId(),
					role: 'user',
					segments: [{ type: 'text', text: m.content }],
				},
				lastRawIndex: i,
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
			const start = i;
			const segments: MessageSegment[] = [];
			let sawReasoning = false;
			let lastSearch: { results: NonNullable<Message['searchResults']>; reranked: boolean } | null = null;

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
							displayName: formatToolDisplayName(toolName, toolArgs, {
								resolveMcpServerLabel: opts?.resolveMcpServerLabel,
							}),
							args: toolArgs,
							status,
							result,
							startAt: 0,
						};
						// 成功但不可 map 时清空 lastSearch,与 live「后写覆盖」对齐;失败不覆盖更早成功结果
						if (toolName === 'search_vault' && status !== 'failed') {
							lastSearch = mapSearchResults(result);
						}
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
				out.push({
					message: {
						id: newMessageId(),
						role: 'assistant',
						segments,
						...(lastSearch
							? { searchResults: lastSearch.results, searchReranked: lastSearch.reranked }
							: {}),
					},
					lastRawIndex: i - 1 >= start ? i - 1 : start,
				});
			}
			continue;
		}
		i++;
	}
	return out;
}

/**
 * 按 compactMarkers 在 UI 流中 splice 分隔行。
 *
 * 插入规则:在 afterIndex 之后的第一条 UI 消息前插入;若没有则 append 到末尾。
 */
function insertCompactMarkers(entries: UiBuildEntry[], markers: CompactMarker[] | undefined): Message[] {
	if (!markers?.length) return entries.map((e) => e.message);

	const sorted = [...markers].sort((a, b) => a.afterIndex - b.afterIndex);
	const out: Message[] = [];
	let mi = 0;

	for (let i = 0; i < entries.length; i++) {
		const curLast = entries[i]!.lastRawIndex;
		const prevLast = i > 0 ? entries[i - 1]!.lastRawIndex : -1;

		while (mi < sorted.length) {
			const marker = sorted[mi]!;
			const shouldInsertBefore =
				curLast > marker.afterIndex && (i === 0 || prevLast <= marker.afterIndex);
			if (!shouldInsertBefore) break;
			out.push(createCompactDividerMessage());
			mi++;
		}
		out.push(entries[i]!.message);
	}

	while (mi < sorted.length) {
		out.push(createCompactDividerMessage());
		mi++;
	}

	return out;
}

/** 落盘 marker 对应的静态分隔行 — phase 固定 done */
function createCompactDividerMessage(): Message {
	return {
		id: newMessageId(),
		role: 'compact',
		compactPhase: 'done',
		segments: [],
	};
}
