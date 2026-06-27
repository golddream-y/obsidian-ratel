/**
 * @file src/ui/tokens/token-estimator.ts
 * @description 中英混合 token 估算 — 比纯 length/4 更准,不引入第三方库
 * @module ui/tokens/token-estimator
 */

/**
 * 中英混合 token 估算。
 *
 * 权重依据:
 * - ASCII Latin:平均 ~4 字符/token(英文单词 + 空格 + 标点)
 * - CJK 中文:平均 ~1.5 字符/token(BPE 分词后中文 token 密度高)
 * - 数字与符号:~3 字符/token
 *
 * 仍为估算,真值靠 message.end 的 API usage 校准。
 *
 * @param text - 待估算文本
 * @returns 估算 token 数(向上取整)
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	let asciiCount = 0;
	let cjkCount = 0;
	let otherCount = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		if (code < 0x80) asciiCount++;
		else if (code >= 0x4e00 && code <= 0x9fff) cjkCount++;
		else otherCount++;
	}
	return Math.ceil(asciiCount / 4 + cjkCount / 1.5 + otherCount / 3);
}
