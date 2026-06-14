// Embedding Port — zero-implementation interface contract
// Separates embedding from LLM (embed() removed from LLMClient in Task 2)

export interface EmbeddingPort {
	/** Generate embedding vectors for a batch of texts */
	embed(texts: string[]): Promise<number[][]>;

	/** Embedding vector dimensions (e.g. 512 for bge-small-zh, 1024 for bge-m3) */
	readonly dimensions: number;

	/** Model identifier for logging and cache keys */
	readonly modelId: string;
}
