/**
 * @file src/core/outbound-measure.ts
 * @description 按实际上送 LLM 的字段分项估算 token(content / reasoning / toolArgs / 附件 / 工具 schema)
 * @module core/outbound-measure
 * @depends ../ui/tokens/token-estimator
 */

import { estimateTokens } from '../ui/tokens/token-estimator';

/** 出站 payload 各分项 token 估算 */
export interface OutboundMeasure {
	content: number;
	toolArgs: number;
	reasoning: number;
	attachments: number;
	toolSchemas: number;
	total: number;
}

/** measureOutbound 可接受的消息最小形状 */
type OutboundMessage = {
	content?: string;
	reasoning?: string;
	toolArgs?: Record<string, unknown>;
	attachments?: ReadonlyArray<{ estimatedTokens?: number }>;
};

/**
 * 对即将上送 LLM 的消息与工具定义做分项 token 估算。
 *
 * 各字段独立调用 estimateTokens;缺省字段计 0。attachments 只累加 estimatedTokens,不读 base64。
 *
 * @param messages - 出站消息列表(只读)
 * @param toolSchemas - 工具定义列表(可选)
 * @returns 分项与 total(五项之和)
 */
export function measureOutbound(
	messages: ReadonlyArray<OutboundMessage>,
	toolSchemas?: readonly unknown[],
): OutboundMeasure {
	let content = 0;
	let toolArgsSum = 0;
	let reasoning = 0;
	let attachments = 0;

	for (const m of messages) {
		content += estimateTokens(m.content ?? '');
		reasoning += estimateTokens(m.reasoning ?? '');
		if (m.toolArgs !== undefined) {
			toolArgsSum += estimateTokens(JSON.stringify(m.toolArgs));
		}
		for (const a of m.attachments ?? []) {
			attachments += a.estimatedTokens ?? 0;
		}
	}

	const toolSchemasTokens =
		toolSchemas === undefined ? 0 : estimateTokens(JSON.stringify(toolSchemas));

	const total = content + toolArgsSum + reasoning + attachments + toolSchemasTokens;

	return {
		content,
		toolArgs: toolArgsSum,
		reasoning,
		attachments,
		toolSchemas: toolSchemasTokens,
		total,
	};
}
