/**
 * @file src/core/intent-classifier.ts
 * @description 轻量意图分类器 — 一次 LLM 调用判断用户消息是否需要走 RAG 工作流
 * @module core/intent-classifier
 * @depends ports/llm
 */

import type { LLMClient, ChatMessage } from '../ports/llm';

/**
 * 用户消息意图。
 * - 'rag' = 需要搜索知识库(问笔记内容、查关系、找信息)
 * - 'direct' = 直接回答(通用问题、生成任务、统计、闲聊)
 */
export type Intent = 'rag' | 'direct';

export interface IntentClassifierDeps {
	llm: LLMClient;
}

/**
 * 意图分类提示词 — 中英文混合,因 LLM 可能用任一语言回答用户。
 * 关键路径:只要求回答一个词,降低 token 成本(maxTokens=5)。
 */
const INTENT_PROMPT_TEMPLATE = (message: string): string =>
	`判断以下用户消息是否需要搜索 Obsidian 知识库来回答。
只回答一个词:'rag'(需要搜索)或 'direct'(不需要搜索)。

需要搜索(rag)的例子:
- 问知识库内容:"我的笔记里有什么关于 X 的内容?"
- 问笔记关系:"X 和 Y 有什么联系?"
- 查找信息:"我写过关于 X 的东西吗?"

不需要搜索(direct)的例子:
- 通用问题:"今天天气怎么样?"
- 生成任务:"帮我写一个模板"
- 统计任务:"库里有几个文件夹?"
- 闲聊:"你好"

用户消息:${message}
回答:`;

/**
 * 用一次快速 LLM 调用判断用户消息意图。
 *
 * 关键路径:
 * - 提示词极简,只要求回答 'rag' 或 'direct',降低 token 成本
 * - maxTokens 限制为 5,避免 LLM 啰嗦
 * - 解析失败或 LLM 异常时降级为 'rag'(宁可多搜一次,不漏知识库内容)
 *
 * @param message - 用户消息
 * @param deps - 依赖(LLM 客户端)
 * @returns 'rag' = 需要搜索知识库;'direct' = 直接回答
 */
export async function classifyIntent(
	message: string,
	deps: IntentClassifierDeps,
): Promise<Intent> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: 'You are a helpful intent classifier. Reply with exactly one word: rag or direct.' },
		{ role: 'user', content: INTENT_PROMPT_TEMPLATE(message) },
	];

	try {
		let output = '';
		// 关键路径:maxTokens=5 限制输出长度,降低成本(意图词 + 少量噪声)
		const stream = deps.llm.chat({ messages, options: { maxTokens: 5 } });
		for await (const delta of stream) {
			if (delta.text) output += delta.text;
		}

		const trimmed = output.trim().toLowerCase();
		// 关键路径:包含匹配 'rag'/'direct' 子串,优先 rag(安全降级方向)
		if (trimmed.includes('rag')) return 'rag';
		if (trimmed.includes('direct')) return 'direct';
		// 未识别输出 → 降级 rag
		return 'rag';
	} catch {
		// 关键路径:LLM 异常不阻断主流程,降级为 rag
		return 'rag';
	}
}
