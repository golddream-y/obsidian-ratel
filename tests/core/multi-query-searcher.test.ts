/**
 * @file tests/core/multi-query-searcher.test.ts
 * @description 多查询搜索编排器单元测试
 * @module tests/core/multi-query-searcher
 */

import { describe, it, expect, vi } from 'vitest';
import { MultiQuerySearcher, type SearchCandidateGate } from '../../src/core/multi-query-searcher';
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
			return { type: 'vector.search.result', payload: results };
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
		// 关键路径:候选 ≥ MIN_RERANK_CANDIDATES(4)才精排,少于则短路
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
				{ docId: 'd.md#chunk-0', score: 0.6, metadata: { path: 'd.md', chunkIndex: 0 } },
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

	it('search - 候选 ≤3 条 - 不调用精排且不读全文', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
			],
		]);
		// 关键路径:必须是 vi.fn,否则无法断言「没读过全文」
		const readFile = vi.fn(async () => 'content');
		const vault = createMockVault(readFile);
		const reranker = { rerank: vi.fn(async () => []) };

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			reranker,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:候选不足时既不调精排也不读全文(省掉无谓的 IO 与一次模型调用)
		expect(reranker.rerank).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
		expect(results.every((r) => r.reranked === false)).toBe(true);
		// 关键路径:顺序保持 RRF 顺序
		expect(results.map((r) => r.docId)).toEqual([
			'a.md#chunk-0',
			'b.md#chunk-0',
			'c.md#chunk-0',
		]);
	});

	it('search - reranker 工厂返回 undefined(精排关闭) - 不调用精排且不读全文', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
				{ docId: 'd.md#chunk-0', score: 0.6, metadata: { path: 'd.md', chunkIndex: 0 } },
			],
		]);
		const readFile = vi.fn(async () => 'content');
		const vault = createMockVault(readFile);
		const factory = vi.fn(() => undefined);

		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			reranker: factory,
		});

		const results = await searcher.search('查询', 5);

		// 关键路径:工厂解析出 undefined → 视为未启用精排,连全文都不读
		expect(factory).toHaveBeenCalledTimes(1);
		expect(readFile).not.toHaveBeenCalled();
		expect(results.every((r) => r.reranked === false)).toBe(true);
	});

	it('search - reranker 抛错 - 降级返回 RRF 结果(reranked=false)', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
				{ docId: 'd.md#chunk-0', score: 0.6, metadata: { path: 'd.md', chunkIndex: 0 } },
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
		expect(results).toHaveLength(4);
		expect(results.every((r) => r.reranked === false)).toBe(true);
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

	it('search - 传 topK*2 给 vector.search(过度抓取)', async () => {
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
		expect(requestCall.type).toBe('vector.search');
		expect(requestCall.payload.topK).toBe(10);
	});

	it('search - reranker 存在但所有文档缺 metadata.path - 全部 reranked=false', async () => {
		const embedding = createMockEmbedding();
		// 关键路径:结果无 metadata.path,无法读取全文送入 Reranker
		// 关键路径:候选数必须 ≥ MIN_RERANK_CANDIDATES,否则会先被短路,测不到本用例原意
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: {} },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: {} },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: {} },
				{ docId: 'd.md#chunk-0', score: 0.6, metadata: {} },
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
		expect(results).toHaveLength(4);
		expect(results.every((r) => r.reranked === false)).toBe(true);
	});

	it('search - reranker 存在且部分文档缺 metadata.path - 仅送入的文档 reranked=true', async () => {
		const embedding = createMockEmbedding();
		// 关键路径:a/c.md 有 path,b/d.md 无 path — 仅 a/c.md 送入 Reranker
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: {} },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
				{ docId: 'd.md#chunk-0', score: 0.6, metadata: {} },
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

		// 关键路径:仅有 path 的文档被送入 Reranker → reranked=true;无 path 的 → reranked=false。
		const docA = results.find((r) => r.docId === 'a.md#chunk-0');
		const docB = results.find((r) => r.docId === 'b.md#chunk-0');
		const docC = results.find((r) => r.docId === 'c.md#chunk-0');
		const docD = results.find((r) => r.docId === 'd.md#chunk-0');
		expect(docA).toBeDefined();
		expect(docA!.reranked).toBe(true);
		expect(docC!.reranked).toBe(true);
		expect(docB).toBeDefined();
		expect(docB!.reranked).toBe(false);
		expect(docD!.reranked).toBe(false);
	});

	it('search - Reranker 丢弃部分文档 - 被丢弃文档保持 reranked=false 与 RRF 分数', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
				{ docId: 'd.md#chunk-0', score: 0.6, metadata: { path: 'd.md', chunkIndex: 0 } },
			],
		]);
		const vault = createMockVault(async (p) => `content-of-${p}`);
		// 关键路径:Reranker 只返回 a.md(丢弃 b/c/d.md),模拟服务端 top_n 截断
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

describe('MultiQuerySearcher 可见性门 — 被拒候选不得进入融合与重排输入', () => {
	/** 构造只按路径判定可见性的门;被拒原因固定为候选自身的过期/删除/排除/未决语义。 */
	function createGate(denied: Map<string, 'known-stale' | 'deleted' | 'excluded' | 'unresolved-transaction'>): SearchCandidateGate {
		return {
			decide: vi.fn(async (path: string) => {
				const reason = denied.get(path);
				if (reason !== undefined) {
					return { visible: false, path, reason, freshness: reason };
				}
				return { visible: true, path, freshness: 'verified' as const };
			}),
		};
	}

	it('search - 原始候选含 stale/deleted/excluded/unresolved - 被拒路径进入融合与重排的命中数为 0', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'stale.md#chunk-0', score: 0.99, metadata: { path: 'stale.md', chunkIndex: 0 } },
				{ docId: 'deleted.md#chunk-0', score: 0.98, metadata: { path: 'deleted.md', chunkIndex: 0 } },
				{ docId: 'excluded.md#chunk-0', score: 0.97, metadata: { path: 'excluded.md', chunkIndex: 0 } },
				{ docId: 'unresolved.md#chunk-0', score: 0.96, metadata: { path: 'unresolved.md', chunkIndex: 0 } },
				{ docId: 'ok1.md#chunk-0', score: 0.9, metadata: { path: 'ok1.md', chunkIndex: 0 } },
				{ docId: 'ok2.md#chunk-0', score: 0.8, metadata: { path: 'ok2.md', chunkIndex: 0 } },
				{ docId: 'ok3.md#chunk-0', score: 0.7, metadata: { path: 'ok3.md', chunkIndex: 0 } },
				{ docId: 'ok4.md#chunk-0', score: 0.6, metadata: { path: 'ok4.md', chunkIndex: 0 } },
			],
		]);
		const denied = new Map<string, 'known-stale' | 'deleted' | 'excluded' | 'unresolved-transaction'>([
			['stale.md', 'known-stale'],
			['deleted.md', 'deleted'],
			['excluded.md', 'excluded'],
			['unresolved.md', 'unresolved-transaction'],
		]);
		const gate = createGate(denied);
		const readPaths: string[] = [];
		const vault = createMockVault(async (p) => {
			readPaths.push(p);
			return `content-of-${p}`;
		});
		// 关键路径:rerank 输入是「模型实际会看到的片段」,必须按 spy 实测而不是只看最终结果。
		const reranker = createMockReranker();
		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault,
			reranker,
			visibility: gate,
		});

		const results = await searcher.search('查询', 5);

		const rerankCalls = (reranker.rerank as ReturnType<typeof vi.fn>).mock.calls;
		expect(rerankCalls).toHaveLength(1);
		const sentIds = (rerankCalls[0]![1] as Array<{ id: string }>).map((d) => d.id);
		const deniedIds = [...denied.keys()].map((p) => `${p}#chunk-0`);
		// 关键路径:被拒路径在精排输入里的命中数必须为 0,而不是「最终 UI 看不到」。
		expect(sentIds.filter((id) => deniedIds.includes(id))).toHaveLength(0);
		// 精排输入恰为四个可见候选(每个可见路径各读一次全文)。
		expect(sentIds.sort()).toEqual(['ok1.md#chunk-0', 'ok2.md#chunk-0', 'ok3.md#chunk-0', 'ok4.md#chunk-0']);
		expect(readPaths.filter((p) => denied.has(p))).toHaveLength(0);
		// 最终结果同样不含被拒路径,且可见候选携带新鲜度。
		expect(results.map((r) => r.metadata.path).sort()).toEqual(['ok1.md', 'ok2.md', 'ok3.md', 'ok4.md']);
		expect(results.every((r) => r.freshness === 'verified')).toBe(true);
		// 门的判定在融合之前完成:每个路径只判定一次。
		expect((gate.decide as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(8);
	});

	it('search - 过滤后可见候选不足 topK - 增大抓取量重取候选补足', async () => {
		const embedding = createMockEmbedding();
		const topKPerCall: number[] = [];
		let call = 0;
		const worker = {
			request: vi.fn(async (request: { payload: { topK: number } }) => {
				topKPerCall.push(request.payload.topK);
				call += 1;
				// 第一次:3 个被拒 + 1 个可见;第二次:4 个可见。
				const payload = call === 1
					? [
						{ docId: 'stale.md#chunk-0', score: 0.99, metadata: { path: 'stale.md', chunkIndex: 0 } },
						{ docId: 'deleted.md#chunk-0', score: 0.98, metadata: { path: 'deleted.md', chunkIndex: 0 } },
						{ docId: 'excluded.md#chunk-0', score: 0.97, metadata: { path: 'excluded.md', chunkIndex: 0 } },
						{ docId: 'ok1.md#chunk-0', score: 0.9, metadata: { path: 'ok1.md', chunkIndex: 0 } },
					]
					: [
						{ docId: 'ok1.md#chunk-0', score: 0.9, metadata: { path: 'ok1.md', chunkIndex: 0 } },
						{ docId: 'ok2.md#chunk-0', score: 0.8, metadata: { path: 'ok2.md', chunkIndex: 0 } },
						{ docId: 'ok3.md#chunk-0', score: 0.7, metadata: { path: 'ok3.md', chunkIndex: 0 } },
						{ docId: 'ok4.md#chunk-0', score: 0.6, metadata: { path: 'ok4.md', chunkIndex: 0 } },
					];
				return { type: 'vector.search.result', payload };
			}),
			destroy: vi.fn(),
		} as unknown as WorkerManager;
		const gate = createGate(new Map([
			['stale.md', 'known-stale'],
			['deleted.md', 'deleted'],
			['excluded.md', 'excluded'],
		]));
		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault: createMockVault(async () => 'content'),
			visibility: gate,
		});

		const results = await searcher.search('查询', 2);

		// 关键路径:首轮仍是 topK*2 过度抓取;可见不足 topK 时翻倍重取。
		expect(topKPerCall).toEqual([4, 8]);
		expect(results).toHaveLength(2);
		expect(results.map((r) => r.metadata.path).sort()).toEqual(['ok1.md', 'ok2.md']);
		expect(embedding.embed).toHaveBeenCalledTimes(1);
	});

	it('search - 门 refresh 每次检索调用一次 - 刷新判定依据', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } }],
		]);
		const refresh = vi.fn(async () => undefined);
		const gate: SearchCandidateGate = {
			refresh,
			decide: vi.fn(async (path: string) => ({ visible: true, path, freshness: 'unknown' as const })),
		};
		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault: createMockVault(async () => 'content'),
			visibility: gate,
		});

		await searcher.search('查询', 5);

		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('search - 无可见性门 - 保持原行为不过滤(向后兼容)', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
			],
		]);
		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault: createMockVault(async () => 'content'),
		});

		const results = await searcher.search('查询', 5);

		expect(results).toHaveLength(2);
		// 未装配门时新鲜度未知,由调用方决定是否承诺定位。
		expect(results.every((r) => r.freshness === undefined)).toBe(true);
		expect(searcher.visibilityDiagnostics()).toBeUndefined();
	});

	it('search - 门报告记录不可判定 - 诊断暴露 unjudgeable 供工具层如实呈现', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } }],
		]);
		const gate: SearchCandidateGate = {
			recordsKind: () => 'unjudgeable' as const,
			decide: vi.fn(async (path: string) => ({
				visible: false,
				path,
				reason: 'unjudgeable',
				freshness: 'unknown' as const,
			})),
		};
		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault: createMockVault(async () => 'content'),
			visibility: gate,
		});

		const results = await searcher.search('查询', 5);

		expect(results).toEqual([]);
		expect(searcher.visibilityDiagnostics()).toMatchObject({
			recordsKind: 'unjudgeable',
			denied: 1,
		});
	});
});

describe('候选来源端口', () => {
	it('提供端口时 - 走端口取候选 - 不再调用 Worker', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([[]]);
		const candidateSource = {
			search: vi.fn(async (): Promise<VectorSearchResult[]> => [
				{ docId: 'd1', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
			]),
		};
		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault: createMockVault(async () => '正文'),
			candidateSource,
		});
		const results = await searcher.search('查询', 5);
		expect(candidateSource.search).toHaveBeenCalledTimes(1);
		expect(worker.request).not.toHaveBeenCalled();
		expect(results.map((result) => result.docId)).toContain('d1');
	});

	it('端口抛错 - 与 Worker 失败同语义 - 返回空结果而不是抛出', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([[]]);
		const candidateSource = {
			search: vi.fn(async (): Promise<VectorSearchResult[]> => { throw new Error('线程已停止'); }),
		};
		const searcher = new MultiQuerySearcher({
			embedding,
			workerManager: worker,
			vault: createMockVault(async () => '正文'),
			candidateSource,
		});
		await expect(searcher.search('查询', 5)).resolves.toEqual([]);
	});
});
