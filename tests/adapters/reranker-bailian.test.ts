/**
 * @file tests/adapters/reranker-bailian.test.ts
 * @description 百炼 Reranker 适配器单元测试
 * @module tests/adapters/reranker-bailian
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 关键路径:vi.hoisted 确保 mockRequestUrl 在 vi.mock 提升前完成初始化,
// src/adapters/reranker-bailian.ts 现在通过 requestUrl 发请求,需 mock 'obsidian'。
const { mockRequestUrl } = vi.hoisted(() => ({
	mockRequestUrl: vi.fn(),
}));

vi.mock('obsidian', () => ({
	requestUrl: mockRequestUrl,
}));

import { BailianReranker } from '../../src/adapters/reranker-bailian';

describe('BailianReranker', () => {
	beforeEach(() => {
		mockRequestUrl.mockReset();
	});

	it('rerank - 正常响应 - 返回精排后的 id + score', async () => {
		// 关键路径:百炼返回 { results: [{ index, relevance_score }] },
		// index 对应请求 documents 数组的下标。
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: {
				results: [
					{ index: 1, relevance_score: 0.95 },
					{ index: 0, relevance_score: 0.72 },
					{ index: 2, relevance_score: 0.61 },
				],
			},
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
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { results: [] },
		});

		const reranker = new BailianReranker({
			apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
			apiKey: 'sk-test-key',
			model: 'qwen3-rerank',
		});

		await reranker.rerank('查询', [{ id: 'a', text: '文本A' }], 5);

		// 关键路径:验证请求 URL、method、headers、body 格式
		expect(mockRequestUrl).toHaveBeenCalledTimes(1);
		const callArg = mockRequestUrl.mock.calls[0]![0] as {
			url: string;
			method: string;
			headers: Record<string, string>;
			body: string;
		};
		expect(callArg.url).toBe('https://dashscope.aliyuncs.com/compatible-api/v1/rerank');
		expect(callArg.method).toBe('POST');
		expect(callArg.headers.Authorization).toBe('Bearer sk-test-key');
		expect(callArg.headers['Content-Type']).toBe('application/json');
		const body = JSON.parse(callArg.body);
		expect(body).toEqual({
			model: 'qwen3-rerank',
			query: '查询',
			documents: ['文本A'],
			top_n: 5,
		});
	});

	it('rerank - HTTP 错误 - 抛错', async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 401,
			text: 'Unauthorized',
		});

		const reranker = new BailianReranker({
			apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
			apiKey: 'invalid-key',
			model: 'qwen3-rerank',
		});

		await expect(
			reranker.rerank('查询', [{ id: 'a', text: '文本' }], 3),
		).rejects.toThrow('Bailian Rerank API error: 401 Unauthorized');
	});

	it('rerank - 网络异常 - 抛错', async () => {
		mockRequestUrl.mockRejectedValueOnce(new Error('Network error'));

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
		const reranker = new BailianReranker({
			apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
			apiKey: 'sk-test',
			model: 'qwen3-rerank',
		});

		const result = await reranker.rerank('查询', [], 3);

		expect(result).toEqual([]);
		// 关键路径:空列表不调 requestUrl,节省 API 调用
		expect(mockRequestUrl).not.toHaveBeenCalled();
	});
});
