/**
 * @file src/core/token-counter.ts
 * @description 文本 token 计数 — 本地词表精确计数,缺词表时按字符上界估算。
 * @module core/token-counter
 * @depends adapters/bert-tokenizer
 */

import { createTokenizer, parseVocab } from '../adapters/bert-tokenizer';

/**
 * token 计数器 — 分块层拿到 token 数的唯一入口。
 */
/**
 * 预算余量 — 从模型输入上限里预留给 [CLS]/[SEP] 与结构前缀的 token 数。
 *
 * 关键路径:主线程与 Worker 兜底值都用它,避免两处各算一套导致块长不一致。
 */
export const TOKEN_BUDGET_RESERVE = 64;

export interface TokenCounter {
	/** true = 词表精确计数;false = 字符上界估算。 */
	readonly exact: boolean;
	/** 模型输入上限(token,含特殊 token)。 */
	readonly maxInputTokens: number;
	/** 单条文本的内容 token 数(不含 [CLS]/[SEP])。 */
	count(text: string): number;
}

/**
 * 构造计数器。
 *
 * 关键路径:估算方向必须是「高估」——高估只会让块更小,
 * 低估会让块超出模型上限并被静默截断。
 *
 * @param vocabContent - vocab.txt 文本;为空表示没有本地词表(如 API embedding)。
 * @param maxInputTokens - 模型输入上限,默认 bge-small 的 512。
 * @returns 计数器实例。
 */
export function createTokenCounter(
	vocabContent: string | null,
	maxInputTokens = 512,
): TokenCounter {
	if (!vocabContent) {
		// 关键路径:无词表时用字符数作上界,宁可块小也不要让模型侧静默截断。
		return { exact: false, maxInputTokens, count: (text) => text.length };
	}
	const tokenizer = createTokenizer(parseVocab(vocabContent));
	return {
		exact: true,
		maxInputTokens,
		// 关键路径:走 tokenize 而非 encode,不受输入上限截断影响。
		count: (text) => tokenizer.tokenize(text).length,
	};
}
