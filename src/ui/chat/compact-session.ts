/**
 * @file src/ui/chat/compact-session.ts
 * @description /compact 命令实现 — fork LLM 摘要写入 CompactMarker,不删 transcript
 * @module ui/chat/compact-session
 * @depends ../../core/context-manager, ../../core/compact-project, ../../ports/llm, ../../prompts/composer
 */

import type { ContextManager } from '../../core/context-manager';
import {
	extractRestoredNotePaths,
	MIN_TRANSCRIPT_TO_COMPACT,
	projectView,
} from '../../core/compact-project';
import type { LLMClient, ChatDelta } from '../../ports/llm';
import type { CompactMarker } from '../../ports/persistence';
import { composeCompactMessages } from '../../prompts/composer';
import type { OverrideMap } from '../../prompts/types';
import { tNow } from '../../i18n';

/**
 * /compact 结果。
 */
export interface CompactResult {
	summary: string;
	marker?: CompactMarker;
	skipped?: boolean;
}

/**
 * compactSession 可选参数 — 控制 marker 落点与摘要输入上界。
 */
export interface CompactSessionOptions {
	/** marker.afterIndex;缺省为 transcript.length - 1 */
	untilIndex?: number;
}

/**
 * 把对话历史压成结构化摘要,写入 CompactMarker,不修改 transcript 条数。
 *
 * 流程:
 * 1. 读取 transcript 与已有 compactMarkers
 * 2. projectView tail 可压缩段过短则 skipped,不调 LLM
 * 3. fork LLM 做结构化摘要
 * 4. appendCompactMarker — 只写标记,不 resetSession
 *
 * 关键路径:LLM 调用先于 appendCompactMarker。若 LLM 抛错或空摘要,session 保持原状,
 * 用户可重试 /compact;只有摘要成功后才写入 marker。
 *
 * @param ctx - ContextManager 实例
 * @param llm - LLM 客户端,用于摘要
 * @param sessionId - 会话 ID
 * @param overrides - 可选 prompt section 覆盖(默认空对象)
 * @param opts - 可选 untilIndex(溢出重试时排除当前 user)
 * @returns 摘要与可选 marker;skipped 表示 tail 过短未压缩
 * @throws LLM 调用失败或空摘要时抛错,不写 marker
 */
export async function compactSession(
	ctx: ContextManager,
	llm: LLMClient,
	sessionId: string,
	overrides: OverrideMap = {},
	opts?: CompactSessionOptions,
): Promise<CompactResult> {
	await ctx.load(sessionId);
	const transcript = ctx.getTranscript();
	const markers = ctx.getCompactMarkers();
	const untilIndex = opts?.untilIndex ?? transcript.length - 1;
	if (untilIndex < 0) {
		return { summary: '', skipped: true };
	}

	const sliceForCompact = transcript.slice(0, untilIndex + 1);
	const { tail } = projectView(sliceForCompact, markers);
	const compactable = tail.filter((m) => m.role !== 'system');
	if (compactable.length <= MIN_TRANSCRIPT_TO_COMPACT) {
		return { summary: '', skipped: true };
	}

	const history = projectView(sliceForCompact, markers);
	const historyText = [...history.head, ...history.tail]
		.map((m) => `${m.role}: ${m.content}`)
		.join('\n');

	const llmMessages = composeCompactMessages({ history: historyText }, overrides);
	const summary = await collectStream(llm.chat({ messages: llmMessages }));

	if (!summary.trim()) {
		throw new Error(tNow('error.compact.emptySummary'));
	}

	const afterIndex = untilIndex;
	const marker: CompactMarker = {
		afterIndex,
		summary: summary.trim(),
		restoredNotePaths: extractRestoredNotePaths(transcript, 0, afterIndex),
		at: Date.now(),
	};
	await ctx.appendCompactMarker(marker);
	return { summary: marker.summary, marker };
}

/**
 * 拼接 LLM 流式 delta 为字符串。
 *
 * @param stream - LLM chat 返回的异步迭代流
 * @returns 拼接后的完整文本
 */
async function collectStream(stream: AsyncIterable<ChatDelta>): Promise<string> {
	let result = '';
	for await (const delta of stream) {
		// 关键路径:只取最终输出文本,忽略 reasoning(思考过程不进摘要)
		if (delta.text) result += delta.text;
	}
	return result;
}
