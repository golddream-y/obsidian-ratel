/**
 * @file src/core/turn-carry.ts
 * @description 正文过短时同一轮再请求一次，不依赖思考过程长短
 * @module core/turn-carry
 */

/** 可见正文上限（码点数）：达到或超过则不触发续写。 */
export const SHORT_OUTLINE_MAX_CHARS = 200;

/** 续写时仅当次 LLM 请求追加的系统提示，不写入 session。 */
export const CARRY_SYSTEM = '按你刚写的计划，把正文写出来；不要再重列提纲。若刚才的工具只返回了笔记约束、并没有真正写入或删除，请用相同参数再调用一次。';

export type ShouldCarryShortOutlineInput = {
	visibleChars: number;
	reasoningChars: number;
	wroteNote: boolean;
	alreadyCarried: boolean;
};

/**
 * 判断是否应在同一轮用户消息内再请求一次模型。
 *
 * 条件：可见正文至少 1 码点且严格少于 {@link SHORT_OUTLINE_MAX_CHARS}、
 * 本轮尚未成功写笔记、且尚未续写过。思考过程可为空，长短不参与判断。
 *
 * @param input - 可见字数（码点）、写笔记与续写标记；reasoningChars 保留给调用方，此处不使用
 * @returns 为 true 时 agent loop 应 continue 并附带 {@link CARRY_SYSTEM}
 */
export function shouldCarryShortOutline(input: ShouldCarryShortOutlineInput): boolean {
	const { visibleChars, wroteNote, alreadyCarried } = input;
	if (alreadyCarried || wroteNote) {
		return false;
	}
	if (visibleChars <= 0 || visibleChars >= SHORT_OUTLINE_MAX_CHARS) {
		return false;
	}
	return true;
}
