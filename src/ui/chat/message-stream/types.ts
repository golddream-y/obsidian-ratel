/**
 * @file src/ui/chat/message-stream/types.ts
 * @description 消息流数据模型 — segments 判别联合 + ToolCallEntry + Message
 * @module ui/chat/message-stream/types
 * @depends ../../chat-error(类型)
 */

import type { DiagError } from '../chat-error';

/**
 * 工具调用条目 — UI 渲染单元。
 * displayName 预格式化(如 "list_files Formatting/"),startAt 用于时序展示。
 */
export interface ToolCallEntry {
	name: string;
	displayName: string;
	args: unknown;
	status: 'calling' | 'done' | 'failed';
	result?: unknown;
	errorMessage?: string;
	startAt: number;
}

/**
 * 助手消息的有序段 — 保留事件时序,支持"文本 → 工具 → 文本 → 工具"完全交替。
 * 判别联合:type 字段做 discriminator,Svelte 模板用 {#if} 分支渲染。
 *
 * - `text`:普通文本段(可被流式追加合并)
 * - `think`:思考过程段(DeepSeek reasoning_content,可折叠)
 * - `tool`:工具调用段(每次 tool.call 独立一段,可折叠详情)
 * - `image`:图片段(本次仅预留接口,不实现渲染逻辑)
 * - `citation`:引用段(本次仅预留接口,不实现自动抽取)
 */
export type MessageSegment =
	| { type: 'text'; text: string }
	| { type: 'think'; text: string }
	| { type: 'tool'; toolCall: ToolCallEntry }
	| { type: 'image'; mimeType: string; base64: string }
	| { type: 'citation'; docId: string; path: string; snippet: string };

/**
 * 统一消息 — user / assistant 都用 segments,告别 content + toolCalls 双数组。
 */
export interface Message {
	role: 'user' | 'assistant';
	segments: MessageSegment[];
	chatError?: DiagError;
	cancelled?: boolean;
	searchResults?: Array<{ docId: string; score: number; path: string; index: number }>;
	searchReranked?: boolean;
	attachments?: Array<{ fileName: string; mimeType: string; base64: string }>;
	/** message.end 收到的 API 真值,用于校准 token 统计 */
	tokenUsage?: { promptTokens: number; completionTokens: number };
}
