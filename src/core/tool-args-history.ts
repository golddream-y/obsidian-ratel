/**
 * @file src/core/tool-args-history.ts
 * @description 将失败工具协议节点投影成不含原始参数的模型说明
 * @module core/tool-args-history
 * @depends ports/llm, core/tool-args
 */
import type { ChatMessage } from '../ports/llm';
import { getToolArgsIssue,formatToolArgsModelError } from './tool-args';

/**
 * 创建出站历史副本，保留失败调用正文与思考，移除其工具协议和对应结果。
 *
 * @param messages - 原始会话消息，只读且不回写持久层
 * @returns 幂等的模型出站消息序列，正常调用配对保持原样
 * @example
 *   const safeHistory = projectToolArgsFailures(session.messages);
 */
export function projectToolArgsFailures(messages: readonly ChatMessage[]): ChatMessage[] {
	const failedIds=new Set<string>();
	for(const m of messages) {
		if(m.role==='assistant'&&m.toolCallId&&getToolArgsIssue(m.toolArgs??{},m.toolArgsIssue)) failedIds.add(m.toolCallId);
	}
	return messages.flatMap(m => {
		// 关键路径:失败调用与结果必须同时移出协议，否则产生孤立 tool 或伪造业务参数。
		if(m.role==='tool'&&m.toolCallId&&failedIds.has(m.toolCallId)) return [];
		if(m.role!=='assistant'||!m.toolCallId||!failedIds.has(m.toolCallId)) return [m];
		const issue=getToolArgsIssue(m.toolArgs??{},m.toolArgsIssue);
		if(!issue) return [m];
		const { toolCallId,toolName,toolArgs,toolArgsIssue,...rest }=m;
		void toolCallId; void toolArgs; void toolArgsIssue;
		const feedback=`[工具调用未执行] ${formatToolArgsModelError(toolName??'unknown',issue)}`;
		return [{ ...rest,content: [m.content,feedback].filter(Boolean).join('\n') }];
	});
}
