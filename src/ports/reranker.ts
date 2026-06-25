/**
 * @file src/ports/reranker.ts
 * @description Reranker 端口 — 精排能力的零实现接口契约
 * @module ports/reranker
 * @depends (无)
 */

/**
 * Reranker 统一接口。
 *
 * 实现位置:`src/adapters/reranker-bailian.ts`(百炼 DashScope)。
 *
 * 设计要点:
 * - 对查询 + 候选文档列表做精排,返回重新打分的结果。
 * - 文档全文由调用方(MultiQuerySearcher)读取后传入,端口不关心文件 IO。
 * - 返回结果按精排分数降序,数量不超过 topK。
 */
export interface RerankerPort {
	/**
	 * 对查询 + 候选文档列表做精排。
	 *
	 * @param query - 用户查询。
	 * @param documents - 候选文档列表(已读取全文)。
	 * @param topK - 返回数量上限。
	 * @returns 精排后的文档列表(id + 新分数),按分数降序。
	 */
	rerank(
		query: string,
		documents: Array<{ id: string; text: string }>,
		topK: number,
	): Promise<Array<{ id: string; score: number }>>;
}
