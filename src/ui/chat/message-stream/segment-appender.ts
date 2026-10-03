/**
 * @file src/ui/chat/message-stream/segment-appender.ts
 * @description segments 追加/合并/工具结果回填/失败标记 — ChatView 不再直接操作 segments 数组
 * @module ui/chat/message-stream/segment-appender
 * @depends ./types
 */

import type { ToolArgsIssue } from '../../../ports/llm';
import { formatToolArgsUserError } from '../tool-args-error';
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
 * 向 message.segments 追加工具调用段，并统一参数失败的即时展示。
 *
 * @param msg - 接收工具段的助手消息
 * @param tc - 工具调用及可选参数失败证据
 * @returns 无返回值，原地追加到消息流
 * @example
 *   appendToolCall(msg, { name: 'read_note', displayName: '查看笔记', args: {}, status: 'calling', startAt: 0 });
 */
export function appendToolCall(msg: Message, tc: ToolCallEntry): void {
	// 修复:参数失败即时展示真实原因，不从无法解析的正文猜测笔记路径。
	if (tc.argsIssue) {
		tc.args = {};
		tc.displayName = tc.name;
		tc.status = 'failed';
		tc.errorMessage = formatToolArgsUserError(tc.argsIssue);
	}
	msg.segments.push({ type: 'tool', toolCall: tc });
}

/**
 * 把工具调用结果回填到最近一个尚未带结果的同名工具段。
 * 失败事件会先把状态改成 failed；这里仍回填到那一行，避免再追加一条工具原名。
 * 若未找到匹配段(异常时序),降级为追加一个已完成的工具段。
 *
 * @param msg - 待回填的助手消息
 * @param name - 原始工具名
 * @param result - 模型消费的工具结果，参数失败时仅展示本地化副本
 * @param argsIssue - 可选失败证据；缺省保留已有证据，null 表示成功解析
 * @returns 无返回值，原地回填或追加工具段
 * @example
 *   attachToolResult(msg, 'read_note', { content: '正文' }, null);
 */
export function attachToolResult(
	msg: Message, name: string, result: unknown, argsIssue?: ToolArgsIssue | null,
): void {
	for (let i = msg.segments.length - 1; i >= 0; i--) {
		const seg = msg.segments[i]!;
		if (seg.type !== 'tool' || seg.toolCall.name !== name) continue;
		const open = seg.toolCall.status === 'calling'
			|| (seg.toolCall.status === 'failed' && seg.toolCall.result === undefined);
		if (!open) continue;
		// 关键路径:缺省结果元数据不能擦除调用事件已保存的失败证据。
		if (argsIssue !== undefined) seg.toolCall.argsIssue = argsIssue;
		if (seg.toolCall.argsIssue) {
			seg.toolCall.args = {};
			seg.toolCall.displayName = name;
			seg.toolCall.status = 'failed';
			seg.toolCall.errorMessage = formatToolArgsUserError(seg.toolCall.argsIssue);
			seg.toolCall.result = `Error: ${seg.toolCall.errorMessage}`;
			return;
		}
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
	const userError = argsIssue ? formatToolArgsUserError(argsIssue) : undefined;
	if (userError) result = `Error: ${userError}`;
	msg.segments.push({
		type: 'tool',
		toolCall: {
			name,
			displayName: name,
			args: {},
			...(argsIssue !== undefined ? { argsIssue } : {}),
			status: typeof result === 'string' && result.startsWith('Error:') ? 'failed' : 'done',
			errorMessage: userError ?? (typeof result === 'string' && result.startsWith('Error:') ? result : undefined),
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
