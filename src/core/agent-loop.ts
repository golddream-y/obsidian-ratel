/**
 * @file src/core/agent-loop.ts
 * @description Agent Loop — 主控循环,负责调度 LLM、工具调用、Hook 钩子,产出 AgentEvent 流。
 * @module core/agent-loop
 * @depends ../types, ../ports/llm, ./context-manager, ./tool-registry, ./hooks
 */

import type { UserChatRequest, AgentEvent } from '../types';
import type { LLMClient, ToolCall } from '../ports/llm';
import type { ContextManager } from './context-manager';
import type { ToolRegistry } from './tool-registry';
import type { HookRegistry } from './hooks';

/**
 * Agent Loop 的最大步数上限,防止工具调用陷入死循环。
 */
const MAX_STEPS = 10;

/**
 * Agent 主循环:驱动一次完整的"用户消息 → LLM 流式回复 → 工具调用 → LLM 续传"流程。
 *
 * 设计要点:
 * - 整个循环放在 `try / finally` 中,确保任意一步抛错或正常结束时都会:
 *   1. 发出 `message.end` 事件(带上 token 统计)
 *   2. 把当前 session 持久化(由 ContextManager.save 处理)
 * - 单步内部再嵌套一层 `try / catch`,把 LLM 流错误和工具执行错误分别转成 `error` 事件,
 *   避免异常逃逸到外层 try,影响 session 保存与 message.end 事件。
 * - 工具调用只对"写工具"(`readOnly !== true`)触发 pre/post hook,避免读操作触发治理。
 *
 * @param req - 用户消息请求(含 sessionId 与 message)
 * @param ctx - 上下文管理器,负责 session 加载/保存与消息累积
 * @param llm - LLM 客户端,产生 ChatDelta 流
 * @param tools - 工具注册表,提供 LLM 可调用的工具列表与执行能力
 * @param hooks - 钩子注册表,提供工具调用前后的治理点
 * @returns AgentEvent 异步可迭代流
 * @throws 不会向上抛错 — 内部错误一律转 `error` 事件
 * @example
 *   for await (const event of agentLoop(req, ctx, llm, tools, hooks)) {
 *     ui.emit(event);
 *   }
 */
export async function* agentLoop(
	req: UserChatRequest,
	ctx: ContextManager,
	llm: LLMClient,
	tools: ToolRegistry,
	hooks: HookRegistry,
): AsyncIterable<AgentEvent> {
	// 加载或初始化 session,然后把用户消息压入上下文。
	await ctx.load(req.sessionId);
	ctx.addUserMessage(req.message);

	try {
		// 单步循环:每轮产生一段 assistant 回复 + (可选)一次工具调用。
		for (let step = 0; step < MAX_STEPS; step++) {
			yield { type: 'message.start', payload: { role: 'assistant' as const } };

			let accumulatedText = '';
			let toolCall: ToolCall | null = null;

			try {
				// 让 LLM 流式产出;逐步把 text 投递给 UI,toolCall 在最后保留(单轮只支持一个工具调用)。
				const stream = llm.chat({
					messages: ctx.toMessages(),
					tools: tools.definitions(),
				});

				for await (const delta of stream) {
					if (delta.text) {
						accumulatedText += delta.text;
						yield { type: 'message.delta', payload: { text: delta.text } };
					}
					if (delta.toolCall) {
						toolCall = delta.toolCall;
					}
				}
			} catch (err) {
				// LLM 流中途中断(网络、超时、限流):转 error 事件,把已收到的部分文本作为一条 assistant 消息入库,
				// 然后跳出本轮循环,进入 finally 收尾。
				const message = err instanceof Error ? err.message : String(err);
				yield { type: 'error', payload: { code: 'LLM_ERROR', message } };
				ctx.addAssistantMessage(accumulatedText || `Error: ${message}`);
				break;
			}

			// 无 toolCall → 这一步就是纯文本回答,直接收尾。
			if (!toolCall) {
				ctx.addAssistantMessage(accumulatedText);
				break;
			}

			yield { type: 'tool.call', payload: { name: toolCall.name, args: toolCall.args } };

			// 写前钩子:仅对写工具触发(读工具直接跳过,避免对搜索/读取等无害操作产生治理噪音)。
			if (!tools.isReadOnly(toolCall.name)) {
				await hooks.run('pre-write', toolCall);
			}

			// 执行工具:即便工具抛错,也要把错误信息作为 result 返回给 LLM,让它有机会自我修正,
			// 而不是把异常向上抛导致 session 状态不一致。
			let result: unknown;
			try {
				result = await tools.execute(toolCall);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				yield { type: 'error', payload: { code: 'TOOL_ERROR', message } };
				result = `Error: ${message}`;
			}

			yield { type: 'tool.result', payload: { name: toolCall.name, result } };

			// 写后钩子:与 pre-write 对称。
			if (!tools.isReadOnly(toolCall.name)) {
				await hooks.run('post-write', toolCall);
			}

			// 把这一轮的 assistant tool call + 工具结果写回 session,
			// 让下一轮 LLM 能看到完整的多轮上下文。
			ctx.addAssistantToolCall(toolCall, accumulatedText);
			ctx.addToolResult(toolCall.id, JSON.stringify(result));
		}
	} finally {
		// 收尾:无论正常结束、break 还是异常,都保证发出 message.end + 持久化 session。
		yield { type: 'message.end', payload: { tokens: ctx.tokenCount() } };
		await ctx.save();
	}
}
