/**
 * @file src/core/index-thread-candidate-source.ts
 * @description 线程版检索候选来源 — 把线程内命中映射成编排层认识的候选
 * @module src/core/index-thread-candidate-source
 *
 * 关键路径:
 * - 编排层（融合、可见性门、精排）仍留在宿主;这里只负责「给向量、拿候选」。
 * - 文档级标识用路径:同一篇的多个块在融合前会按 docId 去重,避免同篇多块抢占名次。
 * - 线程返回的块号放进 metadata,供后续读全文与引用定位。
 */

import type { VectorSearchResult } from '../ports/vector';
import type { SearchCandidateSource } from './multi-query-searcher';

/** 线程侧最小查询能力。 */
export interface ThreadSearchClient {
	searchByVector(vector: readonly number[], topK: number): Promise<Array<{
		docId?: string;
		path: string;
		score: number;
		chunkIndex: number | null;
	}>>;
}

/**
 * 构造线程版候选来源。
 * @param client 已打开的索引线程客户端
 */
export function createThreadCandidateSource(client: ThreadSearchClient): SearchCandidateSource {
	return {
		async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
			const hits = await client.searchByVector(queryVector, topK);
			return hits.map((hit) => ({
				// 关键路径:文档级去重用路径;空路径的命中无法定位来源,直接丢弃而不是造一个假 id。
				docId: hit.docId ?? hit.path,
				score: hit.score,
				metadata: { path: hit.path, chunkIndex: hit.chunkIndex },
			})).filter((candidate) => candidate.docId.length > 0);
		},
	};
}
