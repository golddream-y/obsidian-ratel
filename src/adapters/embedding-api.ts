import type { EmbeddingPort } from '../ports/embedding';

interface EmbeddingApiConfig {
	apiBase: string;
	apiKey: string;
	model: string;
	dimensions: number;
}

export class EmbeddingApi implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId: string;

	constructor(private config: EmbeddingApiConfig) {
		this.dimensions = config.dimensions;
		this.modelId = `api:${config.model}`;
	}

	async embed(texts: string[]): Promise<number[][]> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this.config.apiKey) {
			headers['Authorization'] = `Bearer ${this.config.apiKey}`;
		}

		const response = await fetch(`${this.config.apiBase}/embeddings`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: this.config.model,
				input: texts,
			}),
		});

		if (!response.ok) {
			throw new Error(`Embedding API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as {
			data: Array<{ embedding: number[]; index: number }>;
		};

		// Sort by index to ensure order matches input
		return data.data
			.sort((a, b) => a.index - b.index)
			.map((d) => d.embedding);
	}
}
