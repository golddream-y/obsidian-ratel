/**
 * @file tests/core/multi-query-searcher.test.ts
 * @description 多查询搜索编排器单元测试
 * @module tests/core/multi-query-searcher
 */

import { describe, it, expect, vi } from 'vitest';
import { MultiQuerySearcher } from '../../src/core/multi-query-searcher';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import type { RerankerPort } from '../../src/ports/reranker';
import type { VectorSearchResult } from '../../src/ports/vector';

function createMockEmbedding(): EmbeddingPort {
	return {
		// 关键路径:不同查询返回不同向量,便于区分多查询
		embed: vi.fn(async (texts: string[]) =>
			texts.map((t) => [t.length * 0.01, 0.2, 0.3]),
		),
		dimensions: 3,
		modelId: 'local:mock',
	};
}

function createMockWorkerManager(resultsPerQuery: VectorSearchResult[][]): WorkerManager {
	let callIndex = 0;
	return {
		request: vi.fn(async () => {
			const results = resultsPerQuery[callIndex++] ?? [];
			return { type: 'hybrid.search.result', payload: results };
		}),
		destroy: vi.fn(),
	} as unknown as WorkerManager;
}

function createMockReranker(): RerankerPort {
	return {
		// 关键路径:rerank 反转顺序,便于验证 rerank 步骤执行
		rerank: vi.fn(async (_query: string, documents: Array<{ id: string; text: string }>, topK: number) =>
			documents.slice(0, topK).reverse().map((d, i) => ({ id: d.id, score: 1 - i * 0.1 })),
		),
	};
}

function createMockVault(readFileImpl: (path: string) => Promise<string>): import('../../src/adapters/obsidian-vault').ObsidianVault {
	return {
		readFile: readFileImpl,
	} as unknown as import('../../src/adapters/obsidian-vault').ObsidianVault;
}

function createMockQueryRewriter(variants: string[]): { rewrite: (q: string) => Promise<string[]> } {
	return {
		rewrite: vi.fn(async (_q: string) => variants),
	};
}

describe('MultiQuerySearcher', () => {
	it('search - 无 queryRewriter + 无 reranker - 单查询直接返回(带 reranked=false)', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
			],
		]);
		const vault = createMockVault(async () => 'content');

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			// 关键路径:不注入 queryRewriter 和 reranker,走最简路径
		});

		const results = await searcher.search('查询', 5);

		expect(results).toHaveLength(2);
		expect(results[0]!.docId).toBe('a.md#chunk-0');
		// 关键路径:无 reranker 时 reranked=false
		expect(results[0]!.reranked).toBe(false);
		expect(embedding.embed).toHaveBeenCalledTimes(1);
		expect(worker.request).toHaveBeenCalledTimes(1);
	});

	it('search - 有 queryRewriter - 多查询 + RRF 融合', async () => {
		const embedding = createMockEmbedding();
		// 关键路径:3 次查询(原始 + 2 改写),每次返回不同结果
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
			],
			[
				{ docId: 'a.md#chunk-0', score: 0.85, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
			],
			[
				{ docId: 'b.md#chunk-0', score: 0.88, metadata: { path: 'b.md', chunkIndex: 0 } },
			],
		]);
		const vault = createMockVault(async () => 'content');
		// 关键路径:mock 返回值含原始查询(匹配 Task 9 接线 — rewriteQuery 返回 [original, ...rewrites]),
		// 因此 MultiQuerySearcher 直接用 variants,不再前置 original。
		const queryRewriter = createMockQueryRewriter(['查询', '变体1', '变体2']);

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			queryRewriter,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:3 次查询 = 3 次 embedding + 3 次 worker.request
		expect(embedding.embed).toHaveBeenCalledTimes(3);
		expect(worker.request).toHaveBeenCalledTimes(3);
		// RRF 融合后 a.md 在两列表出现,b.md 在两列表出现,c.md 一次
		expect(results.length).toBeGreaterThanOrEqual(2);
		// 无 reranker,reranked=false
		expect(results[0]!.reranked).toBe(false);
	});

	it('search - 有 reranker - RRF 后精排(带 reranked=true)', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
			],
		]);
		const vault = createMockVault(async (p) => `content-of-${p}`);
		const reranker = createMockReranker();

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			reranker,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:reranker 被调用,vault.readFile 被调用读全文
		expect(reranker.rerank).toHaveBeenCalledTimes(1);
		// 关键路径:reranked=true 标识经过精排
		expect(results.every((r) => r.reranked === true)).toBe(true);
	});

	it('search - reranker 抛错 - 降级返回 RRF 结果(reranked=false)', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
			],
		]);
		const vault = createMockVault(async () => 'content');
		const reranker: RerankerPort = {
			rerank: vi.fn().mockRejectedValue(new Error('Reranker API down')),
		};

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			reranker,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:reranker 失败,降级返回 RRF 结果,不抛错
		expect(results).toHaveLength(1);
		expect(results[0]!.reranked).toBe(false);
	});

	it('search - queryRewriter 抛错 - 降级为单查询', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } }],
		]);
		const vault = createMockVault(async () => 'content');
		const queryRewriter = {
			rewrite: vi.fn().mockRejectedValue(new Error('LLM down')),
		};

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			queryRewriter,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:queryRewriter 失败,降级为单查询,仍返回结果
		expect(results).toHaveLength(1);
		expect(embedding.embed).toHaveBeenCalledTimes(1);
	});

	it('search - 传 topK*2 给 hybrid.search(过度抓取)', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } }],
		]);
		const vault = createMockVault(async () => 'content');

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
		});

		await searcher.search('查询', 5);

		// 关键路径:传给 Worker 的 topK = 5*2 = 10(过度抓取,补偿 RRF 丢弃)
		const requestCall = (worker.request as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(requestCall.type).toBe('hybrid.search');
		expect(requestCall.payload.topK).toBe(10);
	});

	it('search - reranker 存在但所有文档缺 metadata.path - 全部 reranked=false', async () => {
		const embedding = createMockEmbedding();
		// 关键路径:结果无 metadata.path,无法读取全文送入 Reranker
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: {} },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: {} },
			],
		]);
		const vault = createMockVault(async () => 'content');
		const reranker = createMockReranker();

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			reranker,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:所有文档缺 path → documents.length === 0 → 走 else 分支 → reranked=false,
		// 且 reranker.rerank 不被调用(无文档可精排)。
		expect(reranker.rerank).not.toHaveBeenCalled();
		expect(results.every((r) => r.reranked === false)).toBe(true);
	});

	it('search - reranker 存在且部分文档缺 metadata.path - 仅送入的文档 reranked=true', async () => {
		const embedding = createMockEmbedding();
		// 关键路径:a.md 有 path,b.md 无 path — 仅 a.md 送入 Reranker
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: {} },
			],
		]);
		const vault = createMockVault(async (p) => `content-of-${p}`);
		const reranker = createMockReranker();

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			reranker,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:仅 a.md 有 path 被送入 Reranker → reranked=true;b.md 无 path → reranked=false。
		const docA = results.find((r) => r.docId === 'a.md#chunk-0');
		const docB = results.find((r) => r.docId === 'b.md#chunk-0');
		expect(docA).toBeDefined();
		expect(docA!.reranked).toBe(true);
		expect(docB).toBeDefined();
		expect(docB!.reranked).toBe(false);
	});

	it('search - Reranker 丢弃部分文档 - 被丢弃文档保持 reranked=false 与 RRF 分数', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
			],
		]);
		const vault = createMockVault(async (p) => `content-of-${p}`);
		// 关键路径:Reranker 只返回 a.md(丢弃 b.md),模拟服务端 top_n 截断
		const reranker: RerankerPort = {
			rerank: vi.fn(async (_q, documents) => {
				const kept = documents[0]!;
				return [{ id: kept.id, score: 0.95 }];
			}),
		};

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			reranker,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:a.md 拿到 Reranker 分数 → reranked=true;b.md 被丢弃 → reranked=false,保持 RRF 分数
		const docA = results.find((r) => r.docId === 'a.md#chunk-0');
		const docB = results.find((r) => r.docId === 'b.md#chunk-0');
		expect(docA).toBeDefined();
		expect(docA!.reranked).toBe(true);
		expect(docA!.score).toBe(0.95);
		expect(docB).toBeDefined();
		expect(docB!.reranked).toBe(false);
		// 关键路径:b.md 被丢弃,分数仍是 RRF(非 Reranker 的 0.95)
		expect(docB!.score).not.toBe(0.95);
	});
});
