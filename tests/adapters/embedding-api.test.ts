/**
 * @file tests/adapters/embedding-api.test.ts
 * @description EmbeddingApi 适配器单元测试(requestUrl + 维度校验)
 * @module tests/adapters/embedding-api
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 关键路径:vi.hoisted 确保 mockRequestUrl 在 vi.mock 提升前完成初始化,
// src/adapters/embedding-api.ts 现在通过 requestUrl 发请求,需 mock 'obsidian'。
const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));

vi.mock('obsidian', () => ({
	requestUrl: mockRequestUrl,
}));

import { EmbeddingApi } from '../../src/adapters/embedding-api';

describe('EmbeddingApi', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('sends embedding request and returns vectors', async () => {
		// 关键路径:mock 向量维度必须等于配置 dimensions(1024),否则触发维度校验。
		const vec1 = new Array(1024).fill(0).map((_, i) => 0.1 + i * 0.0001);
		const vec2 = new Array(1024).fill(0).map((_, i) => 0.4 + i * 0.0001);
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: {
				data: [
					{ embedding: vec1, index: 0 },
					{ embedding: vec2, index: 1 },
				],
				model: 'bge-m3',
				usage: { prompt_tokens: 10, total_tokens: 10 },
			},
		});

		const adapter = new EmbeddingApi({
			apiBase: 'http://localhost:11434/v1',
			apiKey: '',
			model: 'bge-m3',
			dimensions: 1024,
		});

		const result = await adapter.embed(['hello', 'world']);
		expect(result).toHaveLength(2);
		expect(result[0]).toHaveLength(1024);
		expect(result[1]).toHaveLength(1024);
		expect(mockRequestUrl).toHaveBeenCalledOnce();
		const callArg = mockRequestUrl.mock.calls[0]![0] as Record<string, unknown>;
		expect(callArg.url).toBe('http://localhost:11434/v1/embeddings');
		expect(callArg.method).toBe('POST');
	});

	it('sends API key when provided', async () => {
		const vec1 = new Array(1024).fill(0.1);
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: {
				data: [{ embedding: vec1, index: 0 }],
			},
		});

		const adapter = new EmbeddingApi({
			apiBase: 'https://api.siliconflow.cn/v1',
			apiKey: 'sk-test',
			model: 'BAAI/bge-m3',
			dimensions: 1024,
		});

		await adapter.embed(['test']);
		const callArg = mockRequestUrl.mock.calls[0]![0] as {
			headers: Record<string, string>;
		};
		expect(callArg.headers.Authorization).toBe('Bearer sk-test');
	});

	it('throws on API error', async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 401,
			text: 'Unauthorized',
		});

		const adapter = new EmbeddingApi({
			apiBase: 'https://api.siliconflow.cn/v1',
			apiKey: 'sk-bad',
			model: 'bge-m3',
			dimensions: 1024,
		});

		await expect(adapter.embed(['test'])).rejects.toThrow('Embedding API error: 401');
	});

	it('handles empty array input', async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { data: [] },
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

	it('throws when API returns vectors with wrong dimensions', async () => {
		// 关键路径:服务端错误地返回 3 维,期望 1024 维,应当立即抛错。
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: {
				data: [
					{ embedding: [0.1, 0.2, 0.3], index: 0 }, // 3 dims, expected 1024
				],
			},
		});

		const adapter = new EmbeddingApi({
			apiBase: 'http://test',
			apiKey: 'sk',
			model: 'm',
			dimensions: 1024,
		});

		await expect(adapter.embed(['test'])).rejects.toThrow(/维度/i);
	});

	it('accepts vectors with matching dimensions', async () => {
		// 关键路径:服务端返回的维度 = 配置维度,应当正常通过。
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: {
				data: [
					{ embedding: new Array(4).fill(0.1), index: 0 },
				],
			},
		});

		const adapter = new EmbeddingApi({
			apiBase: 'http://test',
			apiKey: 'sk',
			model: 'm',
			dimensions: 4,
		});

		const result = await adapter.embed(['test']);
		expect(result[0]).toHaveLength(4);
	});
});
