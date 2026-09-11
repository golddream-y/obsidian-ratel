/**
 * @file src/core/intent-classifier.ts
 * @description 轻量意图分类器 — 一次 LLM 调用判断用户消息是否需要走 RAG 工作流
 * @module core/intent-classifier
 * @depends ports/llm, prompts/composer, prompts/types
 */

import type { LLMClient } from '../ports/llm';
import { composeInternalMessages } from '../prompts/composer';
import type { OverrideMap } from '../prompts/types';

/**
 * 用户消息意图。
 * - 'rag' = 需要搜索知识库(问笔记内容、查关系、找信息)
 * - 'direct' = 直接回答(通用问题、生成任务、统计、闲聊)
 */
export type Intent = 'rag' | 'direct';

export interface IntentClassifierDeps {
	llm: LLMClient;
	// 关键路径:可选的 section 覆盖,允许 settings 自定义内部 LLM 提示词
	overrides?: OverrideMap;
	/** 取消信号 — 必须穿透到 llm.chat,否则思考阶段点停止会卡在分类请求上 */
	signal?: AbortSignal;
}

/**
 * 用一次快速 LLM 调用判断用户消息意图。
 *
 * 关键路径:
 * - 提示词极简,只要求回答 'rag' 或 'direct',降低 token 成本
 * - maxTokens 限制为 5,避免 LLM 啰嗦
 * - 解析失败或 LLM 异常时降级为 'rag'(宁可多搜一次,不漏知识库内容)
 *
 * @param message - 用户消息
 * @param deps - 依赖(LLM 客户端 + 可选 overrides / signal)
 * @returns 'rag' = 需要搜索知识库;'direct' = 直接回答
 * @throws 用户 abort 时抛出,不降级 rag(否则停止钮会被分类请求吞掉)
 */
export async function classifyIntent(
	message: string,
	deps: IntentClassifierDeps,
): Promise<Intent> {
	const messages = composeInternalMessages(
		'intent',
		{ tools: [], message },
		deps.overrides ?? {},
	);

	try {
		let output = '';
		// 关键路径:maxTokens=5 限制输出长度,降低成本(意图词 + 少量噪声)
		const stream = deps.llm.chat({
			messages,
			options: { maxTokens: 5 },
			signal: deps.signal,
		});
		for await (const delta of stream) {
			if (deps.signal?.aborted) throw new Error('请求已取消');
			if (delta.text) output += delta.text;
		}

		const trimmed = output.trim().toLowerCase();
		// 关键路径:包含匹配 'rag'/'direct' 子串,优先 rag(安全降级方向)
		if (trimmed.includes('rag')) return 'rag';
		if (trimmed.includes('direct')) return 'direct';
		// 未识别输出 → 降级 rag
		return 'rag';
	} catch (err) {
		// 关键路径:用户停止禁止降级 rag — 降级会让 agentLoop 继续主 LLM
		if (deps.signal?.aborted) throw err instanceof Error ? err : new Error('请求已取消');
		// 关键路径:LLM 异常不阻断主流程,降级为 rag
		return 'rag';
	}
}
