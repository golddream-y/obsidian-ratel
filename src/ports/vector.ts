/**
 * @file src/ports/vector.ts
 * @description 向量存储端口 — 向量召回能力的零实现接口契约。
 * @module ports/vector
 * @depends (无)
 */

/**
 * 向量存储统一接口。
 *
 * 实现位置:`src/adapters/vector-vectra.ts`(纯 JS 的 vectra 实现)。
 */
export interface VectorStore {
	/**
	 * 插入或更新单个文档(用 docId 作主键)。
	 * @param docId - 文档唯一标识(本项目用 `<path>#chunk-<index>`)。
	 * @param text - 文档原文(用于 BM25 索引与可能的回查)。
	 * @param metadata - 任意附加元数据(路径、chunk index、tag 等)。
	 */
	upsert(docId: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
	/**
	 * 按向量相似度搜索 TopK。
	 * @param queryVector - 查询向量(长度必须等于 embedding dimensions)。
	 * @param topK - 返回数量。
	 * @param filter - 可选的元数据过滤(标签、路径前缀)。
	 */
	search(queryVector: number[], topK: number, filter?: SearchFilter): Promise<VectorSearchResult[]>;
	/**
	 * 批量删除。
	 * @param docIds - 待删除 docId 列表。
	 * @returns 实际删除的条目数(可能少于请求数,因 docId 不存在时算 0)。
	 */
	delete(docIds: string[]): Promise<number>;
	/**
	 * 取索引全局状态(用于 UI 展示与心跳检测)。
	 */
	status(): Promise<IndexStatus>;
}

/**
 * 向量搜索单条结果。
 */
export interface VectorSearchResult {
	docId: string;
	/** 相似度分数(具体定义由实现决定,通常 0-1 区间或余弦距离)。 */
	score: number;
	/** 写入时传入的元数据(包含 path、chunkIndex 等)。 */
	metadata: Record<string, unknown>;
}

/**
 * 元数据过滤条件(可组合)。
 */
export interface SearchFilter {
	tags?: string[];
	pathPrefix?: string;
}

/**
 * 索引状态。
 * - `lastIndexTime` 是上次成功写盘的时间戳(毫秒)。
 * - `isIndexing` 用于避免在重建过程中被 UI 误判为"索引完成"。
 */
export interface IndexStatus {
	totalDocs: number;
	lastIndexTime: number;
	isIndexing: boolean;
}
