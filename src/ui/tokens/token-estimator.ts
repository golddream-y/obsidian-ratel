/**
 * @file src/ui/tokens/token-estimator.ts
 * @description 中英混合 token 估算 — 比纯 length/4 更准,不引入第三方库
 * @module ui/tokens/token-estimator
 */

/**
 * 可估算消息的最小形状 — 与 Message.segments 结构兼容,避免 tokens 反依赖 chat 模块。
 * 只认 text / think;其余段(tool / image / citation)不计。
 */
export type TokenCountableMessage = {
	segments: ReadonlyArray<{ type: string; text?: string }>;
};

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

/**
 * 按消息列表估算上下文占用 — 仅累计 text / think 段。
 *
 * 用途:会话 hydrate / 发送前 baseline。tool / image / citation 不计
 * (与发送路径历史算法一致;真值仍靠 API usage 校准)。
 *
 * @param messages - 含 segments 的消息列表
 * @returns 估算 token 总数
 */
export function estimateMessagesTokens(messages: ReadonlyArray<TokenCountableMessage>): number {
	return messages.reduce(
		(sum, m) =>
			sum +
			m.segments.reduce((s, seg) => {
				if ((seg.type === 'text' || seg.type === 'think') && typeof seg.text === 'string') {
					return s + estimateTokens(seg.text);
				}
				return s;
			}, 0),
		0,
	);
}
