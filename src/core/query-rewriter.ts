/**
 * @file src/core/query-rewriter.ts
 * @description 查询改写器 — 用 LLM 把用户查询改写成 2 个语义变体,扩大检索召回
 * @module core/query-rewriter
 * @depends ports/llm
 */

import type { LLMClient, ChatMessage } from '../ports/llm';

/**
 * 改写后的查询项。
 * @param text - 查询文本(原始或改写后)。
 * @param variant - 来源标识:'original' = 用户原始查询;'rewrite-1' / 'rewrite-2' = LLM 改写。
 */
export interface RewrittenQuery {
	text: string;
	variant: 'original' | 'rewrite-1' | 'rewrite-2';
}

/**
 * 查询改写器依赖。
 */
export interface QueryRewriterDeps {
	llm: LLMClient;
}

/**
 * 改写提示词模板 — 要求 LLM 生成 2 个语义变体。
 *
 * 关键路径:
 * - 中英文混合,因 LLM 可能用任一语言回答。
 * - 要求每行一个变体,不加编号,便于解析。
 * - maxTokens=100,2 个改写 * ~50 tokens 足够。
 */
const REWRITE_PROMPT_TEMPLATE = (query: string): string =>
	`把以下查询改写成 2 个语义变体,用于知识库检索扩大召回。
要求:
- 保持原意,不改变问题范围
- 换用同义词或不同表述方式
- 每行一个变体,不加编号

原始查询:${query}

改写变体:`;

/**
 * 把用户查询改写成 2 个语义变体。
 *
 * 关键路径:
 * - 原始查询始终保留在结果首位(variant: 'original')。
 * - LLM 生成 1-2 个改写变体(variant: 'rewrite-1' / 'rewrite-2')。
 * - LLM 异常或返回空时降级为只返回原始查询,不阻断主流程。
 * - maxTokens=100,降低 token 成本。
 *
 * @param query - 用户原始查询。
 * @param deps - 依赖(LLM 客户端)。
 * @returns 包含原始查询 + 改写变体的数组;LLM 失败时只含原始查询。
 */
export async function rewriteQuery(
	query: string,
	deps: QueryRewriterDeps,
): Promise<RewrittenQuery[]> {
	// 关键路径:原始查询始终保留,即使 LLM 失败也能继续检索。
	const result: RewrittenQuery[] = [
		{ text: query, variant: 'original' },
	];

	try {
		const messages: ChatMessage[] = [
			{
				role: 'system',
				content: 'You are a query rewriting assistant. Generate 2 semantic variants of the user query for knowledge base retrieval. One variant per line, no numbering.',
			},
			{ role: 'user', content: REWRITE_PROMPT_TEMPLATE(query) },
		];

		let output = '';
		// 关键路径:maxTokens=100,2 个改写 * ~50 tokens。
		const stream = deps.llm.chat({ messages, options: { maxTokens: 100 } });
		for await (const delta of stream) {
			if (delta.text) output += delta.text;
		}

		// 关键路径:按行分割,去除编号前缀和空白行。
		const variants = output
			.split('\n')
			.map((line) => line.replace(/^\d+\.\s*/, '').trim())
			.filter((line) => line.length > 0)
			.slice(0, 2);

		variants.forEach((text, i) => {
			result.push({
				text,
				variant: i === 0 ? 'rewrite-1' : 'rewrite-2',
			});
		});
	} catch {
		// 关键路径:LLM 异常不阻断主流程,降级为只返回原始查询。
	}

	return result;
}
