/**
 * @file src/ports/embedding.ts
 * @description Embedding 端口 — 把"文本→向量"的能力从 LLM 客户端中拆出来,允许本地与 API 两类适配器并存。
 * @module ports/embedding
 * @depends (无)
 */

/**
 * Embedding 端口。
 *
 * 设计要点:
 * - 与 LLMClient 分离(W2 重构):本地 ONNX 与外部 API 在用户授权与体积上有本质差异,共用一个 LLMClient 会污染模型配置。
 * - `dimensions` + `modelId` 暴露给上层,用于:
 *   - vectra 索引初始化时校验维度匹配(防止换模型后索引错位)
 *   - 缓存键的命名(同一 (modelId, dimensions) 复用)
 *
 * 实现位置:
 * - `src/adapters/embedding-local.ts`(基于 @huggingface/transformers + ONNX WASM)
 * - `src/adapters/embedding-api.ts`(OpenAI 兼容协议,如 Ollama / OpenAI / SiliconFlow)
 */
export interface EmbeddingPort {
	/**
	 * 批量生成 embedding 向量。
	 * @param texts - 待编码文本数组。
	 * @returns 与 texts 等长的向量数组,每个向量长度等于 `dimensions`。
	 */
	embed(texts: string[]): Promise<number[][]>;

	/**
	 * Embedding 向量维度(如 bge-small-zh 为 512,bge-m3 为 1024)。
	 */
	readonly dimensions: number;

	/**
	 * 模型标识(用于日志与缓存键)。推荐带前缀,如 `local:bge-small-zh-v1.5`、`api:text-embedding-3-small`。
	 */
	readonly modelId: string;
}
