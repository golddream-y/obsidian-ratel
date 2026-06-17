/**
 * @file tests/tools/search-vault.test.ts
 * @description search_vault 工具单元测试
 * @module tests/tools/search-vault
 * @depends tools/search-vault
 */

import { describe, it, expect, vi } from 'vitest';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import type { VectorSearchResult } from '../../src/ports/vector';

function createMockEmbedding(): EmbeddingPort {
	return {
		embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
		dimensions: 3,
		modelId: 'local:mock',
	};
}

function createMockWorkerManager(): WorkerManager {
	return {
		request: vi.fn(),
		destroy: vi.fn(),
	} as unknown as WorkerManager;
}

describe('createSearchVaultTool', () => {
	it('search_vault - 查询命中 - 返回 docId + score + metadata', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager();
		worker.request = vi.fn().mockResolvedValue({
			type: 'vector.search.result',
			payload: [
				{ docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 } },
			] as VectorSearchResult[],
		});

		const tool = createSearchVaultTool(embedding, worker);
		const result = await tool.execute({ query: '技术栈', topK: 5 });

		expect(embedding.embed).toHaveBeenCalledWith(['技术栈']);
		expect(worker.request).toHaveBeenCalledWith({
			type: 'vector.search',
			payload: { queryVector: [0.1, 0.2, 0.3], topK: 5 },
		});
		expect(result).toEqual([
			{ docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 } },
		]);
	});

	it('search_vault - 未命中 - 返回空数组', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager();
		worker.request = vi.fn().mockResolvedValue({
			type: 'vector.search.result',
			payload: [] as VectorSearchResult[],
		});

		const tool = createSearchVaultTool(embedding, worker);
		const result = await tool.execute({ query: '不存在', topK: 3 });

		expect(result).toEqual([]);
	});

	it('search_vault - Worker 返回异常类型 - 抛错', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager();
		worker.request = vi.fn().mockResolvedValue({
			type: 'error',
			payload: { code: 'WORKER_ERROR', message: 'boom' },
		});

		const tool = createSearchVaultTool(embedding, worker);
		await expect(tool.execute({ query: '技术栈' })).rejects.toThrow('Unexpected worker response type: error');
	});

	it('search_vault - 未传 topK - 默认使用 5', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager();
		worker.request = vi.fn().mockResolvedValue({
			type: 'vector.search.result',
			payload: [] as VectorSearchResult[],
		});

		const tool = createSearchVaultTool(embedding, worker);
		await tool.execute({ query: '技术栈' });

		expect(worker.request).toHaveBeenCalledWith({
			type: 'vector.search',
			payload: { queryVector: [0.1, 0.2, 0.3], topK: 5 },
		});
	});

	it('search_vault - query 非字符串 - 抛错', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager();
		const tool = createSearchVaultTool(embedding, worker);
		await expect(tool.execute({ query: 123 })).rejects.toThrow('search_vault 参数 query 必须是有效字符串');
	});
});
