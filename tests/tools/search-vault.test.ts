/**
 * @file tests/tools/search-vault.test.ts
 * @description search_vault 工具单元测试(W4 — 内部改调 MultiQuerySearcher)
 * @module tests/tools/search-vault
 */

import { describe, it, expect, vi } from 'vitest';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import type { VectorSearchResult } from '../../src/ports/vector';

function createMockSearcher(results: VectorSearchResult[]) {
	return {
		search: vi.fn().mockResolvedValue(results),
	};
}

describe('createSearchVaultTool', () => {
	it('search_vault - 查询命中 - 返回 docId + score + metadata + index(从1) + reranked', async () => {
		const searcher = createMockSearcher([
			{ docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 }, reranked: true },
			{ docId: 'notes/other.md#chunk-0', score: 0.80, metadata: { path: 'notes/other.md', chunkIndex: 0 }, reranked: true },
		]);

		const tool = createSearchVaultTool(searcher as never, () => true);
		const result = await tool.execute({ query: '技术栈', topK: 5 });

		// 关键路径:searcher.search 被调用,参数透传
		expect(searcher.search).toHaveBeenCalledWith('技术栈', 5);
		// 关键路径:index 从 1 开始,供 LLM 引用 [1][2]
		expect(result).toEqual([
			{ docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 }, reranked: true, index: 1 },
			{ docId: 'notes/other.md#chunk-0', score: 0.80, metadata: { path: 'notes/other.md', chunkIndex: 0 }, reranked: true, index: 2 },
		]);
	});

	it('search_vault - 未命中 - 返回空数组', async () => {
		const searcher = createMockSearcher([]);
		const tool = createSearchVaultTool(searcher as never, () => true);
		const result = await tool.execute({ query: '不存在', topK: 3 });
		expect(result).toEqual([]);
	});

	it('search_vault - 未传 topK - 默认使用 5', async () => {
		const searcher = createMockSearcher([]);
		const tool = createSearchVaultTool(searcher as never, () => true);
		await tool.execute({ query: '技术栈' });
		// 关键路径:未传 topK 时用默认值 5
		expect(searcher.search).toHaveBeenCalledWith('技术栈', 5);
	});

	it('search_vault - query 非字符串 - 抛错', async () => {
		const searcher = createMockSearcher([]);
		const tool = createSearchVaultTool(searcher as never, () => true);
		await expect(tool.execute({ query: 123 })).rejects.toThrow('search_vault 参数 query 必须是有效字符串');
	});

	it('search_vault - 检索未就绪 - 抛 INDEX_NOT_READY', async () => {
		// 关键路径:符合 S-FEEDBACK 验收标准 — 检索未就绪时抛 INDEX_NOT_READY。
		const searcher = createMockSearcher([]);
		const tool = createSearchVaultTool(searcher as never, () => false);

		let caught: (Error & { code?: string }) | null = null;
		try {
			await tool.execute({ query: '技术栈' });
		} catch (err) {
			caught = err as Error & { code?: string };
		}

		expect(caught).not.toBeNull();
		expect(caught?.code).toBe('INDEX_NOT_READY');
		expect(caught?.message).toContain('尚未就绪');
		// 关键路径:未就绪时不调 searcher,避免在不可用阶段浪费算力。
		expect(searcher.search).not.toHaveBeenCalled();
	});

	it('search_vault - searcher 抛错 - 透传错误', async () => {
		const searcher = {
			search: vi.fn().mockRejectedValue(new Error('Worker timeout')),
		};
		const tool = createSearchVaultTool(searcher as never, () => true);
		await expect(tool.execute({ query: '技术栈' })).rejects.toThrow('Worker timeout');
	});
});
