/**
 * @file src/ui/chat/message-stream/hydrate-session-messages.ts
 * @description 将持久化 ChatMessage[] 还原为 UI Message[](含 think/tool/text Trace 与 compact 分隔)
 * @module ui/chat/message-stream/hydrate-session-messages
 * @depends ports/llm, ports/persistence, core/attachment-store(仅类型), format-tool-display, ./types, ./new-message-id
 */

import type { ChatMessage } from '../../../ports/llm';
import type { CompactMarker } from '../../../ports/persistence';
import type { StoredAttachment } from '../../../core/attachment-store';
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

/** 附件解析替身 — AttachmentStore 或同形实现;load 缺文件返回 null(剥除不阻塞) */
type AttachmentStoreLike = {
	load(sessionId: string, id: string): Promise<StoredAttachment | null>;
};

/** 每条 raw user 消息下标 → 解析回 base64 的附件列表(仅含解析成功项) */
type ResolvedAttachmentsByMsg = Map<number, Array<{ fileName: string; mimeType: string; base64: string }>>;

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
 * - user → 单 text 段;带附件引用时经 store 解析回 base64(S-VISION v1.3)
 * - 连续 assistant(+tool) + 配对 tool 折叠为同一条 UI assistant
 * - compactMarkers:在 afterIndex 之后的第一条 UI 消息前插入 compact 分隔;无则 append
 *
 * @param messages - Session.messages
 * @param store - AttachmentStore(或同形替身);缺省时含图消息按无图处理(纯文本降级)。
 * @param sessionId - 附件寻址用(目录按会话分域)。
 * @param opts - 可选 MCP server label 与 compact 标记
 * @returns 还原后的 UI Message 列表(含可能的 compact 分隔行)。
 */
export async function hydrateSessionMessages(
	messages: ChatMessage[],
	store?: AttachmentStoreLike,
	sessionId = '',
	opts?: HydrateSessionMessagesOptions,
): Promise<Message[]> {
	// 关键路径(S-VISION v1.3):refs → base64 异步预解析;
	// 解析失败剥除该附件(与出站 toMessagesResolved 同语义),其余走原同步构建。
	const resolvedByMsg = new Map<number, Array<{ fileName: string; mimeType: string; base64: string }>>();
	if (store) {
		await Promise.all(
			messages.map(async (m, i) => {
				if (m.role !== 'user' || !m.attachments?.length) return;
				const atts: Array<{ fileName: string; mimeType: string; base64: string }> = [];
				for (const ref of m.attachments) {
					const hit = await store.load(sessionId, ref.id);
					if (hit) atts.push({ fileName: '', mimeType: hit.mimeType, base64: hit.base64 });
				}
				if (atts.length > 0) resolvedByMsg.set(i, atts);
			}),
		);
	}
	const entries = buildUiEntries(messages, resolvedByMsg, opts);
	return insertCompactMarkers(entries, opts?.markers);
}

/**
 * 按现有规则生成 UI 列表,并记录每条 UI 消息的最后 raw 下标。
 *
 * @param messages - Session.messages
 * @param resolvedByMsg - 已解析附件查表(raw 下标 → base64 附件列表),user 分支按此回填。
 * @param opts - 可选 MCP server label 与 compact 标记
 */
function buildUiEntries(
	messages: ChatMessage[],
	resolvedByMsg: ResolvedAttachmentsByMsg,
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
			const atts = resolvedByMsg.get(i);
			out.push({
				message: {
					id: newMessageId(),
					role: 'user',
					segments: [{ type: 'text', text: m.content }],
					// fileName 仅展示用,落盘引用无文件名,还原置空串
					...(atts ? { attachments: atts } : {}),
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
