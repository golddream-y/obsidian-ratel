/**
 * @file tests/adapters/reranker-bailian.test.ts
 * @description 百炼 Reranker 适配器单元测试
 * @module tests/adapters/reranker-bailian
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BailianReranker } from '../../src/adapters/reranker-bailian';

describe('BailianReranker', () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		// 关键路径:每个测试前重置 fetch mock,避免相互影响。
		global.fetch = vi.fn();
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it('rerank - 正常响应 - 返回精排后的 id + score', async () => {
		// 关键路径:百炼返回 { results: [{ index, relevance_score }] },
		// index 对应请求 documents 数组的下标。
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: true,
			json: async () => ({
				results: [
					{ index: 1, relevance_score: 0.95 },
					{ index: 0, relevance_score: 0.72 },
					{ index: 2, relevance_score: 0.61 },
				],
			}),
		});

		const reranker = new BailianReranker({
			apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
			apiKey: 'sk-test-key',
			model: 'qwen3-rerank',
		});

		const result = await reranker.rerank(
			'技术栈',
			[
				{ id: 'doc-a', text: '内容A' },
				{ id: 'doc-b', text: '内容B' },
				{ id: 'doc-c', text: '内容C' },
			],
			2,
		);

		// 关键路径:按 relevance_score 降序,top_n=2
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ id: 'doc-b', score: 0.95 });
		expect(result[1]).toEqual({ id: 'doc-a', score: 0.72 });
	});

	it('rerank - 请求体格式正确', async () => {
		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ results: [] }),
		});

		const reranker = new BailianReranker({
			apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
			apiKey: 'sk-test-key',
			model: 'qwen3-rerank',
		});

		await reranker.rerank('查询', [{ id: 'a', text: '文本A' }], 5);

		// 关键路径:验证请求 URL、method、headers、body 格式
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://dashscope.aliyuncs.com/compatible-api/v1/rerank');
		expect(options.method).toBe('POST');
		expect(options.headers['Authorization']).toBe('Bearer sk-test-key');
		expect(options.headers['Content-Type']).toBe('application/json');
		const body = JSON.parse(options.body);
		expect(body).toEqual({
			model: 'qwen3-rerank',
			query: '查询',
			documents: ['文本A'],
			top_n: 5,
		});
	});

	it('rerank - HTTP 错误 - 抛错', async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
			ok: false,
			status: 401,
			text: async () => 'Unauthorized',
		});

		const reranker = new BailianReranker({
			apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
			apiKey: 'invalid-key',
			model: 'qwen3-rerank',
		});

		await expect(
			reranker.rerank('查询', [{ id: 'a', text: '文本' }], 3),
		).rejects.toThrow('Bailian Rerank API error: 401');
	});

	it('rerank - 网络异常 - 抛错', async () => {
		(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

		const reranker = new BailianReranker({
			apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
			apiKey: 'sk-test',
			model: 'qwen3-rerank',
		});

		await expect(
			reranker.rerank('查询', [{ id: 'a', text: '文本' }], 3),
		).rejects.toThrow('Network error');
	});

	it('rerank - 空文档列表 - 返回空数组(不发请求)', async () => {
		const fetchMock = global.fetch as ReturnType<typeof vi.fn>;

		const reranker = new BailianReranker({
			apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
			apiKey: 'sk-test',
			model: 'qwen3-rerank',
		});

		const result = await reranker.rerank('查询', [], 3);

		expect(result).toEqual([]);
		// 关键路径:空列表不调 fetch,节省 API 调用
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
