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
import type { Intent } from './intent-classifier';
import { devLogger } from '../logging/dev-logger';
import { mapSearchResults } from './search-result-mapper';

/**
 * Agent Loop 的默认最大步数上限,防止工具调用陷入死循环。
 *
 * 经验值:读 30+ 文件做分析一般需要 15-30 步(1 glob/list + N read + 分析 + write),
 * 50 步足够覆盖大部分场景,同时仍然能防止无限循环。
 *
 * 调用方可通过 `agentLoop()` 的 `maxSteps` 参数覆盖此值(见 ADR-004)。
 */
const DEFAULT_MAX_STEPS = 50;

/**
 * 截断提示文本 — 当回复因步数上限或 max_tokens 被截断时,追加到助手消息末尾。
 */
const TRUNCATION_NOTICE = '\n\n---\n⚠️ **回复因长度限制被截断。** 可以发送「继续」让模型接着输出。';

/**
 * Agent 主循环:驱动一次完整的"用户消息 → LLM 流式回复 → 工具调用 → LLM 续传"流程。
 *
 * 设计要点:
 * - 整个循环放在 `try / finally` 中,确保任意一步抛错或正常结束时都会:
 *   1. 发出 `message.end` 事件(带上 token 统计)
 *   2. 把当前 session 持久化(由 ContextManager.save 处理)
 * - 单步内部再嵌套一层 `try / catch`,把 LLM 流错误和工具执行错误分别转成 `error` 事件,
 *   避免异常逃逸到外层 try,影响 session 保存与 message.end 事件。
 * - 工具执行前经权限门控 → pre-tool-use hooks → execute → post-tool-use / post-tool-failure。
 * - 取消机制:传入 `AbortSignal` 后,每轮循环开始前检查 `aborted` 状态,中止时 yield error 并 break。
 * - 支持一轮内多个工具调用(并行/批量场景):收集全部 toolCall delta 后逐个执行,结果逐条入库。
 * - 截断检测:
 *   - MAX_STEPS 命中时,yield error 事件告知 UI,并在 assistant 消息末尾追加截断提示。
 *   - finishReason === 'length' 时,yield error 事件,追加截断提示,但继续循环(给模型续传机会)。
 *
 * @param req - 用户消息请求(含 sessionId 与 message)
 * @param ctx - 上下文管理器,负责 session 加载/保存与消息累积
 * @param llm - LLM 客户端,产生 ChatDelta 流
 * @param tools - 工具注册表,提供 LLM 可调用的工具列表与执行能力
 * @param hooks - 钩子注册表,提供工具调用前后的治理点
 * @param signal - 可选的 AbortSignal,用于取消循环
 * @param intentClassifier - 可选的意图分类函数,判断用户消息是否需要 RAG 工作流。未传时默认 'direct'(向后兼容)
 * @param toolPermissionCheck - 可选的工具权限检查回调
 * @param maxSteps - 可选的最大步数上限,默认 50(见 ADR-004)
 * @returns AgentEvent 异步可迭代流
 * @throws 不会向上抛错 — 内部错误一律转 `error` 事件
 * @example
 *   const controller = new AbortController();
 *   for await (const event of agentLoop(req, ctx, llm, tools, hooks, controller.signal)) {
 *     ui.emit(event);
 *   }
 */
export async function* agentLoop(
	req: UserChatRequest,
	ctx: ContextManager,
	llm: LLMClient,
	tools: ToolRegistry,
	hooks: HookRegistry,
	signal?: AbortSignal,
	intentClassifier?: (message: string) => Promise<Intent>,
	toolPermissionCheck?: (toolCall: ToolCall) => Promise<void>,
	maxSteps?: number,
): AsyncIterable<AgentEvent> {
	// 关键路径:maxSteps 可配置(见 ADR-004),未传时降级默认值 50。
	const effectiveMaxSteps = maxSteps ?? DEFAULT_MAX_STEPS;
	// 关键路径:保存流末尾的 API 真值 token,finally 阶段 yield 到 message.end
	// 声明在函数顶部,确保 try/finally 与 for 循环都能访问(跨多步累积最后一个 usage)。
	let lastUsage: { promptTokens: number; completionTokens: number } | undefined;
	// 加载或初始化 session,然后把用户消息压入上下文。
	await ctx.load(req.sessionId);
	ctx.addUserMessage(req.message);

	// 关键路径:意图分类,判断是否需要 RAG 工作流。无 classifier 时降级 direct(向后兼容)。
	// 关键路径:分类器异常时静默降级 rag(与 classifyIntent 自身降级方向一致,宁可多搜不漏),
	// 不向上抛错以遵守 agentLoop 的 @throws 契约(message.end 与 save 仍由 finally 保证)。
	let intent: Intent = 'direct';
	if (intentClassifier) {
		try {
			intent = await intentClassifier(req.message);
		} catch {
			// 关键路径:分类失败降级 rag,保证主流程继续(search_vault 仍可工作)
			intent = 'rag';
		}
	}

	try {
		let loopExitedViaBreak = false;

		// 单步循环:每轮产生一段 assistant 回复 + 零到多次工具调用。
		for (let step = 0; step < effectiveMaxSteps; step++) {
			// 关键路径:每轮开始前检查取消信号,中止时 yield error 并退出循环。
			if (signal?.aborted) {
				yield { type: 'error', payload: { code: 'CANCELLED', message: '用户取消' } };
				loopExitedViaBreak = true;
				break;
			}

			yield { type: 'message.start', payload: { role: 'assistant' as const } };

			let accumulatedText = '';
			const toolCalls: ToolCall[] = [];
			let finishReason: string | null = null;
			let streamAborted = false;

			try {
				// 让 LLM 流式产出;逐步把 text 投递给 UI,toolCall 全部收集(支持一轮多工具)。
				const stream = llm.chat({
					messages: ctx.toMessages(intent),
					tools: tools.definitions(),
				});

				for await (const delta of stream) {
					// 关键路径:流式输出期间也检查取消信号,及时停止。
					if (signal?.aborted) {
						streamAborted = true;
						break;
					}
					if (delta.text) {
						accumulatedText += delta.text;
						yield { type: 'message.delta', payload: { text: delta.text } };
					}
					// 关键路径:透传思考过程为 message.delta.reasoning
					if (delta.reasoning) {
						yield { type: 'message.delta', payload: { text: '', reasoning: delta.reasoning } };
					}
					if (delta.toolCall) {
						toolCalls.push(delta.toolCall);
					}
					if (delta.finishReason) {
						finishReason = delta.finishReason;
					}
					// 关键路径:捕获 API 真值 token,finally 阶段 yield
					if (delta.usage) {
						lastUsage = delta.usage;
					}
				}
			} catch (err) {
				// LLM 流中途中断(网络、超时、限流):转 error 事件,把已收到的部分文本作为一条 assistant 消息入库,
				// 然后跳出本轮循环,进入 finally 收尾。
				const message = err instanceof Error ? err.message : String(err);
				yield { type: 'error', payload: { code: 'LLM_ERROR', message } };
				ctx.addAssistantMessage(accumulatedText || `Error: ${message}`);
				loopExitedViaBreak = true;
				break;
			}

			// 关键路径:流式输出被取消时,把已收到的文本存入 session 后退出。
			if (signal?.aborted || streamAborted) {
				yield { type: 'error', payload: { code: 'CANCELLED', message: '用户取消' } };
				ctx.addAssistantMessage(accumulatedText);
				loopExitedViaBreak = true;
				break;
			}

			// 关键路径:检测 max_tokens 截断。finishReason === 'length' 表示模型输出被 token 上限切断,
			// 此时 accumulatedText 可能不完整,且 toolCalls 中最后一个可能有残缺 JSON args(已在适配器层降级)。
			// 策略:追加截断提示入库,并 yield error 让 UI 显示警告;如果有工具调用仍执行,否则 break。
			if (finishReason === 'length') {
				devLogger.warn('agent', `LLM 输出被 max_tokens 截断 (step=${step}),已输出 ${accumulatedText.length} 字符`);
				accumulatedText += TRUNCATION_NOTICE;
				yield { type: 'message.delta', payload: { text: TRUNCATION_NOTICE } };
				// 若截断时无工具调用,通知用户并结束。
				if (toolCalls.length === 0) {
					yield {
						type: 'error',
						payload: {
							code: 'LLM_ERROR',
							message: '模型输出长度达到上限被截断。发送「继续」可让模型接着输出。',
						},
					};
					ctx.addAssistantMessage(accumulatedText);
					loopExitedViaBreak = true;
					break;
				}
				// 有工具调用 → 继续执行工具(截断的 toolCall args 可能有 raw 字段),然后让下一轮 LLM 续传。
			}

			// 无 toolCall → 这一步就是纯文本回答,直接收尾。
			if (toolCalls.length === 0) {
				ctx.addAssistantMessage(accumulatedText);
				loopExitedViaBreak = true;
				break;
			}

			// 关键路径:一轮内逐个执行工具调用(对 UI 展示为逐条 tool.call/tool.result),
			// 每个工具独立过权限门控与钩子,单个失败不阻断其他工具。
			for (const tc of toolCalls) {
				yield { type: 'tool.call', payload: { name: tc.name, args: tc.args } };

				// 权限门控(信任模式/用户确认)
				if (toolPermissionCheck) {
					try {
						await toolPermissionCheck(tc);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						yield { type: 'error', payload: { code: 'TOOL_DENIED', message } };
						ctx.addAssistantToolCall(tc, accumulatedText);
						ctx.addToolResult(tc.id, `Error: ${message}`);
						accumulatedText = '';
						continue;
					}
				}

				// pre-tool-use 钩子
				const preDecision = await hooks.run('pre-tool-use', tc);
				if (!preDecision.allowed) {
					const message = `工具调用被拒绝: ${preDecision.reason ?? '未知原因'}`;
					yield { type: 'error', payload: { code: 'TOOL_DENIED', message } };
					ctx.addAssistantToolCall(tc, accumulatedText);
					ctx.addToolResult(tc.id, `Error: ${message}`);
					accumulatedText = '';
					continue;
				}

				let result: unknown;
				let toolFailed = false;
				try {
					result = await tools.execute(tc);
				} catch (err) {
					toolFailed = true;
					const message = err instanceof Error ? err.message : String(err);
					const code = (err as Error & { code?: string }).code ?? 'TOOL_ERROR';
					yield { type: 'error', payload: { code, message } };
					result = `Error: ${message}`;
					await hooks.runVoid('post-tool-failure', tc);
				}

				yield { type: 'tool.result', payload: { name: tc.name, result } };

				// 关键路径:search_vault 返回后用 mapSearchResults 扁平化(逻辑外迁到 search-result-mapper)
				if (tc.name === 'search_vault') {
					const mapped = mapSearchResults(result);
					if (mapped) {
						yield { type: 'search.result', payload: mapped };
					}
				}

				// 写后钩子:与 pre-tool-use 对称(仅成功时)。
				if (!toolFailed) {
					await hooks.runVoid('post-tool-use', tc);
				}

				// 把 assistant tool call + 工具结果写回 session。
				// 第一个工具携带 accumulatedText(模型在工具调用前的文本),后续工具 text 为空,
				// 避免在上下文中重复插入相同文本。
				ctx.addAssistantToolCall(tc, accumulatedText);
				ctx.addToolResult(tc.id, JSON.stringify(result));
				accumulatedText = '';
			}

			// 截断后执行完工具,继续下一轮让 LLM 续传(不 break)。
		}

		// 关键路径:for 循环通过 break 退出时 loopExitedViaBreak=true(正常结束、错误、取消都已处理),
		// 只有 for 条件失败(step >= MAX_STEPS)时才会走到这里,说明步数上限被命中。
		// 此时模型在最后一步执行了工具但没机会产出最终回答(用户看到的"跑到一半停了")。
		if (!loopExitedViaBreak) {
			devLogger.warn('agent', `Agent Loop 达到 maxSteps=${effectiveMaxSteps} 上限,强制结束`);
			const notice = '\n\n---\n⚠️ **思考步数已达上限,回答可能不完整。** 可以继续对话让模型完成报告。';
			yield { type: 'message.delta', payload: { text: notice } };
			yield {
				type: 'error',
				payload: {
					code: 'LLM_ERROR',
					message: `思考步数达到上限(${effectiveMaxSteps}步),回答可能不完整。`,
				},
			};
			ctx.addAssistantMessage(notice);
		}
	} finally {
		// 收尾:无论正常结束、break 还是异常,都保证发出 message.end + 持久化 session。
		yield {
			type: 'message.end',
			payload: {
				tokens: ctx.tokenCount(),
				promptTokens: lastUsage?.promptTokens,
				completionTokens: lastUsage?.completionTokens,
			},
		};
		await ctx.save();
	}
}
