/**
 * @file src/adapters/vector-vectra.ts
 * @description vectra 包装层 — `VectorStore` 端口的具体实现(本地纯 JS 索引)
 * @module adapters/vector-vectra
 * @depends vectra, ports/vector
 */

import type { VectorStore, VectorSearchResult, IndexStatus, SearchFilter } from '../ports/vector';
import { devLogger } from '../logging/dev-logger';
// 关键路径:通过 esbuild conditions 让 'vectra' 走 browser 入口,避免引入 index.js 里 re-export 的 server/grpc 依赖。
import { LocalDocumentIndex, type EmbeddingsModel, type DocumentChunkMetadata, type MetadataTypes } from 'vectra';

/**
 * VectraStore 构造选项(M-1 扩展)。
 *
 * 设计要点:
 * - `embeddings`:由主线程注入的 ONNX FeatureExtractor;Worker 启动期由调用方注入,避免重复构造。
 * - `autoInit`:默认 true,构造时调一次 `init()` 预热;Worker 启动期显式 init 后可传 false 避免双重 init。
 */
export interface VectraStoreOptions {
	embeddings?: EmbeddingsModel;
	autoInit?: boolean;
}

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
	// 关键路径:缓存 init 的 promise,避免并发首次调用的竞态。
	private _ready: Promise<void> | null = null;

	constructor(indexDir: string, embeddingsOrOptions?: EmbeddingsModel | VectraStoreOptions) {
		this.indexDir = indexDir;
		// 关键路径:兼容旧的 `(dir, embeddings?)` 签名,新签名 `(dir, options?)`。
		if (embeddingsOrOptions && typeof embeddingsOrOptions === 'object' && 'embeddings' in embeddingsOrOptions) {
			this.embeddings = embeddingsOrOptions.embeddings;
			if (embeddingsOrOptions.autoInit !== false) {
				this._ready = this.init();
			}
		} else {
			this.embeddings = embeddingsOrOptions as EmbeddingsModel | undefined;
			this._ready = this.init();
		}
	}

	/**
	 * 显式预热索引 — 构造 LocalDocumentIndex 并确保磁盘文件就绪。
	 *
	 * 关键路径:
	 * - 幂等:多次调用共享同一 promise,不会出现并发首次调用竞态。
	 * - Worker 启动期会调一次,避免首个请求才触发 init 的延迟。
	 */
	async init(): Promise<void> {
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
	}

	/**
	 * 懒加载索引:首次调用时创建 `LocalDocumentIndex`,必要时初始化磁盘文件。
	 *
	 * @returns 已就绪的 `LocalDocumentIndex`。
	 * @throws 当磁盘不可写或 vectra 内部初始化失败时抛出。
	 */
	private async ensureIndex(): Promise<LocalDocumentIndex> {
		if (!this._ready) this._ready = this.init();
		await this._ready;
		if (!this.index) throw new Error('VectraStore init failed');
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
			metadata as Record<string, MetadataTypes>,
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
	async search(queryVector: number[], topK: number, _filter?: SearchFilter): Promise<VectorSearchResult[]> {
		void _filter; // 关键路径:filter 当前实现未启用,保留以满足端口契约。
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
	 * 混合搜索 — 向量 + BM25 关键词,vectra 内置融合。
	 *
	 * 关键路径:
	 * - 调用 `queryItems(queryVector, query, topK * 10, undefined, true)`
	 * - 第 2 参数传 query 文本(原 search 传空串,BM25 未启用)
	 * - 第 5 参数 isBm25=true 启用 BM25 追加结果
	 * - 复用 search() 的 chunk→doc 聚合逻辑(同文档取最高分,按分数降序)
	 *
	 * @param query - 用户查询文本(用于 BM25)
	 * @param queryVector - 查询向量(用于语义搜索,主线程 embedding)
	 * @param topK - 返回文档上限
	 * @returns 文档级结果(不含 index 字段,index 由 search_vault 工具层填)
	 */
	async hybridSearch(query: string, queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
		const index = await this.ensureIndex();

		let results;
		try {
			// 关键路径:过度抓取,与 search() 一致,聚合后确保 topK 文档都能拿到。
			results = await index.queryItems(queryVector, query, topK * 10, undefined, true);
		} catch (err) {
			// 修复:BM25 在文档极少时 winkBM25S consolidation 失败(如 1-2 个文档),
			// 降级为纯向量搜索,保证 hybrid.search 请求不抛错。
			devLogger.warn('search', 'BM25 hybrid search failed, falling back to vector-only search', err);
			return this.search(queryVector, topK);
		}

		// --- chunk → document 聚合(与 search() 同逻辑) ---
		const internalIds = new Set<string>();
		for (const r of results) {
			const chunkMeta = r.item.metadata as DocumentChunkMetadata;
			if (chunkMeta.documentId) {
				internalIds.add(chunkMeta.documentId);
			}
		}

		const uriMap = new Map<string, string>();
		for (const internalId of internalIds) {
			const uri = await index.getDocumentUri(internalId);
			if (uri) uriMap.set(internalId, uri);
		}

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

	/**
	 * 取指定 URI 文档的全文(用于诊断页 chunk 摘要展示)。
	 *
	 * 关键路径:
	 * - vectra 没有提供按 URI 直接取文本的 API,需要 `listDocuments()` 全量列举后过滤。
	 * - 诊断页只对 Top-K 命中调用,通常 1-10 次,单次 listDocuments 遍历整个 catalog。
	 * - 大库(>5000 文档)时这是性能瓶颈,但**仅诊断用**,不阻塞主流程;若成为问题,
	 *   后续可改为读磁盘 index.json(vectra 内部存储格式)。
	 *
	 * @param uri - 文档 URI(本项目即 vault 相对路径)。
	 * @returns 文档原文;URI 不存在时返回 null;底层失败返回 null(诊断场景降级,避免挂 UI)。
	 */
	async getDocumentText(uri: string): Promise<string | null> {
		try {
			const index = await this.ensureIndex();
			const docs = await index.listDocuments();
			for (const doc of docs) {
				if (doc.uri === uri) {
					const text = await doc.loadText();
					return text;
				}
			}
			return null;
		} catch (err) {
			// 修复:诊断调用降级,不让 UI 卡死。
			devLogger.error('vectra', 'getDocumentText failed', err);
			return null;
		}
	}
}
