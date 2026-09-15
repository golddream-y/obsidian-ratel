/**
 * @file src/core/memory-topics-auto-inject.ts
 * @description 记忆主题自动注入门闩 — 空索引或不就绪时禁止调用 embed
 * @module core/memory-topics-auto-inject
 */

/**
 * 是否应对当前用户消息做 topics 自动检索向量化。
 *
 * 关键路径:index 为空时 search 必然空，仍 embed 会每句打一次 ONNX。
 */
export function shouldAutoEmbedTopics(input: {
	k: number;
	message: string;
	indexCount: number;
	embeddingReady: boolean;
}): boolean {
	return (
		input.k > 0 &&
		input.message.trim().length > 0 &&
		input.indexCount > 0 &&
		input.embeddingReady
	);
}
