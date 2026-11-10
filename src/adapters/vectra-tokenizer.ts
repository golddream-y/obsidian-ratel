/**
 * @file src/adapters/vectra-tokenizer.ts
 * @description vectra 分块所需的 tokenizer 适配 — 主包允许在缺少 GPT 词表时降级
 * @module adapters/vectra-tokenizer
 * @depends vectra
 *
 * 设计要点:
 * - vectra 的 `LocalDocumentIndex` 构造时必须拿到 tokenizer,而它的默认实现会把
 *   `gpt-tokenizer` 的 o200k 词表(约 2.6MB)带进主包。主线程从不做文档分块:
 *   仓库索引走索引线程的 `replaceFile`(预计算块),记忆索引走 `upsertItem`,
 *   主线程只读检索,不会调用 `encode/decode`。
 * - 因此主构建把 `gpt-tokenizer` 替换为空模块(`__RATEL_VECTRA_GPT_TOKENIZER__ = false`),
 *   本模块返回可逆的降级 tokenizer;索引线程构建保留真实实现,返回 `undefined`
 *   让 vectra 使用自带的 GPT 分词,行为与改造前完全一致。
 * - 降级实现只保证 encode/decode 可逆且不抛错,不保证与 GPT 词表同边界;任何需要
 *   精确 GPT token 边界的分块必须放在索引线程执行。
 */

import type { Tokenizer } from 'vectra';

/**
 * 构造可逆的降级 tokenizer — 一个 Unicode 码点对应一个 token。
 *
 * 关键路径:`decode(encode(text)) === text` 是 vectra 切块逻辑的硬要求;
 * 码点级映射满足该要求,同时避免引入任何词表数据。
 *
 * @returns 支持 encode/decode 的 tokenizer。
 */
function createFallbackTokenizer(): Tokenizer {
	return {
		encode(text: string): number[] {
			const tokens: number[] = [];
			for (const char of text) tokens.push(char.codePointAt(0) ?? 0);
			return tokens;
		},
		decode(tokens: number[]): string {
			let text = '';
			for (const token of tokens) text += String.fromCodePoint(token);
			return text;
		},
	};
}

/**
 * 创建 vectra 使用的 tokenizer。
 *
 * 关键路径:保留 GPT 词表的构建返回 `undefined`,让 `LocalDocumentIndex` 走默认实现;
 * 只有主包(词表被替换为空模块)才注入降级实现,避免 `new GPT3Tokenizer()` 解引用空模块。
 *
 * @param hasGptTokenizer - 当前构建是否保留 GPT 词表;默认取构建期 define,测试可显式覆盖。
 * @returns 降级 tokenizer;当前构建保留真实分词时返回 undefined。
 */
export function createVectraTokenizer(
	hasGptTokenizer: boolean = __RATEL_VECTRA_GPT_TOKENIZER__,
): Tokenizer | undefined {
	if (hasGptTokenizer) return undefined;
	return createFallbackTokenizer();
}
