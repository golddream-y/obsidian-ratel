/**
 * @file src/adapters/reranker-bailian.ts
 * @description 百炼 DashScope Reranker 适配器 — 调用 compatible-api/v1/rerank 端点
 * @module adapters/reranker-bailian
 * @depends ports/reranker
 */

import type { RerankerPort } from '../ports/reranker';

/**
 * 百炼 Reranker 构造选项。
 *
 * @param apiBase - DashScope API 基址,默认 https://dashscope.aliyuncs.com/compatible-api/v1。
 * @param apiKey - API Key(从 Obsidian 钥匙串 ratel-rerank-bailian 读取)。
 * @param model - Reranker 模型标识,默认 qwen3-rerank。
 */
export interface BailianRerankerOptions {
	apiBase: string;
	apiKey: string;
	model: string;
}

/**
 * 百炼 DashScope Reranker 适配器。
 *
 * 设计要点:
 * - 端点:`${apiBase}/rerank`(DashScope compatible-api)。
 * - 请求体:`{ model, query, documents: string[], top_n }`。
 * - 响应体:`{ results: [{ index, relevance_score }] }`,index 对应请求 documents 下标。
 * - HTTP 错误或网络异常向上抛错,由调用方(MultiQuerySearcher)决定降级策略。
 *
 * @example
 *   const reranker = new BailianReranker({
 *     apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
 *     apiKey: 'sk-xxx',
 *     model: 'qwen3-rerank',
 *   });
 *   const ranked = await reranker.rerank('query', [{id:'a',text:'...'}], 5);
 */
export class BailianReranker implements RerankerPort {
	constructor(private options: BailianRerankerOptions) {}

	/**
	 * 调用百炼 API 对候选文档做精排。
	 *
	 * 关键路径:
	 * - 空文档列表直接返回空数组,不发请求。
	 * - 请求 documents 传文本数组(text),响应 index 对应回原始 id。
	 * - 响应 results 按 relevance_score 降序(百炼已排序),取 top_n。
	 *
	 * @param query - 用户查询。
	 * @param documents - 候选文档(id + 全文)。
	 * @param topK - 返回数量上限。
	 * @returns 精排结果(id + score),按 score 降序。
	 * @throws HTTP 非 2xx 时抛 `Bailian Rerank API error: <status>`;网络异常透传 fetch 错误。
	 */
	async rerank(
		query: string,
		documents: Array<{ id: string; text: string }>,
		topK: number,
	): Promise<Array<{ id: string; score: number }>> {
		// 关键路径:空列表不调 API,节省配额。
		if (documents.length === 0) return [];

		const url = `${this.options.apiBase}/rerank`;
		const body = JSON.stringify({
			model: this.options.model,
			query,
			documents: documents.map((d) => d.text),
			top_n: topK,
		});

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.options.apiKey}`,
				'Content-Type': 'application/json',
			},
			body,
		});

		if (!response.ok) {
			// 关键路径:读取响应体辅助排障(配额超限 / Key 失效 / 模型名错误等),与 embedding-api.ts 对齐。
			const errorBody = await response.text().catch(() => '');
			throw new Error(`Bailian Rerank API error: ${response.status}${errorBody ? ' ' + errorBody : ''}`);
		}

		const data = (await response.json()) as {
			results: Array<{ index: number; relevance_score: number }>;
		};

		// 关键路径:response.results 已按 relevance_score 降序,直接映射回 id。
		// 防御性截断到 topK:即便服务端返回数量超出请求的 top_n,也不破坏端口契约"数量不超过 topK"。
		return data.results
			.map((r) => ({
				id: documents[r.index]!.id,
				score: r.relevance_score,
			}))
			.slice(0, topK);
	}
}
