/**
 * @file src/ui/chat/message-stream/segment-appender.ts
 * @description segments 追加/合并/工具结果回填/失败标记 — ChatView 不再直接操作 segments 数组
 * @module ui/chat/message-stream/segment-appender
 * @depends ./types
 */

import type { Message, ToolCallEntry } from './types';

/**
 * 向 message.segments 追加文本段 — 相邻 text 段自动合并(流式 delta 场景)。
 */
export function appendText(msg: Message, text: string): void {
	const last = msg.segments[msg.segments.length - 1];
	if (last && last.type === 'text') {
		last.text += text;
	} else {
		msg.segments.push({ type: 'text', text });
	}
}

/**
 * 向 message.segments 追加 think 段 — 相邻 think 段自动合并。
 */
export function appendThink(msg: Message, text: string): void {
	const last = msg.segments[msg.segments.length - 1];
	if (last && last.type === 'think') {
		last.text += text;
	} else {
		msg.segments.push({ type: 'think', text });
	}
}

/**
 * 向 message.segments 追加工具调用段 — 不合并,每个 tool.call 一个独立段。
 */
export function appendToolCall(msg: Message, tc: ToolCallEntry): void {
	msg.segments.push({ type: 'tool', toolCall: tc });
}

/**
 * 把工具调用结果回填到最近一个尚未带结果的同名工具段。
 * 失败事件会先把状态改成 failed；这里仍回填到那一行，避免再追加一条工具原名。
 * 若未找到匹配段(异常时序),降级为追加一个已完成的工具段。
 */
export function attachToolResult(msg: Message, name: string, result: unknown): void {
	for (let i = msg.segments.length - 1; i >= 0; i--) {
		const seg = msg.segments[i]!;
		if (seg.type !== 'tool' || seg.toolCall.name !== name) continue;
		const open = seg.toolCall.status === 'calling'
			|| (seg.toolCall.status === 'failed' && seg.toolCall.result === undefined);
		if (!open) continue;
		seg.toolCall.result = result;
		// 闸门等路径用 Error: 开头的字符串表示未执行，不能标成成功。
		if (typeof result === 'string' && result.startsWith('Error:')) {
			seg.toolCall.status = 'failed';
			if (!seg.toolCall.errorMessage) seg.toolCall.errorMessage = result;
		} else if (seg.toolCall.status === 'calling') {
			seg.toolCall.status = 'done';
		}
		return;
	}
	// 降级:未找到匹配段,追加已完成的工具段
	msg.segments.push({
		type: 'tool',
		toolCall: {
			name,
			displayName: name,
			args: {},
			status: typeof result === 'string' && result.startsWith('Error:') ? 'failed' : 'done',
			errorMessage: typeof result === 'string' && result.startsWith('Error:') ? result : undefined,
			result,
			startAt: Date.now(),
		},
	});
}

/**
 * 标记工具段失败 — 用于 TOOL_ERROR / TOOL_DENIED / INDEX_NOT_READY 错误。
 * 标记最近一个 calling 状态的同名工具段;无匹配时不操作(错误降级到 chatError)。
 */
export function markToolFailed(msg: Message, name: string, errorMessage: string): void {
	for (let i = msg.segments.length - 1; i >= 0; i--) {
		const seg = msg.segments[i]!;
		if (seg.type === 'tool' && seg.toolCall.name === name && seg.toolCall.status === 'calling') {
			seg.toolCall.status = 'failed';
			seg.toolCall.errorMessage = errorMessage;
			return;
		}
	}
}
