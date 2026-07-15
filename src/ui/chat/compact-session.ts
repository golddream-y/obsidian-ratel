/**
 * @file src/ui/chat/compact-session.ts
 * @description /compact 命令实现 — fork LLM 摘要 + 保留最近 3 条原文 + 重置 session
 * @module ui/chat/compact-session
 * @depends ../../core/context-manager, ../../ports/llm, ../../prompts/composer
 */

import type { ContextManager } from '../../core/context-manager';
import { alignPreservedToolMessages } from '../../core/tool-message-align';
import type { LLMClient, ChatDelta } from '../../ports/llm';
import type { ChatMessage } from '../../ports/persistence';
import { composeCompactMessages } from '../../prompts/composer';
import type { OverrideMap } from '../../prompts/types';
import { tNow } from '../../i18n';

/**
 * 保留最近 N 条原文(混合 user/assistant),保证压缩后上下文连续性。
 */
const PRESERVED_COUNT = 3;

/**
 * /compact 结果。
 */
export interface CompactResult {
	summary: string;
	preservedMessages: ChatMessage[];
}

/**
 * 把对话历史压成结构化摘要,保留最近 3 条原文,重置 session。
 *
 * 流程(Claude Code 式):
 * 1. 拉 session 全部 messages(过滤掉 system)
 * 2. 历史不足 PRESERVED_COUNT 条则全部保留,不调 LLM(避免无意义压缩)
 * 3. 否则保留最后 PRESERVED_COUNT 条,把剩余 messages 拼成对话文本
 * 4. fork 一次 LLM 调用做结构化摘要
 * 5. 调 ctx.resetSession(sessionId, summary, preservedMessages) 重置 session
 *
 * 关键路径:LLM 调用先于 resetSession。若 LLM 抛错,session 保持原状(不破坏当前上下文),
 * 用户可重试 /compact;只有摘要成功后才执行重置。
 *
 * @param ctx - ContextManager 实例
 * @param llm - LLM 客户端,用于摘要
 * @param sessionId - 会话 ID
 * @param overrides - 可选 prompt section 覆盖(默认空对象)
 * @returns 摘要 + 保留的原文消息
 * @throws LLM 调用失败时抛原错误,session 不重置
 */
export async function compactSession(
	ctx: ContextManager,
	llm: LLMClient,
	sessionId: string,
	overrides: OverrideMap = {},
): Promise<CompactResult> {
	await ctx.load(sessionId);
	// 关键路径:toMessages 含 Composer 注入的 system prompt,需过滤掉只取会话历史。
	// 这里不直接访问 session.messages(私有状态),只通过 toMessages 公开 API 取。
	const allMessages = ctx.toMessages('direct').filter((m) => m.role !== 'system');

	// 边界:历史不足 PRESERVED_COUNT 条,直接全部保留,不调 LLM(避免无意义压缩)
	if (allMessages.length <= PRESERVED_COUNT) {
		return { summary: '', preservedMessages: allMessages };
	}

	const preservedMessages = alignPreservedToolMessages(allMessages.slice(-PRESERVED_COUNT));
	// 关键路径:摘要输入仍按原始窗口切分(与对齐前一致),避免把丢弃的孤立 tool 正文漏进摘要又重复保留
	const summaryInputMessages = allMessages.slice(0, -PRESERVED_COUNT);

	// 拼成对话文本,作为 LLM 摘要输入
	const history = summaryInputMessages
		.map((m) => `${m.role}: ${m.content}`)
		.join('\n');

	// 关键路径:fork LLM 调用做摘要,与主对话流独立(不影响主上下文)
	const llmMessages = composeCompactMessages({ history }, overrides);
	const summary = await collectStream(llm.chat({ messages: llmMessages }));

	// 关键路径:LLM 返回空摘要视为异常,避免注入空 system 消息
	if (!summary.trim()) {
		throw new Error(tNow('error.compact.emptySummary'));
	}

	// 关键路径:LLM 成功后才重置 session。resetSession 内部先 delete 再 load,
	// delete 失败时抛错(此时 session 仍是旧的,符合"原子性"预期)
	await ctx.resetSession(sessionId, summary, preservedMessages);

	return { summary, preservedMessages };
}

/**
 * 拼接 LLM 流式 delta 为字符串。
 *
 * @param stream - LLM chat 返回的异步迭代流
 * @returns 拼接后的完整文本
 */
async function collectStream(stream: AsyncIterable<ChatDelta>): Promise<string> {
	let result = '';
	for await (const delta of stream) {
		// 关键路径:只取最终输出文本,忽略 reasoning(思考过程不进摘要)
		if (delta.text) result += delta.text;
	}
	return result;
}
