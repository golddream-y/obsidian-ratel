/**
 * @file src/ui/chat/context-usage-writeback.ts
 * @description message.end 真值 token 取舍 — step 合计优先
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
 * 从 message.end 取本轮真值 token。多步工具调用时各步输入都含完整历史,
 * 取最后一步会虚高;优先用各步合计。
 *
 * @param payload - message.end 的 payload
 * @returns 真值 token;无任何 usage 时返回 undefined(调用方保留估算)
 */
export function resolveApiUsedTokens(payload: MessageEndPayload): number | undefined {
	if (payload.stepPromptTokens != null && payload.stepCompletionTokens != null) {
		return payload.stepPromptTokens + payload.stepCompletionTokens;
	}
	if (payload.promptTokens != null && payload.completionTokens != null) {
		return payload.promptTokens + payload.completionTokens;
	}
	return undefined;
}
