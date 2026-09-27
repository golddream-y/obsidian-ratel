/**
 * @file src/ui/chat/context-usage-writeback.ts
 * @description message.end 真值 token 取舍 — 窗口占用看最后一步
 * @module ui/chat/context-usage-writeback
 */

/** message.end payload 的最小形状 */
export type MessageEndPayload = {
	tokens: number;
	promptTokens?: number;
	completionTokens?: number;
	stepPromptTokens?: number;
	stepCompletionTokens?: number;
};

/**
 * 从 message.end 取当前上下文窗口占用。
 *
 * 每一步的 prompt 都含当时的整段历史。各步相加是这一轮的消耗，不是窗口有多满。
 * 最后一步的输入加上该步输出，才是这一轮结束时窗口里的量。
 *
 * @param payload - message.end 的 payload
 * @returns 窗口占用；无任何 usage 时返回 undefined（调用方保留估算）
 */
export function resolveApiUsedTokens(payload: MessageEndPayload): number | undefined {
	if (payload.promptTokens != null && payload.completionTokens != null) {
		return payload.promptTokens + payload.completionTokens;
	}
	if (payload.stepPromptTokens != null && payload.stepCompletionTokens != null) {
		return payload.stepPromptTokens + payload.stepCompletionTokens;
	}
	return undefined;
}
