import type { VectorStore, VectorSearchResult, IndexStatus, SearchFilter } from '../ports/vector';
import { LocalDocumentIndex, type EmbeddingsModel, type DocumentChunkMetadata } from 'vectra';

export class VectraStore implements VectorStore {
	private index: LocalDocumentIndex | null = null;
	private indexDir: string;
	private _lastIndexTime = 0;
	private embeddings: EmbeddingsModel | undefined;

	constructor(indexDir: string, embeddings?: EmbeddingsModel) {
		this.indexDir = indexDir;
		this.embeddings = embeddings;
	}

	private async ensureIndex(): Promise<LocalDocumentIndex> {
		if (!this.index) {
			this.index = new LocalDocumentIndex({
				folderPath: this.indexDir,
				embeddings: this.embeddings,
			});
			if (!(await this.index.isIndexCreated())) {
				await this.index.createIndex();
			}
		}
		return this.index;
	}

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

	async search(queryVector: number[], topK: number, filter?: SearchFilter): Promise<VectorSearchResult[]> {
		const index = await this.ensureIndex();
		// Use LocalIndex.queryItems (inherited) to search with a raw vector
		// Fetch more chunks to ensure we get enough distinct documents
		const results = await index.queryItems(queryVector, '', topK * 10);

		// Collect unique internal documentIds from chunk metadata
		const internalIds = new Set<string>();
		for (const r of results) {
			const chunkMeta = r.item.metadata as DocumentChunkMetadata;
			if (chunkMeta.documentId) {
				internalIds.add(chunkMeta.documentId);
			}
		}

		// Map internal documentId → URI (our original docId)
		const uriMap = new Map<string, string>();
		for (const internalId of internalIds) {
			const uri = await index.getDocumentUri(internalId);
			if (uri) uriMap.set(internalId, uri);
		}

		// Aggregate chunk-level results to document-level (best score per document)
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

	async delete(docIds: string[]): Promise<number> {
		const index = await this.ensureIndex();
		let count = 0;
		for (const id of docIds) {
			try {
				await index.deleteDocument(id);
				count++;
			} catch {
				// Document may not exist
			}
		}
		return count;
	}

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
			return {
				totalDocs: 0,
				lastIndexTime: 0,
				isIndexing: false,
			};
		}
	}
}
