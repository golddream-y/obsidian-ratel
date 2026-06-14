import type { EmbeddingPort } from '../ports/embedding';

export class EmbeddingLocal implements EmbeddingPort {
	private extractor: ((texts: string[], options: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>) | null = null;
	readonly modelId: string;
	readonly dimensions: number;
	private readonly rawModelId: string;

	constructor(modelId = 'Xenova/bge-small-zh-v1.5', dimensions = 512) {
		this.rawModelId = modelId;
		this.modelId = `local:${modelId}`;
		this.dimensions = dimensions;
	}

	private async init(): Promise<void> {
		if (this.extractor) return;

		const { pipeline } = await import('@huggingface/transformers');
		this.extractor = await pipeline('feature-extraction', this.rawModelId, {
			dtype: 'q8',
			progress_callback: (progress: { status: string; progress?: number; file?: string }) => {
				if (progress.status === 'progress' && progress.progress !== undefined) {
					console.log(`Model download: ${progress.file} ${Math.round(progress.progress)}%`);
				}
			},
		}) as unknown as typeof this.extractor;
	}

	async embed(texts: string[]): Promise<number[][]> {
		await this.init();
		const output = await this.extractor!(texts, {
			pooling: 'mean',
			normalize: true,
		});
		return output.tolist();
	}
}
