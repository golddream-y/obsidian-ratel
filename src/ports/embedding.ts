/**
 * @file src/ports/embedding.ts
 * @description Embedding 端口 — 把"文本→向量"的能力从 LLM 客户端中拆出来,允许本地与 API 两类适配器并存。
 * @module ports/embedding
 * @depends core/index-persistence-types(仅类型)
 */

// 关键路径:活动包与嵌入选项的唯一类型声明在 core/index-persistence-types(T1 集中类型文件),
// 端口侧只引用不复刻,避免两套契约漂移。
import type { EmbedOptions } from '../core/index-persistence-types';

export type { EmbedOptions } from '../core/index-persistence-types';

/**
 * 取消时抛出的错误名 — 调用方按名字识别取消,不依赖消息措辞。
 *
 * 关键路径:取消必须按真实失败结束(抛错),不得静默返回部分向量 ——
 * 否则调用方会把半批结果当成完整提交的依据。
 */
export const EMBED_ABORT_ERROR_NAME = 'AbortError';

/**
 * 构造取消错误 — 中文开发向文案,稳定 `name` 供调用方与测试判别;用户可见文案归 T7。
 *
 * @param message - 可选诊断文案。
 * @returns 名称固定为 `AbortError` 的错误。
 */
export function createEmbedAbortError(message = '嵌入调用已取消'): Error {
	const error = new Error(message);
	error.name = EMBED_ABORT_ERROR_NAME;
	return error;
}

/**
 * 判断是否为取消错误。
 *
 * @param error - 待判定的错误。
 * @returns 是否为本模块约定的取消错误。
 */
export function isEmbedAbortError(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		(error as { name?: unknown }).name === EMBED_ABORT_ERROR_NAME
	);
}

/**
 * 批次边界检查 — 已中止则按真实失败结束本次嵌入。
 *
 * 关键路径:只允许在批次 / IO 步骤边界停止,不假装支持单次推理内部中断。
 *
 * @param signal - 取消信号。
 * @throws 名称 `AbortError` 的错误(信号已中止时)。
 */
export function throwIfEmbeddingAborted(signal?: AbortSignal): void {
	if (signal?.aborted === true) throw createEmbedAbortError();
}

/**
 * Embedding 端口。
 *
 * 设计要点:
 * - 与 LLMClient 分离(W2 重构):本地 ONNX 与外部 API 在用户授权与体积上有本质差异,共用一个 LLMClient 会污染模型配置。
 * - `dimensions` + `modelId` 暴露给上层,用于:
 *   - vectra 索引初始化时校验维度匹配(防止换模型后索引错位)
 *   - 缓存键的命名(同一 (modelId, dimensions) 复用)
 * - `options` 为可选第二参:旧调用 `embed(texts)` 保持可用;新增取消与批次活动
 *   (T5 §4「分块批次、嵌入批次完成可报告活动」)。跨 Worker 不传函数与 `AbortSignal`,
 *   代理按 request ID 把两者转成消息。
 *
 * 实现位置:
 * - `src/adapters/embedding-local.ts`(基于 @huggingface/transformers + ONNX WASM)
 * - `src/adapters/embedding-api.ts`(OpenAI 兼容协议,如 Ollama / OpenAI / SiliconFlow)
 */
export interface EmbeddingPort {
	/**
	 * 批量生成 embedding 向量。
	 * @param texts - 待编码文本数组。
	 * @param options - 可选取消信号与批次活动回调;省略时行为与旧调用一致。
	 * @returns 与 texts 等长的向量数组,每个向量长度等于 `dimensions`。
	 */
	embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;

	/**
	 * Embedding 向量维度(如 bge-small-zh 为 512,bge-m3 为 1024)。
	 */
	readonly dimensions: number;

	/**
	 * 模型标识(用于日志与缓存键)。推荐带前缀,如 `local:bge-small-zh-v1.5`、`api:text-embedding-3-small`。
	 */
	readonly modelId: string;
}
