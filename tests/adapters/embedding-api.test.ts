import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingApi } from '../../src/adapters/embedding-api';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('EmbeddingApi', () => {
	beforeEach(() => {
		mockFetch.mockReset();
	});

	it('sends embedding request and returns vectors', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [
					{ embedding: [0.1, 0.2, 0.3], index: 0 },
					{ embedding: [0.4, 0.5, 0.6], index: 1 },
				],
				model: 'bge-m3',
				usage: { prompt_tokens: 10, total_tokens: 10 },
			}),
		});

		const adapter = new EmbeddingApi({
			apiBase: 'http://localhost:11434/v1',
			apiKey: '',
			model: 'bge-m3',
			dimensions: 1024,
		});

		const result = await adapter.embed(['hello', 'world']);
		expect(result).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, options] = mockFetch.mock.calls[0]!;
		expect(url).toBe('http://localhost:11434/v1/embeddings');
		expect((options as RequestInit).method).toBe('POST');
	});

	it('sends API key when provided', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				data: [{ embedding: [0.1], index: 0 }],
			}),
		});

		const adapter = new EmbeddingApi({
			apiBase: 'https://api.siliconflow.cn/v1',
			apiKey: 'sk-test',
			model: 'BAAI/bge-m3',
			dimensions: 1024,
		});

		await adapter.embed(['test']);
		const [, options] = mockFetch.mock.calls[0]!;
		expect((options as Record<string, Record<string, string>>).headers.Authorization).toBe('Bearer sk-test');
	});

	it('throws on API error', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
		});

		const adapter = new EmbeddingApi({
			apiBase: 'https://api.siliconflow.cn/v1',
			apiKey: 'sk-bad',
			model: 'bge-m3',
			dimensions: 1024,
		});

		await expect(adapter.embed(['test'])).rejects.toThrow('Embedding API error: 401 Unauthorized');
	});

	it('handles empty array input', async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ data: [] }),
		});

		const adapter = new EmbeddingApi({
			apiBase: 'http://localhost:11434/v1',
			apiKey: '',
			model: 'bge-m3',
			dimensions: 1024,
		});

		const result = await adapter.embed([]);
		expect(result).toEqual([]);
	});

	it('exposes dimensions and modelId', () => {
		const adapter = new EmbeddingApi({
			apiBase: 'http://localhost:11434/v1',
			apiKey: '',
			model: 'bge-m3',
			dimensions: 1024,
		});
		expect(adapter.dimensions).toBe(1024);
		expect(adapter.modelId).toBe('api:bge-m3');
	});
});
