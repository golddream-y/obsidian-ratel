/**
 * @file src/adapters/embedding-api.ts
 * @description 远端 Embedding 适配器 — OpenAI 兼容 `/embeddings` 端点
 * @module adapters/embedding-api
 * @depends fetch, ports/embedding
 */

import type { EmbeddingPort } from '../ports/embedding';

/**
 * 远端 Embedding 客户端配置。
 *
 * - `apiBase`:远端服务根地址,例如 `https://api.openai.com/v1`。
 * - `apiKey`:可选 Bearer Token;为空时省略 Authorization header。
 * - `model`:模型名,例如 `text-embedding-3-small`。
 * - `dimensions`:显式记录输出维度,用于向量库 schema 校验。
 */
interface EmbeddingApiConfig {
	apiBase: string;
	apiKey: string;
	model: string;
	dimensions: number;
}

/**
 * 远端 Embedding 端口实现 — 走 OpenAI 兼容 `/embeddings` 端点。
 *
 * 设计要点:
 * - 业务层 `modelId` 形如 `api:text-embedding-3-small`,前缀 `api:` 与 `local:` 区分来源。
 * - 响应按 `index` 字段排序,确保返回向量顺序与请求 `input` 严格一致(协议允许乱序)。
 * - HTTP 错误直接抛错,由调用方决定重试 / 降级策略。
 */
export class EmbeddingApi implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId: string;

	constructor(private config: EmbeddingApiConfig) {
		this.dimensions = config.dimensions;
		this.modelId = `api:${config.model}`;
	}

	/**
	 * 批量调用 `/embeddings` 端点,返回与输入等长的向量列表。
	 *
	 * 关键路径:协议允许返回顺序乱序,必须按 `index` 重排,
	 * 否则调用方对位的 `texts[i]` 与返回的 `vectors[i]` 可能错位。
	 *
	 * @param texts - 待编码文本数组。
	 * @returns 与 `texts` 等长的向量数组。
	 * @throws 当 HTTP 状态非 2xx 时抛出,包含状态码与状态文本。
	 */
	async embed(texts: string[]): Promise<number[][]> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this.config.apiKey) {
			headers['Authorization'] = `Bearer ${this.config.apiKey}`;
		}

		const response = await fetch(`${this.config.apiBase}/embeddings`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: this.config.model,
				input: texts,
			}),
		});

		if (!response.ok) {
			throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as {
			data: Array<{ embedding: number[]; index: number }>;
		};

		// 关键路径:OpenAI 协议允许 server 乱序返回,必须按 index 排序对齐输入。
		const vectors = data.data
			.sort((a, b) => a.index - b.index)
			.map((d) => d.embedding);

		// 维度校验:服务端配置错误(模型 / 端点变更)会导致维度不一致。
		// —— 修复:不在使用方发现"维度不匹配",而是早失败以便快速定位配置问题。
		for (let i = 0; i < vectors.length; i++) {
			const vec = vectors[i];
			if (!vec) continue;
			if (vec.length !== this.dimensions) {
				throw new Error(
					`Embedding dimension mismatch: expected ${this.dimensions}, got ${vec.length} for text index ${i}`,
				);
			}
		}

		return vectors;
	}
}
