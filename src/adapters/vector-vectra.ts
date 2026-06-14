/**
 * @file src/adapters/vector-vectra.ts
 * @description vectra 包装层 — `VectorStore` 端口的具体实现(本地纯 JS 索引)
 * @module adapters/vector-vectra
 * @depends vectra, ports/vector
 */

import type { VectorStore, VectorSearchResult, IndexStatus, SearchFilter } from '../ports/vector';
import { LocalDocumentIndex, type EmbeddingsModel, type DocumentChunkMetadata } from 'vectra';

/**
 * vectra 向量库适配器。
 *
 * 设计要点:
 * - 索引仅在首次调用时懒加载(参见 `ensureIndex`),允许冷启动阶段不触发磁盘 IO。
 * - 搜索时按 `topK * 10` 过度抓取,再做 chunk → document 聚合,确保返回的 topK 是文档级而非片段级。
 * - `_lastIndexTime` 简单记录最近一次写入时间戳,供 UI 展示索引新鲜度。
 * - `status()` 出错时降级返回零值,避免观测调用挂掉上游 Agent Loop。
 */
export class VectraStore implements VectorStore {
	private index: LocalDocumentIndex | null = null;
	private indexDir: string;
	private _lastIndexTime = 0;
	private embeddings: EmbeddingsModel | undefined;

	constructor(indexDir: string, embeddings?: EmbeddingsModel) {
		this.indexDir = indexDir;
		this.embeddings = embeddings;
	}

	/**
	 * 懒加载索引:首次调用时创建 `LocalDocumentIndex`,必要时初始化磁盘文件。
	 *
	 * @returns 已就绪的 `LocalDocumentIndex`。
	 * @throws 当磁盘不可写或 vectra 内部初始化失败时抛出。
	 */
	private async ensureIndex(): Promise<LocalDocumentIndex> {
		if (!this.index) {
			this.index = new LocalDocumentIndex({
				folderPath: this.indexDir,
				embeddings: this.embeddings,
			});
			// 关键路径:首次运行需在磁盘上落地 index.json + 索引文件。
			if (!(await this.index.isIndexCreated())) {
				await this.index.createIndex();
			}
		}
		return this.index;
	}

	/**
	 * 写入或更新文档向量。
	 *
	 * @param docId - 业务层文档 ID(即文件 vault 路径)。
	 * @param text - 文档文本(由调用方分块好;vectra 内部仍会再切)。
	 * @param metadata - 任意元数据,会被持久化到 chunk metadata。
	 */
	async upsert(docId: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
		const index = await this.ensureIndex();
		await index.upsertDocument(
			docId,
			text,
			undefined,
			metadata as Record<string, import('vectra').MetadataTypes>,
		);
		this._lastIndexTime = Date.now();
	}

	/**
	 * 向量检索 — 返回与查询最相关的 topK 文档。
	 *
	 * 关键路径:
	 * 1. `queryItems` 抓 `topK * 10` 个 chunk,弥补聚合后丢弃带来的损耗。
	 * 2. 把 vectra 内部 `documentId` 映射回我们传入的 `docId`(URI)。
	 * 3. 同文档多 chunk 取最高分,按分数降序截断到 `topK`。
	 *
	 * @param queryVector - 查询向量。
	 * @param topK - 返回文档上限。
	 * @param filter - 元数据过滤(当前实现未使用,留作扩展)。
	 * @returns 文档级结果,按相关性降序。
	 */
	async search(queryVector: number[], topK: number, filter?: SearchFilter): Promise<VectorSearchResult[]> {
		const index = await this.ensureIndex();
		// 过度抓取:确保聚合后 topK 文档都能拿到。
		const results = await index.queryItems(queryVector, '', topK * 10);

		// 关键路径:先收集所有命中的内部 documentId,再去批量查 URI。
		const internalIds = new Set<string>();
		for (const r of results) {
			const chunkMeta = r.item.metadata as DocumentChunkMetadata;
			if (chunkMeta.documentId) {
				internalIds.add(chunkMeta.documentId);
			}
		}

		// 内部 documentId → 业务 docId(URI) 的映射。
		const uriMap = new Map<string, string>();
		for (const internalId of internalIds) {
			const uri = await index.getDocumentUri(internalId);
			if (uri) uriMap.set(internalId, uri);
		}

		// 关键路径:chunk 级别分数聚合成 document 级别,取每个文档的最高分。
		const docMap = new Map<string, { docId: string; score: number; metadata: Record<string, unknown> }>();
		for (const r of results) {
			const chunkMeta = r.item.metadata as DocumentChunkMetadata;
			const internalDocId = chunkMeta.documentId;
			if (!internalDocId) continue;

			const docId = uriMap.get(internalDocId) ?? internalDocId;
			const existing = docMap.get(docId);
			if (!existing || r.score > existing.score) {
				docMap.set(docId, {
					docId,
					score: r.score,
					metadata: chunkMeta as unknown as Record<string, unknown>,
				});
			}
		}

		return Array.from(docMap.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
	}

	/**
	 * 删除文档。
	 *
	 * 修复:vectra 在文档不存在时抛错,这里静默忽略以保证批量删除的幂等性。
	 *
	 * @param docIds - 待删除文档 ID 列表。
	 * @returns 实际成功删除的文档数。
	 */
	async delete(docIds: string[]): Promise<number> {
		const index = await this.ensureIndex();
		let count = 0;
		for (const id of docIds) {
			try {
				await index.deleteDocument(id);
				count++;
			} catch {
				// 修复:文档可能已被其他流程删除,忽略。
			}
		}
		return count;
	}

	/**
	 * 查询索引状态。
	 *
	 * 行为契约:出错时返回零值状态,绝不抛错(观测类调用不应阻断主流程)。
	 *
	 * @returns 索引统计信息。
	 */
	async status(): Promise<IndexStatus> {
		try {
			const index = await this.ensureIndex();
			const stats = await index.getCatalogStats();
			return {
				totalDocs: stats.documents,
				lastIndexTime: this._lastIndexTime,
				isIndexing: false,
			};
		} catch {
			// 修复:观测调用降级,不让 UI 卡死。
			return {
				totalDocs: 0,
				lastIndexTime: 0,
				isIndexing: false,
			};
		}
	}
}
