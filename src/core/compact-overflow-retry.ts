/**
 * @file src/core/compact-overflow-retry.ts
 * @description 上下文溢出后是否应压缩并重试一轮的纯函数判定
 * @module core/compact-overflow-retry
 */

/**
 * 判定 ask 在收到 CONTEXT_OVERFLOW 后是否应触发压缩并重试 agentLoop。
 *
 * @param input.code - 错误码
 * @param input.toolsAlreadyRun - 本轮是否已执行过工具
 * @param input.alreadyRetried - 是否已重试过一轮
 * @returns 是否应压缩并重试
 */
export function shouldRetryAfterOverflow(input: {
	code: string;
	toolsAlreadyRun: boolean;
	alreadyRetried: boolean;
}): boolean {
	return input.code === 'CONTEXT_OVERFLOW' && !input.toolsAlreadyRun && !input.alreadyRetried;
}
