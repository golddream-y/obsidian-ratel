// Vector Port — zero-implementation interface contract
// From ARCHITECTURE.md section 4.2

export interface VectorStore {
	upsert(docId: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
	search(queryVector: number[], topK: number, filter?: SearchFilter): Promise<VectorSearchResult[]>;
	delete(docIds: string[]): Promise<number>;
	status(): Promise<IndexStatus>;
}

export interface VectorSearchResult {
	docId: string;
	score: number;
	metadata: Record<string, unknown>;
}

export interface SearchFilter {
	tags?: string[];
	pathPrefix?: string;
}

export interface IndexStatus {
	totalDocs: number;
	lastIndexTime: number;
	isIndexing: boolean;
}
