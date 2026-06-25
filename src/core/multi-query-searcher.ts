/**
 * @file src/core/multi-query-searcher.ts
 * @description 多查询搜索编排器 — 改写 + 多查询 + RRF + 可选 Rerank 精排
 * @module core/multi-query-searcher
 * @depends ports/embedding, ports/vector, ports/reranker, worker/manager, adapters/obsidian-vault, core/rrf
 */

import type { EmbeddingPort } from '../ports/embedding';
import type { VectorSearchResult } from '../ports/vector';
import type { RerankerPort } from '../ports/reranker';
import type { WorkerManager } from '../worker/manager';
import type { ObsidianVault } from '../adapters/obsidian-vault';
import { reciprocalRankFusion, type RankedItem } from './rrf';
import { devLogger } from '../logging/dev-logger';

/**
 * 多查询搜索器依赖。
 *
 * @param embedding - Embedding 端口,用于把每个查询变体编码为向量。
 * @param workerManager - Worker 管理器,用于发起 hybrid.search(W3 已实现)。
 * @param vault - Obsidian Vault 外观,供 Rerank 读取文档全文。
 * @param reranker - 可选 Reranker 端口;未注入时跳过精排。
 * @param queryRewriter - 可选查询改写器;未注入时只用原始查询。
 */
export interface MultiQuerySearcherDeps {
	embedding: EmbeddingPort;
	workerManager: WorkerManager;
	vault: ObsidianVault;
	reranker?: RerankerPort;
	queryRewriter?: { rewrite: (q: string) => Promise<string[]> };
}

/**
 * 多查询搜索编排器。
 *
 * 设计要点:
 * - 对 search_vault 工具与 LLM 透明:外部只调 search(query, topK),内部自动编排。
 * - 不调 search_vault 工具(避免循环 — search_vault 反过来调用本类)。
 * - 直接调 Worker 的 hybrid.search,绕过 search_vault 工具层。
 * - Reranker 异常时降级返回 RRF 结果,不阻断主流程。
 * - QueryRewriter 异常时降级为单查询,不阻断主流程。
 *
 * 关键路径(数据流):
 * 1. 若 queryRewriter 可用:改写查询 → [original, rewrite-1, rewrite-2]
 *    否则:只用 [original]
 * 2. 对每个查询:embedding.embed → workerManager.request(hybrid.search, topK*2)
 * 3. RRF 融合多份结果,取 topK
 * 4. 若 reranker 可用:vault.readFile 读全文 → reranker.rerank → 更新分数 + reranked=true
 *    否则:reranked=false
 *
 * @example
 *   const searcher = new MultiQuerySearcher({
 *     embedding, workerManager, vault,
 *     reranker: hasRerankApiKey(app) ? new BailianReranker({...}) : undefined,
 *     queryRewriter: { rewrite: (q) => rewriteQuery(q, {llm}).then(r => r.map(x => x.text)) },
 *   });
 *   const results = await searcher.search('技术栈', 5);
 */
export class MultiQuerySearcher {
	constructor(private deps: MultiQuerySearcherDeps) {}

	/**
	 * 多查询混合搜索 + RRF 融合 + 可选 Rerank 精排。
	 *
	 * @param query - 用户原始查询(单条,内部决定是否改写)。
	 * @param topK - 返回文档上限。
	 * @returns 文档级结果(含 index 由 search_vault 工具层填,本方法不填)。
	 */
	async search(query: string, topK: number): Promise<VectorSearchResult[]> {
		// --- Step 1: 查询改写(可选) ---
		let queryTexts: string[] = [query];
		if (this.deps.queryRewriter) {
			try {
				const variants = await this.deps.queryRewriter.rewrite(query);
				if (variants.length > 0) {
					// 关键路径:queryRewriter.rewrite 契约 — 返回值含原始查询(见 Task 9 接线:
					// rewriteQuery 已返回 [{text: query, variant: 'original'}, ...rewrites])。
					// 因此直接用 variants,避免重复前置 original 导致该查询执行两次、RRF 分数翻倍。
					queryTexts = variants;
				}
			} catch (err) {
				// 关键路径:改写失败降级为单查询,不阻断。
				devLogger.error('search', 'Query rewrite failed, falling back to single query', err);
			}
		}

		// --- Step 2: 多查询 hybrid.search ---
		// 关键路径:传 topK*2 过度抓取,补偿 RRF 融合时丢弃部分结果。
		const overFetchTopK = topK * 2;
		const allResults: VectorSearchResult[][] = [];
		const docIdToResult = new Map<string, VectorSearchResult>();

		for (const queryText of queryTexts) {
			const [queryVector] = await this.deps.embedding.embed([queryText]);
			const response = await this.deps.workerManager.request({
				type: 'hybrid.search',
				payload: { query: queryText, queryVector: queryVector!, topK: overFetchTopK },
			});

			if (response.type !== 'hybrid.search.result') {
				devLogger.warn('search', `Unexpected worker response: ${response.type}`);
				continue;
			}

			const results = response.payload;
			allResults.push(results);
			// 关键路径:记录 docId → 首次出现的完整结果(含 metadata),供 RRF 后映射回 VectorSearchResult。
			for (const r of results) {
				if (!docIdToResult.has(r.docId)) {
					docIdToResult.set(r.docId, r);
				}
			}
		}

		// --- Step 3: RRF 融合 ---
		const rankedLists: RankedItem[][] = allResults.map((list) =>
			list.map((r) => ({ id: r.docId, score: r.score })),
		);
		const fused = reciprocalRankFusion(rankedLists, 60, topK);

		// 关键路径:把融合后的 docId 映射回 VectorSearchResult,用 rrfScore 替换原 score。
		let finalResults: VectorSearchResult[] = fused.map((f) => {
			const original = docIdToResult.get(f.id);
			if (!original) {
				// 关键路径:理论上不会发生(docId 都来自 docIdToResult),兜底防御。
				return { docId: f.id, score: f.rrfScore, metadata: {} };
			}
			return { ...original, score: f.rrfScore };
		});

		// --- Step 4: 可选 Rerank 精排 ---
		if (this.deps.reranker && finalResults.length > 0) {
			try {
				// 关键路径:读取 topK 文档全文,传给 Reranker。
				// metadata.path 是 vault 相对路径(W3 VectraStore.hybridSearch 保证)。
				const documents: Array<{ id: string; text: string }> = [];
				for (const r of finalResults) {
					const path = r.metadata?.path;
					if (typeof path === 'string') {
						const text = await this.deps.vault.readFile(path);
						documents.push({ id: r.docId, text });
					}
				}

				if (documents.length > 0) {
					const reranked = await this.deps.reranker.rerank(query, documents, topK);
					// 关键路径:用 reranker 分数重新排序,丢弃 text(VectorSearchResult 不含 text)。
					const rerankedMap = new Map(reranked.map((r) => [r.id, r.score]));
					// 关键路径:reranked 标记与 score 同源 — 仅 Reranker 实际返回分数的文档标 true;
					// 送入但被 Reranker 丢弃(低于 top_n 截断)的文档保持 reranked=false,因其分数仍是 RRF。
					finalResults = finalResults
						.map((r) => ({
							...r,
							score: rerankedMap.get(r.docId) ?? r.score,
							reranked: rerankedMap.has(r.docId),
						}))
						.sort((a, b) => b.score - a.score)
						.slice(0, topK);
				} else {
					// 关键路径:reranker 存在但所有文档缺 metadata.path,无法精排,reranked=false。
					finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
				}
			} catch (err) {
				// 关键路径:Reranker 失败降级返回 RRF 结果,reranked=false。
				devLogger.error('search', 'Rerank failed, falling back to RRF results', err);
				finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
			}
		} else {
			// 关键路径:无 reranker,reranked=false。
			finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
		}

		return finalResults;
	}
}
