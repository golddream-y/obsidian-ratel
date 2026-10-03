/**
 * @file src/core/truncated-tool-call.ts
 * @description 判断工具参数是否因输出截断而没有解析成 JSON
 * @module core/truncated-tool-call
 */

/** 交给模型的说明。不走 i18n。 */
export const TRUNCATED_TOOL_ARGS_ERROR =
	'参数因输出长度被截断，未执行。若文件已在库中，换路径用 move_note，另存一份用 copy_note，不要把正文再写入 write_note。';

/**
 * 适配器在 JSON 解析失败时只留下 raw。这种参数不能执行。
 */
export function isTruncatedToolArgs(args: Record<string, unknown>): boolean {
	return typeof args.raw === 'string' && Object.keys(args).length === 1;
}
