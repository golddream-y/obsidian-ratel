/**
 * @file src/core/tool-result-prune.ts
 * @description 单条工具结果 / 检索块码点裁剪 — 超限保留头尾并标注省略
 * @module core/tool-result-prune
 */

/** 单条工具结果 / 检索块进上送包的码点硬上限(单条 tool 结果的上下文预算,量级对齐 Codex ~16k token/条) */
export const TOOL_RESULT_LIMIT_CODEPOINTS = 32_000;
/** 超限时保留头部码点数(头:尾 = 4:1,头部通常是列表/代码主体) */
export const PRUNE_HEAD_CODEPOINTS = 24_000;
/** 超限时保留尾部码点数(尾部保留结论与报错信息) */
export const PRUNE_TAIL_CODEPOINTS = 6_000;

/**
 * 按 Unicode 码点裁超长文本:超限保留头尾、中间标省略;未超原样返回。
 *
 * 设计要点:
 * - 用 Array.from 按码点展开,禁止按 UTF-16 拦腰切开代理对(emoji 等多字节字符)。
 * - 纯文本工具函数,不含 Error: 豁免逻辑 — 豁免判断留给 ContextManager 的 tool 场景调用处。
 * - 只作用于上送副本,调用方负责不改 session.messages 原文。
 *
 * @param content - 待裁文本
 * @param limit - 码点上限(默认 32,000)
 * @param headKeep - 保留头部码点数(默认 24,000)
 * @param tailKeep - 保留尾部码点数(默认 6,000)
 * 前置条件:headKeep + tailKeep ≤ limit,超出抛 RangeError(开发者错误显式暴露)。
 * @returns 裁剪后文本;未超限返回原字符串(引用相等,便于调用方跳过拷贝)
 */
export function pruneOverlongText(
	content: string,
	limit: number = TOOL_RESULT_LIMIT_CODEPOINTS,
	headKeep: number = PRUNE_HEAD_CODEPOINTS,
	tailKeep: number = PRUNE_TAIL_CODEPOINTS,
): string {
	// 关键路径:参数防御在快路径之前 — head+tail > limit 时裁完仍超限、头尾拼接可能比原文还长,
	// 属调用方 bug 显式抛错;恰好 == limit 时裁后恰好达标,合法(见 emoji 码点用例)。
	if (headKeep + tailKeep > limit) {
		throw new RangeError('裁剪参数非法:headKeep + tailKeep 不得大于 limit');
	}
	// 关键路径:快路径 — UTF-16 length ≤ limit ⇒ 码点数必然 ≤ limit,无需展开
	if (content.length <= limit) return content;
	const chars = Array.from(content);
	if (chars.length <= limit) return content;
	const omitted = chars.length - headKeep - tailKeep;
	const head = chars.slice(0, headKeep).join('');
	const tail = chars.slice(-tailKeep).join('');
	return `${head}\n[truncated ${omitted} chars]\n${tail}`;
}
