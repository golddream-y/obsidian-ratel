import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingLocal } from '../../src/adapters/embedding-local';

// Mock @huggingface/transformers pipeline
vi.mock('@huggingface/transformers', () => ({
	pipeline: vi.fn().mockResolvedValue(
		vi.fn(async (texts: string[], options: Record<string, unknown>) => {
			// Return mock tensor-like object with tolist()
			const dims = 512;
			const batch = Array.isArray(texts) ? texts : [texts];
			const vectors = batch.map(() =>
				Array.from({ length: dims }, () => Math.random()),
			);
			return { tolist: () => vectors };
		}),
	),
}));

describe('EmbeddingLocal', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('creates instance with correct defaults', () => {
		const adapter = new EmbeddingLocal();
		expect(adapter.modelId).toBe('local:Xenova/bge-small-zh-v1.5');
		expect(adapter.dimensions).toBe(512);
	});

	it('creates instance with custom model', () => {
		const adapter = new EmbeddingLocal('Xenova/bge-micro-v2', 384);
		expect(adapter.modelId).toBe('local:Xenova/bge-micro-v2');
		expect(adapter.dimensions).toBe(384);
	});

	it('embeds texts and returns number[][]', async () => {
		const adapter = new EmbeddingLocal();
		const result = await adapter.embed(['hello', 'world']);
		expect(result).toHaveLength(2);
		expect(result[0]).toHaveLength(512);
		expect(result[1]).toHaveLength(512);
	});

	it('initializes pipeline lazily on first embed call', async () => {
		const { pipeline } = await import('@huggingface/transformers');
		const adapter = new EmbeddingLocal();
		// Pipeline not called yet
		expect(pipeline).not.toHaveBeenCalled();
		await adapter.embed(['test']);
		// Pipeline called on first embed
		expect(pipeline).toHaveBeenCalledWith(
			'feature-extraction',
			'Xenova/bge-small-zh-v1.5',
			expect.objectContaining({ dtype: 'q8' }),
		);
	});

	it('reuses pipeline on subsequent calls', async () => {
		const adapter = new EmbeddingLocal();
		await adapter.embed(['first']);
		await adapter.embed(['second']);
		const { pipeline } = await import('@huggingface/transformers');
		// Pipeline only initialized once
		expect(pipeline).toHaveBeenCalledOnce();
	});
});
