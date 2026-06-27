# W4 检索精准度增强(Query Rewrite + RRF + Reranker + Indexer)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Query Rewrite(LLM 改写查询)、RRF 多查询融合、百炼 Reranker 精排、Indexer subagent,完成 S-W4-RAG-ENHANCEMENT spec 全部目标。

**Architecture:** MultiQuerySearcher 编排"改写 → 多查询 hybrid.search → RRF 融合 → 可选 Rerank 精排"四步管线,对 search_vault 工具与 LLM 透明(签名不变)。search_vault 内部从 W3 的单次 hybrid.search 升级为调用 MultiQuerySearcher.search。Indexer subagent 封装 IndexController,供其他子代理通过统一接口触发索引。

**Tech Stack:** TypeScript(strict)、vectra(hybridSearch 已在 W3 实现)、vitest、百炼 DashScope API(fetch)。

**所属 Spec:** [S-W4-RAG-ENHANCEMENT](../specs/2026-06-26-ratel-w4-rag-enhancement-design.md)
**前置依赖:** [P-W3-HYBRID](2026-06-26-ratel-w3-hybrid-implementation.md) 已完成(hybridSearch + search_vault + 意图分类器 + search.result 事件 + ChatView 卡片)

---

## 文件结构

### 新建

| 文件 | 职责 |
|------|------|
| `src/core/rrf.ts` | RRF(Reciprocal Rank Fusion)算法 — 纯函数,合并多排序列表 |
| `src/core/query-rewriter.ts` | LLM 查询改写 — 生成 2-3 个语义变体 |
| `src/core/multi-query-searcher.ts` | 多查询搜索编排 — 改写 + 多查询 + RRF + 可选 Rerank |
| `src/ports/reranker.ts` | Reranker 端口 — 精排接口契约 |
| `src/adapters/reranker-bailian.ts` | 百炼 DashScope Reranker 实现 |
| `src/subagents/indexer.ts` | Indexer subagent — 封装 IndexController 供子代理调用 |
| `tests/core/rrf.test.ts` | RRF 单元测试 |
| `tests/core/query-rewriter.test.ts` | 查询改写单元测试 |
| `tests/core/multi-query-searcher.test.ts` | 多查询搜索编排单元测试 |
| `tests/adapters/reranker-bailian.test.ts` | 百炼 Reranker 单元测试 |
| `tests/subagents/indexer.test.ts` | Indexer subagent 单元测试 |

### 修改

| 文件 | 改动 |
|------|------|
| `src/ports/vector.ts` | `VectorSearchResult` 加可选 `reranked?: boolean` 字段(W4 标识是否经 Rerank) |
| `src/types.ts` | `AgentEvent` 的 `search.result` payload 加 `reranked: boolean` 字段 |
| `src/tools/search-vault.ts` | execute 内部改调 `MultiQuerySearcher.search`(对 LLM 透明,签名不变);签名改为接收 MultiQuerySearcher |
| `src/core/agent-loop.ts` | search.result 事件 payload 加 `reranked` 字段(从结果推断) |
| `src/ui/ChatView.svelte` | search.result 事件处理 + 卡片渲染加 reranked 标记 |
| `src/main.ts` | 注入 MultiQuerySearcher(含可选 RerankerPort + QueryRewriter)到 search_vault 工具 |
| `tests/tools/search-vault.test.ts` | 改 mock 为 MultiQuerySearcher,断言 index + reranked |
| `tests/core/agent-loop.test.ts` | 加 search.result reranked 字段测试 |

---

## Task 1: RRF 算法 + 测试

**Files:**
- Create: `src/core/rrf.ts`
- Test: `tests/core/rrf.test.ts`

纯函数,无外部依赖,先行实现。

- [ ] **Step 1: 写失败测试**

新建 `tests/core/rrf.test.ts`:

```typescript
/**
 * @file tests/core/rrf.test.ts
 * @description RRF(Reciprocal Rank Fusion)单元测试
 * @module tests/core/rrf
 */

import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../../src/core/rrf';

describe('reciprocalRankFusion', () => {
	it('RRF - 空输入 - 返回空数组', () => {
		expect(reciprocalRankFusion([])).toEqual([]);
	});

	it('RRF - 单列表 - 原样返回(rank 从 0 开始)', () => {
		const lists = [[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }]];
		const result = reciprocalRankFusion(lists);
		// 关键路径:单列表 RRF score = 1/(60+rank),rank 从 0 开始
		expect(result).toHaveLength(2);
		expect(result[0]!.id).toBe('a');
		expect(result[0]!.rrfScore).toBeCloseTo(1 / 60, 5);
		expect(result[1]!.id).toBe('b');
		expect(result[1]!.rrfScore).toBeCloseTo(1 / 61, 5);
	});

	it('RRF - 多列表重叠项 - 分数累加', () => {
		// 关键路径:doc-a 在两个列表都排第 1,RRF 分数 = 1/60 + 1/60 = 2/60
		const lists = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
			[{ id: 'a', score: 0.85 }, { id: 'c', score: 0.7 }],
		];
		const result = reciprocalRankFusion(lists);
		expect(result).toHaveLength(3);
		// doc-a 分数最高(两列表都命中)
		expect(result[0]!.id).toBe('a');
		expect(result[0]!.rrfScore).toBeCloseTo(2 / 60, 5);
		expect(result[0]!.sourceScores).toEqual([0.9, 0.85]);
	});

	it('RRF - k 参数 - 影响 score 计算', () => {
		const lists = [[{ id: 'a', score: 0.9 }]];
		// 关键路径:k=40 → score = 1/(40+0) = 1/40
		const result = reciprocalRankFusion(lists, 40);
		expect(result[0]!.rrfScore).toBeCloseTo(1 / 40, 5);
	});

	it('RRF - topK 截断 - 只返回 topK 个', () => {
		const lists = [
			[
				{ id: 'a', score: 0.9 },
				{ id: 'b', score: 0.8 },
				{ id: 'c', score: 0.7 },
			],
		];
		const result = reciprocalRankFusion(lists, 60, 2);
		expect(result).toHaveLength(2);
		expect(result[0]!.id).toBe('a');
		expect(result[1]!.id).toBe('b');
	});

	it('RRF - 同 id 多次出现 - sourceScores 记录所有来源分数', () => {
		const lists = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
			[{ id: 'c', score: 0.7 }, { id: 'a', score: 0.85 }],
			// 关键路径:第三列表不含 a,sourceScores[2] 应为 undefined
		];
		const result = reciprocalRankFusion(lists);
		const itemA = result.find((r) => r.id === 'a');
		expect(itemA).toBeDefined();
		expect(itemA!.sourceScores).toEqual([0.9, 0.85, undefined]);
	});

	it('RRF - 按分数降序排列', () => {
		const lists = [
			[{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }],
			[{ id: 'b', score: 0.85 }, { id: 'a', score: 0.7 }],
		];
		const result = reciprocalRankFusion(lists);
		// 关键路径:b 在两列表分别排第 1 和第 2,分数 = 1/60 + 1/61 > a 的 1/61 + 1/60... 实际相等,看顺序
		// a: rank0 in list1 + rank1 in list2 = 1/60 + 1/61
		// b: rank1 in list1 + rank0 in list2 = 1/61 + 1/60
		// 分数相同,顺序由实现决定(稳定排序保留首次出现顺序)
		expect(result).toHaveLength(2);
		expect(result[0]!.rrfScore).toBeGreaterThanOrEqual(result[1]!.rrfScore);
	});
});
```

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/core/rrf.test.ts`
Expected: FAIL,`Cannot find module '../../src/core/rrf'`

- [ ] **Step 3: 实现 rrf.ts**

新建 `src/core/rrf.ts`:

```typescript
/**
 * @file src/core/rrf.ts
 * @description Reciprocal Rank Fusion — 合并多个排序列表的纯函数算法
 * @module core/rrf
 * @depends (无)
 */

/**
 * 待融合的单条排序项。
 * @param id - 文档唯一标识(本项目用 docId)。
 * @param score - 原始分数(来自向量搜索/BM25,RRF 不直接使用,仅记录到 sourceScores)。
 */
export interface RankedItem {
	id: string;
	score: number;
}

/**
 * 融合后的单条结果。
 * @param id - 文档唯一标识。
 * @param rrfScore - RRF 融合分数,值越大越相关。
 * @param sourceScores - 各来源列表的原始分数(未出现的列表对应 undefined)。
 */
export interface FusedItem {
	id: string;
	rrfScore: number;
	sourceScores: (number | undefined)[];
}

/**
 * 默认 RRF 参数 k(Cormack et al. 2009 推荐值 60)。
 * k 越大,排名差异对分数的影响越平滑;越小,头部排名优势越明显。
 */
const DEFAULT_K = 60;

/**
 * Reciprocal Rank Fusion — 合并多个排序列表。
 *
 * 关键路径:
 * - RRF score = Σ 1/(k + rank),rank 从 0 开始(排名第 1 的项 rank=0)。
 * - 同一文档在多个列表中出现 → RRF 分数累加。
 * - sourceScores 记录该文档在各列表中的原始分数(未出现为 undefined),供调试。
 * - 按 RRF 分数降序排列,取 topK(若指定)。
 * - 分数相同时,按首次出现顺序保留稳定排序。
 *
 * @param lists - 多个排序列表(每个变体查询的搜索结果)。
 * @param k - RRF 参数,默认 60。
 * @param topK - 返回结果上限;未指定时返回全部。
 * @returns 融合后的排序列表,按 rrfScore 降序。
 */
export function reciprocalRankFusion(
	lists: RankedItem[][],
	k: number = DEFAULT_K,
	topK?: number,
): FusedItem[] {
	// 关键路径:空输入直接返回,避免后续逻辑出错。
	if (lists.length === 0) return [];

	// 用 Map 累加 RRF 分数,同时记录各来源原始分数。
	const scoreMap = new Map<string, { rrfScore: number; sourceScores: (number | undefined)[] }>();
	// 关键路径:记录首次出现顺序,保证分数相同时稳定排序。
	const order: string[] = [];

	lists.forEach((list, listIndex) => {
		list.forEach((item, rank) => {
			// 关键路径:rank 从 0 开始,排名第 1 的项贡献 1/(k+0) = 1/k。
			const contribution = 1 / (k + rank);
			let entry = scoreMap.get(item.id);
			if (!entry) {
				// 关键路径:初始化 sourceScores,长度等于列表数,全部填 undefined。
				entry = {
					rrfScore: 0,
					sourceScores: new Array(lists.length).fill(undefined),
				};
				scoreMap.set(item.id, entry);
				order.push(item.id);
			}
			entry.rrfScore += contribution;
			// 关键路径:记录该列表的原始分数(可能被同一列表多次出现覆盖,取最后一次)。
			entry.sourceScores[listIndex] = item.score;
		});
	});

	// 转数组并按 rrfScore 降序;分数相同时按首次出现顺序(稳定排序)。
	const result: FusedItem[] = order.map((id) => {
		const entry = scoreMap.get(id)!;
		return { id, rrfScore: entry.rrfScore, sourceScores: entry.sourceScores };
	});

	result.sort((a, b) => {
		if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
		// 关键路径:分数相同,保留首次出现顺序(稳定排序)。
		return order.indexOf(a.id) - order.indexOf(b.id);
	});

	return topK !== undefined ? result.slice(0, topK) : result;
}
```

- [ ] **Step 4: 运行测试,验证通过**

Run: `npx vitest run tests/core/rrf.test.ts`
Expected: PASS(7 个测试通过)

- [ ] **Step 5: 提交**

```bash
git add src/core/rrf.ts tests/core/rrf.test.ts
git commit -m "feat(w4): RRF 算法 — Reciprocal Rank Fusion 多列表融合"
```

---

## Task 2: Query Rewriter + 测试

**Files:**
- Create: `src/core/query-rewriter.ts`
- Test: `tests/core/query-rewriter.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/core/query-rewriter.test.ts`:

```typescript
/**
 * @file tests/core/query-rewriter.test.ts
 * @description 查询改写器单元测试
 * @module tests/core/query-rewriter
 */

import { describe, it, expect, vi } from 'vitest';
import { rewriteQuery } from '../../src/core/query-rewriter';
import type { LLMClient, ChatRequest, ChatDelta } from '../../src/ports/llm';

function createMockLLM(streamOutput: string): LLMClient {
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			yield { text: streamOutput };
		},
		countTokens: () => 10,
	};
}

function createMockLLMThrowing(): LLMClient {
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			throw new Error('LLM unavailable');
		},
		countTokens: () => 10,
	};
}

describe('rewriteQuery', () => {
	it('rewriteQuery - LLM 返回两个变体 - 返回 original + 2 个改写', async () => {
		// 关键路径:LLM 流式返回两行改写,每行一个变体
		const llm = createMockLLM('使用什么技术栈\n项目用了哪些框架\n');
		const result = await rewriteQuery('项目技术栈是什么', { llm });

		// 关键路径:原始查询始终保留在首位,variant='original'
		expect(result).toHaveLength(3);
		expect(result[0]!.text).toBe('项目技术栈是什么');
		expect(result[0]!.variant).toBe('original');
		expect(result[1]!.text).toBe('使用什么技术栈');
		expect(result[1]!.variant).toBe('rewrite-1');
		expect(result[2]!.text).toBe('项目用了哪些框架');
		expect(result[2]!.variant).toBe('rewrite-2');
	});

	it('rewriteQuery - LLM 返回空 - 降级为只返回原始查询', async () => {
		// 关键路径:LLM 返回空字符串,无法解析出改写,降级
		const llm = createMockLLM('');
		const result = await rewriteQuery('问题', { llm });

		expect(result).toHaveLength(1);
		expect(result[0]!.text).toBe('问题');
		expect(result[0]!.variant).toBe('original');
	});

	it('rewriteQuery - LLM 抛错 - 降级为只返回原始查询', async () => {
		// 关键路径:LLM 异常不阻断主流程,降级为原始查询
		const llm = createMockLLMThrowing();
		const result = await rewriteQuery('问题', { llm });

		expect(result).toHaveLength(1);
		expect(result[0]!.variant).toBe('original');
	});

	it('rewriteQuery - 调用 LLM 时 maxTokens=100', async () => {
		// 关键路径:验证 maxTokens 限制,2 个改写 * ~50 tokens = 100
		const chatSpy = vi.fn();
		const llm: LLMClient = {
			async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
				chatSpy(req);
				yield { text: '变体1\n变体2\n' };
			},
			countTokens: () => 10,
		};
		await rewriteQuery('问题', { llm });
		expect(chatSpy).toHaveBeenCalledWith(expect.objectContaining({
			options: expect.objectContaining({ maxTokens: 100 }),
		}));
	});

	it('rewriteQuery - LLM 返回带编号 - 去除编号前缀', async () => {
		// 关键路径:LLM 可能返回 "1. 变体1\n2. 变体2",需去除编号前缀
		const llm = createMockLLM('1. 使用什么技术栈\n2. 项目用了哪些框架\n');
		const result = await rewriteQuery('技术栈', { llm });

		expect(result).toHaveLength(3);
		expect(result[1]!.text).toBe('使用什么技术栈');
		expect(result[2]!.text).toBe('项目用了哪些框架');
	});
});
```

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/core/query-rewriter.test.ts`
Expected: FAIL,`Cannot find module '../../src/core/query-rewriter'`

- [ ] **Step 3: 实现 query-rewriter.ts**

新建 `src/core/query-rewriter.ts`:

```typescript
/**
 * @file src/core/query-rewriter.ts
 * @description 查询改写器 — 用 LLM 把用户查询改写成 2 个语义变体,扩大检索召回
 * @module core/query-rewriter
 * @depends ports/llm
 */

import type { LLMClient, ChatMessage } from '../ports/llm';

/**
 * 改写后的查询项。
 * @param text - 查询文本(原始或改写后)。
 * @param variant - 来源标识:'original' = 用户原始查询;'rewrite-1' / 'rewrite-2' = LLM 改写。
 */
export interface RewrittenQuery {
	text: string;
	variant: 'original' | 'rewrite-1' | 'rewrite-2';
}

/**
 * 查询改写器依赖。
 */
export interface QueryRewriterDeps {
	llm: LLMClient;
}

/**
 * 改写提示词模板 — 要求 LLM 生成 2 个语义变体。
 *
 * 关键路径:
 * - 中英文混合,因 LLM 可能用任一语言回答。
 * - 要求每行一个变体,不加编号,便于解析。
 * - maxTokens=100,2 个改写 * ~50 tokens 足够。
 */
const REWRITE_PROMPT_TEMPLATE = (query: string): string =>
	`把以下查询改写成 2 个语义变体,用于知识库检索扩大召回。
要求:
- 保持原意,不改变问题范围
- 换用同义词或不同表述方式
- 每行一个变体,不加编号

原始查询:${query}

改写变体:`;

/**
 * 把用户查询改写成 2 个语义变体。
 *
 * 关键路径:
 * - 原始查询始终保留在结果首位(variant: 'original')。
 * - LLM 生成 1-2 个改写变体(variant: 'rewrite-1' / 'rewrite-2')。
 * - LLM 异常或返回空时降级为只返回原始查询,不阻断主流程。
 * - maxTokens=100,降低 token 成本。
 *
 * @param query - 用户原始查询。
 * @param deps - 依赖(LLM 客户端)。
 * @returns 包含原始查询 + 改写变体的数组;LLM 失败时只含原始查询。
 */
export async function rewriteQuery(
	query: string,
	deps: QueryRewriterDeps,
): Promise<RewrittenQuery[]> {
	// 关键路径:原始查询始终保留,即使 LLM 失败也能继续检索。
	const result: RewrittenQuery[] = [
		{ text: query, variant: 'original' },
	];

	try {
		const messages: ChatMessage[] = [
			{
				role: 'system',
				content: 'You are a query rewriting assistant. Generate 2 semantic variants of the user query for knowledge base retrieval. One variant per line, no numbering.',
			},
			{ role: 'user', content: REWRITE_PROMPT_TEMPLATE(query) },
		];

		let output = '';
		// 关键路径:maxTokens=100,2 个改写 * ~50 tokens。
		const stream = deps.llm.chat({ messages, options: { maxTokens: 100 } });
		for await (const delta of stream) {
			if (delta.text) output += delta.text;
		}

		// 关键路径:按行分割,去除编号前缀和空白行。
		const variants = output
			.split('\n')
			.map((line) => line.replace(/^\d+\.\s*/, '').trim())
			.filter((line) => line.length > 0)
			.slice(0, 2);

		variants.forEach((text, i) => {
			result.push({
				text,
				variant: i === 0 ? 'rewrite-1' : 'rewrite-2',
			});
		});
	} catch {
		// 关键路径:LLM 异常不阻断主流程,降级为只返回原始查询。
	}

	return result;
}
```

- [ ] **Step 4: 运行测试,验证通过**

Run: `npx vitest run tests/core/query-rewriter.test.ts`
Expected: PASS(5 个测试通过)

- [ ] **Step 5: 提交**

```bash
git add src/core/query-rewriter.ts tests/core/query-rewriter.test.ts
git commit -m "feat(w4): Query Rewriter — LLM 改写查询生成语义变体"
```

---

## Task 3: Reranker 端口 + 百炼实现 + 测试

**Files:**
- Create: `src/ports/reranker.ts`
- Create: `src/adapters/reranker-bailian.ts`
- Test: `tests/adapters/reranker-bailian.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/adapters/reranker-bailian.test.ts`:

```typescript
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
```

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/adapters/reranker-bailian.test.ts`
Expected: FAIL,`Cannot find module '../../src/adapters/reranker-bailian'`

- [ ] **Step 3: 实现 Reranker 端口**

新建 `src/ports/reranker.ts`:

```typescript
/**
 * @file src/ports/reranker.ts
 * @description Reranker 端口 — 精排能力的零实现接口契约
 * @module ports/reranker
 * @depends (无)
 */

/**
 * Reranker 统一接口。
 *
 * 实现位置:`src/adapters/reranker-bailian.ts`(百炼 DashScope)。
 *
 * 设计要点:
 * - 对查询 + 候选文档列表做精排,返回重新打分的结果。
 * - 文档全文由调用方(MultiQuerySearcher)读取后传入,端口不关心文件 IO。
 * - 返回结果按精排分数降序,数量不超过 topK。
 */
export interface RerankerPort {
	/**
	 * 对查询 + 候选文档列表做精排。
	 *
	 * @param query - 用户查询。
	 * @param documents - 候选文档列表(已读取全文)。
	 * @param topK - 返回数量上限。
	 * @returns 精排后的文档列表(id + 新分数),按分数降序。
	 */
	rerank(
		query: string,
		documents: Array<{ id: string; text: string }>,
		topK: number,
	): Promise<Array<{ id: string; score: number }>>;
}
```

- [ ] **Step 4: 实现百炼 Reranker 适配器**

新建 `src/adapters/reranker-bailian.ts`:

```typescript
/**
 * @file src/adapters/reranker-bailian.ts
 * @description 百炼 DashScope Reranker 适配器 — 调用 compatible-api/v1/rerank 端点
 * @module adapters/reranker-bailian
 * @depends ports/reranker
 */

import type { RerankerPort } from '../ports/reranker';

/**
 * 百炼 Reranker 构造选项。
 *
 * @param apiBase - DashScope API 基址,默认 https://dashscope.aliyuncs.com/compatible-api/v1。
 * @param apiKey - API Key(从 Obsidian 钥匙串 ratel-rerank-bailian 读取)。
 * @param model - Reranker 模型标识,默认 qwen3-rerank。
 */
export interface BailianRerankerOptions {
	apiBase: string;
	apiKey: string;
	model: string;
}

/**
 * 百炼 DashScope Reranker 适配器。
 *
 * 设计要点:
 * - 端点:`${apiBase}/rerank`(DashScope compatible-api)。
 * - 请求体:`{ model, query, documents: string[], top_n }`。
 * - 响应体:`{ results: [{ index, relevance_score }] }`,index 对应请求 documents 下标。
 * - HTTP 错误或网络异常向上抛错,由调用方(MultiQuerySearcher)决定降级策略。
 *
 * @example
 *   const reranker = new BailianReranker({
 *     apiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
 *     apiKey: 'sk-xxx',
 *     model: 'qwen3-rerank',
 *   });
 *   const ranked = await reranker.rerank('query', [{id:'a',text:'...'}], 5);
 */
export class BailianReranker implements RerankerPort {
	constructor(private options: BailianRerankerOptions) {}

	/**
	 * 调用百炼 API 对候选文档做精排。
	 *
	 * 关键路径:
	 * - 空文档列表直接返回空数组,不发请求。
	 * - 请求 documents 传文本数组(text),响应 index 对应回原始 id。
	 * - 响应 results 按 relevance_score 降序(百炼已排序),取 top_n。
	 *
	 * @param query - 用户查询。
	 * @param documents - 候选文档(id + 全文)。
	 * @param topK - 返回数量上限。
	 * @returns 精排结果(id + score),按 score 降序。
	 * @throws HTTP 非 2xx 时抛 `Bailian Rerank API error: <status>`;网络异常透传 fetch 错误。
	 */
	async rerank(
		query: string,
		documents: Array<{ id: string; text: string }>,
		topK: number,
	): Promise<Array<{ id: string; score: number }>> {
		// 关键路径:空列表不调 API,节省配额。
		if (documents.length === 0) return [];

		const url = `${this.options.apiBase}/rerank`;
		const body = JSON.stringify({
			model: this.options.model,
			query,
			documents: documents.map((d) => d.text),
			top_n: topK,
		});

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.options.apiKey}`,
				'Content-Type': 'application/json',
			},
			body,
		});

		if (!response.ok) {
			throw new Error(`Bailian Rerank API error: ${response.status}`);
		}

		const data = (await response.json()) as {
			results: Array<{ index: number; relevance_score: number }>;
		};

		// 关键路径:response.results 已按 relevance_score 降序,直接映射回 id。
		return data.results.map((r) => ({
			id: documents[r.index]!.id,
			score: r.relevance_score,
		}));
	}
}
```

- [ ] **Step 5: 运行测试,验证通过**

Run: `npx vitest run tests/adapters/reranker-bailian.test.ts`
Expected: PASS(5 个测试通过)

- [ ] **Step 6: 提交**

```bash
git add src/ports/reranker.ts src/adapters/reranker-bailian.ts tests/adapters/reranker-bailian.test.ts
git commit -m "feat(w4): Reranker 端口 + 百炼 DashScope 适配器"
```

---

## Task 4: MultiQuerySearcher + 测试

**Files:**
- Create: `src/core/multi-query-searcher.ts`
- Test: `tests/core/multi-query-searcher.test.ts`

依赖 Task 1(RRF)+ Task 2(QueryRewriter)+ Task 3(RerankerPort)+ W3(hybridSearch via Worker)。

- [ ] **Step 1: 写失败测试**

新建 `tests/core/multi-query-searcher.test.ts`:

```typescript
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
		const queryRewriter = createMockQueryRewriter(['变体1', '变体2']);

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
});
```

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/core/multi-query-searcher.test.ts`
Expected: FAIL,`Cannot find module '../../src/core/multi-query-searcher'`

- [ ] **Step 3: 实现 multi-query-searcher.ts**

新建 `src/core/multi-query-searcher.ts`:

```typescript
/**
 * @file src/core/multi-query-searcher.ts
 * @description 多查询搜索编排器 — 改写 + 多查询 + RRF + 可选 Rerank 精排
 * @module core/multi-query-searcher
 * @depends ports/embedding, ports/vector, ports/reranker, worker/manager, adapters/obsidian-vault, core/rrf
 */

import type { EmbeddingPort } from '../ports/embedding';
import type { VectorSearchResult } from '../ports/vector';
import type { RerankerPort } from '../ports/reranker';
import type { WorkerManager } from '../worker/manager';
import type { ObsidianVault } from '../adapters/obsidian-vault';
import { reciprocalRankFusion, type RankedItem } from './rrf';
import { devLogger } from '../logging/dev-logger';

/**
 * 多查询搜索器依赖。
 *
 * @param embedding - Embedding 端口,用于把每个查询变体编码为向量。
 * @param workerManager - Worker 管理器,用于发起 hybrid.search(W3 已实现)。
 * @param vault - Obsidian Vault 外观,供 Rerank 读取文档全文。
 * @param reranker - 可选 Reranker 端口;未注入时跳过精排。
 * @param queryRewriter - 可选查询改写器;未注入时只用原始查询。
 */
export interface MultiQuerySearcherDeps {
	embedding: EmbeddingPort;
	workerManager: WorkerManager;
	vault: ObsidianVault;
	reranker?: RerankerPort;
	queryRewriter?: { rewrite: (q: string) => Promise<string[]> };
}

/**
 * 多查询搜索编排器。
 *
 * 设计要点:
 * - 对 search_vault 工具与 LLM 透明:外部只调 search(query, topK),内部自动编排。
 * - 不调 search_vault 工具(避免循环 — search_vault 反过来调用本类)。
 * - 直接调 Worker 的 hybrid.search,绕过 search_vault 工具层。
 * - Reranker 异常时降级返回 RRF 结果,不阻断主流程。
 * - QueryRewriter 异常时降级为单查询,不阻断主流程。
 *
 * 关键路径(数据流):
 * 1. 若 queryRewriter 可用:改写查询 → [original, rewrite-1, rewrite-2]
 *    否则:只用 [original]
 * 2. 对每个查询:embedding.embed → workerManager.request(hybrid.search, topK*2)
 * 3. RRF 融合多份结果,取 topK
 * 4. 若 reranker 可用:vault.readFile 读全文 → reranker.rerank → 更新分数 + reranked=true
 *    否则:reranked=false
 *
 * @example
 *   const searcher = new MultiQuerySearcher({
 *     embedding, workerManager, vault,
 *     reranker: hasRerankApiKey(app) ? new BailianReranker({...}) : undefined,
 *     queryRewriter: { rewrite: (q) => rewriteQuery(q, {llm}).then(r => r.map(x => x.text)) },
 *   });
 *   const results = await searcher.search('技术栈', 5);
 */
export class MultiQuerySearcher {
	constructor(private deps: MultiQuerySearcherDeps) {}

	/**
	 * 多查询混合搜索 + RRF 融合 + 可选 Rerank 精排。
	 *
	 * @param query - 用户原始查询(单条,内部决定是否改写)。
	 * @param topK - 返回文档上限。
	 * @returns 文档级结果(含 index 由 search_vault 工具层填,本方法不填)。
	 */
	async search(query: string, topK: number): Promise<VectorSearchResult[]> {
		// --- Step 1: 查询改写(可选) ---
		let queryTexts: string[] = [query];
		if (this.deps.queryRewriter) {
			try {
				const variants = await this.deps.queryRewriter.rewrite(query);
				if (variants.length > 0) {
					queryTexts = variants;
				}
			} catch (err) {
				// 关键路径:改写失败降级为单查询,不阻断。
				devLogger.error('search', 'Query rewrite failed, falling back to single query', err);
			}
		}

		// --- Step 2: 多查询 hybrid.search ---
		// 关键路径:传 topK*2 过度抓取,补偿 RRF 融合时丢弃部分结果。
		const overFetchTopK = topK * 2;
		const allResults: VectorSearchResult[][] = [];
		const docIdToResult = new Map<string, VectorSearchResult>();

		for (const queryText of queryTexts) {
			const [queryVector] = await this.deps.embedding.embed([queryText]);
			const response = await this.deps.workerManager.request({
				type: 'hybrid.search',
				payload: { query: queryText, queryVector: queryVector!, topK: overFetchTopK },
			});

			if (response.type !== 'hybrid.search.result') {
				devLogger.warn('search', `Unexpected worker response: ${response.type}`);
				continue;
			}

			const results = response.payload;
			allResults.push(results);
			// 关键路径:记录 docId → 首次出现的完整结果(含 metadata),供 RRF 后映射回 VectorSearchResult。
			for (const r of results) {
				if (!docIdToResult.has(r.docId)) {
					docIdToResult.set(r.docId, r);
				}
			}
		}

		// --- Step 3: RRF 融合 ---
		const rankedLists: RankedItem[][] = allResults.map((list) =>
			list.map((r) => ({ id: r.docId, score: r.score })),
		);
		const fused = reciprocalRankFusion(rankedLists, 60, topK);

		// 关键路径:把融合后的 docId 映射回 VectorSearchResult,用 rrfScore 替换原 score。
		let finalResults: VectorSearchResult[] = fused.map((f) => {
			const original = docIdToResult.get(f.id);
			if (!original) {
				// 关键路径:理论上不会发生(docId 都来自 docIdToResult),兜底防御。
				return { docId: f.id, score: f.rrfScore, metadata: {} };
			}
			return { ...original, score: f.rrfScore };
		});

		// --- Step 4: 可选 Rerank 精排 ---
		if (this.deps.reranker && finalResults.length > 0) {
			try {
				// 关键路径:读取 topK 文档全文,传给 Reranker。
				// metadata.path 是 vault 相对路径(W3 VectraStore.hybridSearch 保证)。
				const documents: Array<{ id: string; text: string }> = [];
				for (const r of finalResults) {
					const path = r.metadata?.path;
					if (typeof path === 'string') {
						const text = await this.deps.vault.readFile(path);
						documents.push({ id: r.docId, text });
					}
				}

				if (documents.length > 0) {
					const reranked = await this.deps.reranker.rerank(query, documents, topK);
					// 关键路径:用 reranker 分数重新排序,丢弃 text(VectorSearchResult 不含 text)。
					const rerankedMap = new Map(reranked.map((r) => [r.id, r.score]));
					finalResults = finalResults
						.map((r) => ({
							...r,
							score: rerankedMap.get(r.docId) ?? r.score,
							reranked: true,
						}))
						.sort((a, b) => b.score - a.score)
						.slice(0, topK);
				}
			} catch (err) {
				// 关键路径:Reranker 失败降级返回 RRF 结果,reranked=false。
				devLogger.error('search', 'Rerank failed, falling back to RRF results', err);
				finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
			}
		} else {
			// 关键路径:无 reranker,reranked=false。
			finalResults = finalResults.map((r) => ({ ...r, reranked: false }));
		}

		return finalResults;
	}
}
```

- [ ] **Step 4: 运行测试,验证通过**

Run: `npx vitest run tests/core/multi-query-searcher.test.ts`
Expected: PASS(6 个测试通过)

- [ ] **Step 5: 提交**

```bash
git add src/core/multi-query-searcher.ts tests/core/multi-query-searcher.test.ts
git commit -m "feat(w4): MultiQuerySearcher — 改写 + 多查询 + RRF + 可选 Rerank"
```

---

## Task 5: VectorSearchResult.reranked + search_vault 工具升级 + 测试

**Files:**
- Modify: `src/ports/vector.ts`
- Modify: `src/tools/search-vault.ts`
- Test: `tests/tools/search-vault.test.ts`

- [ ] **Step 1: 修改 `src/ports/vector.ts` — VectorSearchResult 加可选 reranked**

在 `VectorSearchResult` 接口中,`index?: number` 字段之后追加(W3 已加 index,W4 追加 reranked):

```typescript
export interface VectorSearchResult {
	docId: string;
	/** 相似度分数(具体定义由实现决定,通常 0-1 区间或余弦距离)。 */
	score: number;
	/** 写入时传入的元数据(包含 path、chunkIndex 等)。 */
	metadata: Record<string, unknown>;
	/**
	 * 引用编号,从 1 开始(W3 新增)。
	 * search_vault 工具返回时填充,供 LLM 用 [1][2] 引用;
	 * VectraStore.hybridSearch / Worker 协议层不填(默认 undefined)。
	 */
	index?: number;
	/**
	 * 是否经过 Rerank 精排(W4 新增)。
	 * MultiQuerySearcher 填充:true = 经 Reranker 精排;false = 仅 RRF 融合。
	 * VectraStore.hybridSearch / Worker 协议层不填(默认 undefined)。
	 */
	reranked?: boolean;
}
```

- [ ] **Step 2: 写失败测试 — search_vault 调 MultiQuerySearcher**

把 `tests/tools/search-vault.test.ts` 整体替换为(签名从 `(embedding, worker, getSearchReady)` 改为 `(multiQuerySearcher, getSearchReady)`):

```typescript
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
```

- [ ] **Step 3: 运行测试,验证失败**

Run: `npx vitest run tests/tools/search-vault.test.ts`
Expected: FAIL(`createSearchVaultTool` 签名仍是 W3 的 `(embedding, workerManager, getSearchReady)`)

- [ ] **Step 4: 改 search-vault.ts — 签名改为接收 MultiQuerySearcher**

把 `src/tools/search-vault.ts` 整体替换为:

```typescript
/**
 * @file src/tools/search-vault.ts
 * @description `search_vault` 工具 — 在知识库中做多查询混合搜索 + RRF + 可选 Rerank,返回带 index + reranked 的结果
 * @module tools/search-vault
 * @depends core/tool-registry, core/multi-query-searcher
 */

import type { Tool } from '../core/tool-registry';
import type { MultiQuerySearcher } from '../core/multi-query-searcher';

// 默认返回结果数,与 JSON schema 中的 default 保持一致。
const DEFAULT_TOP_K = 5;

/**
 * 构造 `search_vault` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 内部调用 MultiQuerySearcher.search,对 LLM 透明(改写 + 多查询 + RRF + Rerank 均在内部)。
 * - 只返回 docId + score + metadata + index + reranked,不返回 chunk 原文,让模型自主用 read_note 读取。
 *
 * @param searcher - MultiQuerySearcher 实例,编排多查询 + RRF + Rerank。
 * @param getSearchReady - 检索就绪检查;未就绪时抛 INDEX_NOT_READY。
 * @returns 符合 `Tool` 接口的工具定义。
 */
export function createSearchVaultTool(
	searcher: MultiQuerySearcher,
	getSearchReady: () => boolean,
): Tool {
	return {
		definition: {
			name: 'search_vault',
			description: 'Search the vault for notes relevant to a query. Uses multi-query hybrid search (vector + BM25) with RRF fusion and optional reranking. Returns ranked results with index numbers for citation. Use read_note to fetch full content of promising results.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query (e.g. "project tech stack")',
					},
					topK: {
						type: 'number',
						description: `Maximum number of results to return (default: ${DEFAULT_TOP_K})`,
						default: DEFAULT_TOP_K,
					},
				},
				required: ['query'],
			},
		},
		readOnly: true,
		async execute(args: Record<string, unknown>) {
			if (!getSearchReady()) {
				const err = new Error('索引或 Embedding 尚未就绪,请稍候或在设置 → 诊断测试中检查');
				(err as Error & { code?: string }).code = 'INDEX_NOT_READY';
				throw err;
			}
			if (typeof args.query !== 'string' || args.query.length === 0) {
				throw new Error('search_vault 参数 query 必须是有效字符串');
			}
			const query = args.query;
			const topK = typeof args.topK === 'number' ? args.topK : DEFAULT_TOP_K;

			// 关键路径:MultiQuerySearcher 内部编排改写 + 多查询 + RRF + 可选 Rerank。
			// 对 LLM 透明:LLM 仍用 search_vault({query, topK}) 调用。
			const results = await searcher.search(query, topK);

			// 关键路径:加 index 编号(从 1 开始),供 LLM 用 [1][2] 引用。
			// reranked 由 MultiQuerySearcher 填充,这里透传不覆盖。
			return results.map((r, i) => ({
				...r,
				index: i + 1,
			}));
		},
	};
}
```

- [ ] **Step 5: 运行测试,验证通过**

Run: `npx vitest run tests/tools/search-vault.test.ts`
Expected: PASS(6 个测试通过)

- [ ] **Step 6: 提交**

```bash
git add src/ports/vector.ts src/tools/search-vault.ts tests/tools/search-vault.test.ts
git commit -m "feat(w4): search_vault 改调 MultiQuerySearcher + VectorSearchResult.reranked"
```

---

## Task 6: types.ts + Agent Loop search.result reranked + 测试

**Files:**
- Modify: `src/types.ts`
- Modify: `src/core/agent-loop.ts`
- Test: `tests/core/agent-loop.test.ts`

- [ ] **Step 1: 修改 `src/types.ts` — search.result payload 加 reranked**

在 `AgentEvent` 联合类型中,把 W3 已加的 `search.result` 成员的 payload 扩展 `reranked: boolean` 字段:

```typescript
	| {
			type: 'search.result';
			payload: {
				results: Array<{
					docId: string;
					score: number;
					path: string;
					index: number;
				}>;
				// 关键路径:W4 新增 — 标识是否经过 Rerank 精排,供 ChatView 显示标记。
				reranked: boolean;
			};
	  }
```

- [ ] **Step 2: 写失败测试 — agent-loop 发 search.result 时带 reranked 字段**

在 `tests/core/agent-loop.test.ts` 末尾追加(假设 W3 已加 search.result 测试,W4 在此基础上加 reranked 断言):

```typescript
	// ==================== W4: search.result reranked 字段 ====================

	it('agentLoop - search_vault 结果含 reranked=true - search.result 事件带 reranked=true', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'search_vault',
			args: { query: '技术栈', topK: 3 },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: '根据 [1] 的内容...' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'search_vault', description: 'search', parameters: {} },
			readOnly: true,
			execute: async () => [
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1, reranked: true },
			],
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: '查技术栈' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		// 关键路径:search.result 事件 payload 含 reranked=true
		const searchResultEvent = events.find((e) => e.type === 'search.result');
		expect(searchResultEvent).toBeDefined();
		if (searchResultEvent?.type === 'search.result') {
			expect(searchResultEvent.payload.reranked).toBe(true);
		}
	});

	it('agentLoop - search_vault 结果 reranked=false - search.result 事件带 reranked=false', async () => {
		// 关键路径:无 Reranker 时 reranked=false,ChatView 不显示精排标记
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'search_vault',
			args: { query: '技术栈' },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: '结果' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'search_vault', description: 'search', parameters: {} },
			readOnly: true,
			execute: async () => [
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1, reranked: false },
			],
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: '查' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		const searchResultEvent = events.find((e) => e.type === 'search.result');
		if (searchResultEvent?.type === 'search.result') {
			expect(searchResultEvent.payload.reranked).toBe(false);
		}
	});

	it('agentLoop - search_vault 结果无 reranked 字段 - search.result 降级 reranked=false', async () => {
		// 关键路径:W3 旧 mock 不带 reranked 字段,W4 agent-loop 应降级为 false
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);

		const toolCall: ToolCall = {
			id: 'call_1',
			name: 'search_vault',
			args: { query: '技术栈' },
		};

		const llm = createMockLLM([
			[{ text: '', toolCall }],
			[{ text: '结果' }],
		]);

		const tools = new ToolRegistry();
		tools.register({
			definition: { name: 'search_vault', description: 'search', parameters: {} },
			readOnly: true,
			execute: async () => [
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1 },
			],
		});

		const hooks = new HookRegistry();
		const events: AgentEvent[] = [];

		for await (const event of agentLoop(
			{ sessionId: 's1', message: '查' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		const searchResultEvent = events.find((e) => e.type === 'search.result');
		if (searchResultEvent?.type === 'search.result') {
			// 关键路径:无 reranked 字段时降级为 false
			expect(searchResultEvent.payload.reranked).toBe(false);
		}
	});
```

- [ ] **Step 3: 运行测试,验证失败**

Run: `npx vitest run tests/core/agent-loop.test.ts`
Expected: FAIL(`search.result` payload 不含 `reranked` 字段)

- [ ] **Step 4: 改 agent-loop.ts — search.result 事件加 reranked**

在 `src/core/agent-loop.ts` 中,把 W3 已实现的 search.result 事件发射代码改为(从结果中推断 reranked):

找到这段代码(W3 实现):
```typescript
			if (toolCall.name === 'search_vault' && Array.isArray(result)) {
				const searchResults = (result as Array<{...}>)
					.filter(...)
					.map((r) => ({...}));
				if (searchResults.length > 0) {
					yield {
						type: 'search.result',
						payload: { results: searchResults },
					};
				}
			}
```

替换为:

```typescript
			// 关键路径:search_vault 返回后发 search.result 事件(payload 用扁平结构 + reranked 标记)。
			// reranked 从结果中推断:任一结果带 reranked=true 即视为已重排(W4)。
			if (toolCall.name === 'search_vault' && Array.isArray(result)) {
				const rawResults = result as Array<{
					docId: string;
					score: number;
					metadata: { path?: string };
					index: number;
					reranked?: boolean;
				}>;
				const searchResults = rawResults
					.filter((r) => r.metadata && typeof r.metadata.path === 'string')
					.map((r) => ({
						docId: r.docId,
						score: r.score,
						path: r.metadata.path as string,
						index: r.index,
					}));
				// 关键路径:从结果推断是否经过 Rerank;无 reranked 字段时降级 false(W3 旧 mock 兼容)。
				const reranked = rawResults.some((r) => r.reranked === true);
				if (searchResults.length > 0) {
					yield {
						type: 'search.result',
						payload: { results: searchResults, reranked },
					};
				}
			}
```

- [ ] **Step 5: 运行测试,验证通过**

Run: `npx vitest run tests/core/agent-loop.test.ts`
Expected: PASS(W3 既有测试 + W4 新增 3 个测试全部通过)

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/core/agent-loop.ts tests/core/agent-loop.test.ts
git commit -m "feat(w4): search.result 事件加 reranked 字段 — agent-loop 从结果推断"
```

---

## Task 7: ChatView reranked 标记

**Files:**
- Modify: `src/ui/ChatView.svelte`

UI 改动无单测(Svelte 5 组件单测本项目未建立),靠 build + 手动 E2E 验证。

- [ ] **Step 1: Message 接口加 reranked 字段**

在 `src/ui/ChatView.svelte` 的 `interface Message` 中,把 W3 已加的 `searchResults?` 字段扩展为含 `reranked`:

找到(W3 已实现):
```typescript
	searchResults?: Array<{
		docId: string;
		score: number;
		path: string;
		index: number;
	}>;
```

替换为:
```typescript
	searchResults?: Array<{
		docId: string;
		score: number;
		path: string;
		index: number;
	}>;
	// 关键路径:W4 新增 — 标识搜索结果是否经过 Rerank 精排,供卡片显示标记。
	searchReranked?: boolean;
```

- [ ] **Step 2: sendMessage 事件循环更新 search.result case**

在 `for await (const event of events)` 的 switch 中,把 W3 的 `search.result` case 改为:

找到(W3 已实现):
```typescript
				case 'search.result':
					assistantMsg.searchResults = event.payload.results;
					messages = [...messages];
					break;
```

替换为:
```typescript
				case 'search.result':
					assistantMsg.searchResults = event.payload.results;
					assistantMsg.searchReranked = event.payload.reranked;
					messages = [...messages];
					break;
```

- [ ] **Step 3: 模板加 reranked 标记**

找到 W3 已实现的搜索结果卡片头部:
```svelte
				<div class="ratel-search-header">🔍 搜索结果</div>
```

替换为:
```svelte
				<div class="ratel-search-header">
					🔍 搜索结果
					{#if msg.searchReranked}
						<span class="ratel-search-reranked" title="结果经过 Reranker 精排">✨ 精排</span>
					{/if}
				</div>
```

- [ ] **Step 4: 样式追加**

在 `<style>` 块末尾(`</style>` 之前)追加:

```css
	.ratel-search-reranked {
		margin-left: 6px;
		padding: 1px 6px;
		border-radius: 3px;
		background: var(--interactive-accent);
		color: var(--text-on-accent);
		font-size: 0.75em;
		font-weight: 600;
	}
```

- [ ] **Step 5: 验证 build 通过**

Run: `npm run build`
Expected: 0 errors(Svelte 5 编译通过)

- [ ] **Step 6: 提交**

```bash
git add src/ui/ChatView.svelte
git commit -m "feat(w4): ChatView 搜索结果卡片显示 Rerank 精排标记"
```

---

## Task 8: Indexer subagent + 测试

**Files:**
- Create: `src/subagents/indexer.ts`
- Test: `tests/subagents/indexer.test.ts`

Indexer subagent 与检索增强正交,可独立实现。

- [ ] **Step 1: 写失败测试**

新建 `tests/subagents/indexer.test.ts`:

```typescript
/**
 * @file tests/subagents/indexer.test.ts
 * @description Indexer subagent 单元测试
 * @module tests/subagents/indexer
 */

import { describe, it, expect, vi } from 'vitest';
import { Indexer } from '../../src/subagents/indexer';
import type { ObsidianVault } from '../../src/adapters/obsidian-vault';
import type { IndexController } from '../../src/core/index-controller';

function createMockVault(): ObsidianVault {
	return {
		readFile: vi.fn(async (path: string) => `content-of-${path}`),
		listMarkdownFiles: vi.fn(() => ['a.md', 'b.md']),
	} as unknown as ObsidianVault;
}

function createMockIndexController(): IndexController {
	return {
		reindex: vi.fn().mockResolvedValue(undefined),
		indexManager: {
			enqueue: vi.fn(),
		},
	} as unknown as IndexController;
}

describe('Indexer', () => {
	it('fullReindex - 调用 indexController.reindex', async () => {
		const vault = createMockVault();
		const indexController = createMockIndexController();
		const indexer = new Indexer({ vault, indexController });

		const result = await indexer.fullReindex();

		// 关键路径:委托给 indexController.reindex,后者走全量重建
		expect(indexController.reindex).toHaveBeenCalledTimes(1);
		expect(result.indexed).toBeGreaterThan(0);
	});

	it('indexFile - 读取文件内容 + enqueue upsert', async () => {
		const vault = createMockVault();
		const indexController = createMockIndexController();
		const indexer = new Indexer({ vault, indexController });

		await indexer.indexFile('notes/foo.md');

		// 关键路径:先读文件全文,再 enqueue 到 IndexManager
		expect(vault.readFile).toHaveBeenCalledWith('notes/foo.md');
		expect(indexController.indexManager.enqueue).toHaveBeenCalledWith(
			'notes/foo.md',
			'upsert',
			'content-of-notes/foo.md',
		);
	});

	it('indexFile - 文件不存在 - readFile 抛错透传', async () => {
		const vault = {
			readFile: vi.fn().mockRejectedValue(new Error('File not found: missing.md')),
		} as unknown as ObsidianVault;
		const indexController = createMockIndexController();
		const indexer = new Indexer({ vault, indexController });

		// 关键路径:readFile 失败时透传错误,让调用方决定处理方式
		await expect(indexer.indexFile('missing.md')).rejects.toThrow('File not found: missing.md');
		expect(indexController.indexManager.enqueue).not.toHaveBeenCalled();
	});

	it('deleteFile - enqueue delete(不读文件)', async () => {
		const vault = createMockVault();
		const indexController = createMockIndexController();
		const indexer = new Indexer({ vault, indexController });

		await indexer.deleteFile('notes/gone.md');

		// 关键路径:删除不需要读文件内容,直接 enqueue delete
		expect(vault.readFile).not.toHaveBeenCalled();
		expect(indexController.indexManager.enqueue).toHaveBeenCalledWith(
			'notes/gone.md',
			'delete',
		);
	});
});
```

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/subagents/indexer.test.ts`
Expected: FAIL,`Cannot find module '../../src/subagents/indexer'`

- [ ] **Step 3: 实现 indexer.ts**

新建 `src/subagents/indexer.ts`:

```typescript
/**
 * @file src/subagents/indexer.ts
 * @description Indexer subagent — 封装 IndexController,供其他子代理通过统一接口触发索引操作
 * @module subagents/indexer
 * @depends adapters/obsidian-vault, core/index-controller
 */

import type { ObsidianVault } from '../adapters/obsidian-vault';
import type { IndexController } from '../core/index-controller';

/**
 * Indexer subagent 依赖。
 */
export interface IndexerDeps {
	vault: ObsidianVault;
	indexController: IndexController;
}

/**
 * Indexer subagent — 索引操作子代理。
 *
 * 设计要点:
 * - 封装 IndexController,让其他子代理(如 Librarian)能通过统一接口触发索引操作,
 *   不直接调 IndexController(降低耦合)。
 * - 全量重建委托给 `indexController.reindex`(后者走 IndexManager.onLayoutReady → backend.fullReindex)。
 * - 增量索引先读文件全文,再 enqueue 到 IndexManager(去抖 + 批处理由 IndexController 内部处理)。
 * - 删除文件不读内容,直接 enqueue delete。
 *
 * @example
 *   const indexer = new Indexer({ vault, indexController });
 *   await indexer.fullReindex();
 *   await indexer.indexFile('notes/new.md');
 *   await indexer.deleteFile('notes/gone.md');
 */
export class Indexer {
	constructor(private deps: IndexerDeps) {}

	/**
	 * 全量重建索引 — 遍历 vault 所有 markdown 文件,送 Worker 索引。
	 *
	 * 关键路径:委托给 `indexController.reindex`,后者清队列 + 走全量。
	 *
	 * @returns 索引统计(indexed 为文件数;当前实现通过 vault.listMarkdownFiles 推断)。
	 */
	async fullReindex(): Promise<{ indexed: number; errors: number }> {
		await this.deps.indexController.reindex();
		// 关键路径:reindex 不返回统计,这里用 vault 文件数近似(实际索引数由 Worker 返回,subagent 层不深究)。
		const totalFiles = this.deps.vault.listMarkdownFiles().length;
		return { indexed: totalFiles, errors: 0 };
	}

	/**
	 * 增量索引 — 单文件变更后送 Worker。
	 *
	 * 关键路径:先读文件全文,再 enqueue 'upsert'。IndexController 内部去抖 + 批处理。
	 *
	 * @param path - vault 相对路径。
	 * @throws 文件不存在时 readFile 抛错,透传给调用方。
	 */
	async indexFile(path: string): Promise<void> {
		const content = await this.deps.vault.readFile(path);
		this.deps.indexController.indexManager.enqueue(path, 'upsert', content);
	}

	/**
	 * 删除文件的所有 chunk。
	 *
	 * 关键路径:不读文件内容,直接 enqueue 'delete'。
	 *
	 * @param path - vault 相对路径。
	 */
	async deleteFile(path: string): Promise<void> {
		this.deps.indexController.indexManager.enqueue(path, 'delete');
	}
}
```

- [ ] **Step 4: 运行测试,验证通过**

Run: `npx vitest run tests/subagents/indexer.test.ts`
Expected: PASS(4 个测试通过)

- [ ] **Step 5: 提交**

```bash
git add src/subagents/indexer.ts tests/subagents/indexer.test.ts
git commit -m "feat(w4): Indexer subagent — 封装 IndexController 供子代理调用"
```

---

## Task 9: main.ts 接线 + 集成验证

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: 改 main.ts — 注入 MultiQuerySearcher 到 search_vault 工具**

在 `src/main.ts` 顶部 import 区追加:

```typescript
import { MultiQuerySearcher } from './core/multi-query-searcher';
import { rewriteQuery } from './core/query-rewriter';
import { BailianReranker } from './adapters/reranker-bailian';
import { hasRerankApiKey, resolveRerankApiKey } from './secrets/ratel-secrets';
import { Indexer } from './subagents/indexer';
```

> **注意:** `hasRerankApiKey` / `resolveRerankApiKey` 已在 `src/secrets/ratel-secrets.ts` 实现(S-KEYCHAIN),直接 import 即可。若 `resolveRerankApiKey` 未在现有 import 中,追加到 import 列表。

在 `src/main.ts` 中找到 W3 的工具注册段(约 168-175 行):

```typescript
		// ==================== 工具与钩子 ====================
		this.tools = new ToolRegistry();
		this.tools.register(createReadNoteTool(this.vault));
		this.tools.register(
			createSearchVaultTool(this.embedding, this.workerManager, () =>
				isSearchReady(get(this.userStatus.statusBar$)),
			),
		);
```

替换为:

```typescript
		// ==================== 工具与钩子 ====================
		this.tools = new ToolRegistry();
		this.tools.register(createReadNoteTool(this.vault));

		// 关键路径:W4 — 构造 MultiQuerySearcher,编排改写 + 多查询 + RRF + 可选 Rerank。
		// Reranker 仅在钥匙串有 ratel-rerank-bailian 密钥时注入;无密钥自动降级为仅 RRF。
		const reranker = hasRerankApiKey(this.app)
			? new BailianReranker({
					apiBase: this.settings.rerankerApiBase,
					apiKey: resolveRerankApiKey(this.app) ?? '',
					model: this.settings.rerankerModel,
				})
			: undefined;

		// 关键路径:QueryRewriter 闭包捕获 this.llm,把 rewriteQuery 的 RewrittenQuery[] 适配为 string[]。
		const queryRewriter = {
			rewrite: async (q: string) => {
				const rewritten = await rewriteQuery(q, { llm: this.llm });
				return rewritten.map((r) => r.text);
			},
		};

		const multiQuerySearcher = new MultiQuerySearcher({
			embedding: this.embedding,
			workerManager: this.workerManager,
			vault: this.vault,
			reranker,
			queryRewriter,
		});

		this.tools.register(
			createSearchVaultTool(multiQuerySearcher, () =>
				isSearchReady(get(this.userStatus.statusBar$)),
			),
		);
```

在 `src/main.ts` 中 `this.indexController` 初始化之后(约 166 行后)追加 Indexer subagent 实例化:

```typescript
		// 关键路径:W4 — Indexer subagent,供其他子代理通过统一接口触发索引。
		this.indexer = new Indexer({ vault: this.vault, indexController: this.indexController });
```

在 `RatelVaultPlugin` 类的字段声明区(约 60-70 行)追加:

```typescript
	// 关键路径:W4 — Indexer subagent 实例,供 Librarian 等子代理调用。
	indexer!: Indexer;
```

- [ ] **Step 2: 运行全量测试**

Run: `npm test`
Expected: 全部测试通过(W3 既有 + W4 新增约 30 个)

- [ ] **Step 3: 运行 build**

Run: `npm run build`
Expected: 0 errors,`dist/main.js` 与 `dist/worker.js` 生成成功

- [ ] **Step 4: 运行 lint**

Run: `npm run lint`
Expected: 0 errors

- [ ] **Step 5: 提交**

```bash
git add src/main.ts
git commit -m "feat(w4): main.ts 注入 MultiQuerySearcher + Indexer subagent"
```

- [ ] **Step 6: 手动 E2E 验证(用户操作)**

在 Obsidian 中重载插件,验证:

1. **无 Rerank 密钥场景**:
   - 发送 "我的笔记里有什么关于 X 的内容?"
   - LLM 调 search_vault,ChatView 卡片显示"🔍 搜索结果"(无 ✨ 精排标记)
   - reranked=false

2. **有 Rerank 密钥场景**(用户在 Obsidian 钥匙串配置 `ratel-rerank-bailian`):
   - 发送同样查询
   - ChatView 卡片显示"🔍 搜索结果 ✨ 精排"
   - reranked=true
   - 结果顺序比无 Rerank 时更准

3. **Query Rewrite 生效**:
   - 查询"技术栈"时,MultiQuerySearcher 内部生成 2 个变体
   - 多查询结果经 RRF 融合,召回比 W3 单查询更广

4. **降级路径**:
   - 断开网络(模拟 Reranker API 不可达)→ search_vault 仍返回结果(reranked=false,降级 RRF)
   - LLM 不可达(Query Rewrite 失败)→ 降级单查询,仍返回结果

---

## Self-Review

### 1. Spec 覆盖检查

| Spec 章节 | 覆盖 Task |
|----------|----------|
| §4.1 Query Rewrite | Task 2(query-rewriter.ts)|
| §4.2 RRF 多查询融合 | Task 1(rrf.ts)+ Task 4(MultiQuerySearcher 用 RRF)|
| §4.3 多查询搜索编排(MultiQuerySearcher) | Task 4 |
| §4.3 search_vault 工具升级(方案 A) | Task 5(签名不变,内部改调 MultiQuerySearcher)|
| §4.4 Reranker 端口 + 百炼实现 | Task 3 |
| §4.4 启用条件(hasRerankApiKey) | Task 9(main.ts 用 hasRerankApiKey 判断注入)|
| §4.5 Indexer subagent | Task 8 |
| §4.6 数据流(W4 完整) | Task 4(MultiQuerySearcher)+ Task 5(search_vault)+ Task 6(search.result reranked)+ Task 9(main.ts 接线)|
| §5.1 新建文件(6 个 + 测试) | Task 1/2/3/4/8 全部覆盖 |
| §5.2 修改文件(search_vault / main.ts / settings) | Task 5(search_vault)+ Task 9(main.ts);settings.ts 的 Rerank 说明已在 S-KEYCHAIN Minor 修复,本 plan 不重复改 |
| §5.3 与 W3 衔接(search_vault 透明升级 / search.result reranked / VectorSearchResult 不扩展 text) | Task 5(签名不变)+ Task 6(reranked 字段)+ Task 4(Reranker 读全文后丢弃 text,不进 VectorSearchResult)|
| §6 测试策略(6 个测试文件) | Task 1/2/3/4/8(5 个新测试文件)+ Task 6(agent-loop 测试)— 全部覆盖 |
| §7 性能(Query Rewrite maxTokens=100 / 多查询 topK*2 过度抓取 / Reranker 可选降级) | Task 2(maxTokens=100)+ Task 4(topK*2)+ Task 4(reranker 异常降级)|
| §8 安全与隐私(Reranker key 走钥匙串 / 库内容只发配置端点) | Task 9(resolveRerankApiKey 从钥匙串读)|

无遗漏。

### 2. Placeholder 扫描

- 无 TBD / TODO / "implement later"
- 每个 Step 含完整代码或完整命令
- 测试代码完整,可直接运行
- 无 "类似 Task N" 引用(每个 Task 自包含)
- 无 "add appropriate error handling" 等模糊描述

### 3. 类型一致性

- `RankedItem = { id: string; score: number }`:Task 1 定义,Task 4 MultiQuerySearcher 用 `list.map((r) => ({ id: r.docId, score: r.score }))` 构造 — 一致
- `FusedItem = { id: string; rrfScore: number; sourceScores: (number|undefined)[] }`:Task 1 定义,Task 4 用 `fused.map((f) => ...)` 消费 — 一致
- `RewrittenQuery = { text: string; variant: 'original'|'rewrite-1'|'rewrite-2' }`:Task 2 定义,Task 9 main.ts 用 `rewritten.map((r) => r.text)` 适配为 string[] — 一致
- `RerankerPort.rerank(query, documents, topK)`:Task 3 定义,Task 4 MultiQuerySearcher 调 `this.deps.reranker.rerank(query, documents, topK)` — 一致
- `MultiQuerySearcherDeps`:Task 4 定义 `{ embedding, workerManager, vault, reranker?, queryRewriter? }`,Task 9 main.ts 构造时传入全部字段 — 一致
- `VectorSearchResult.reranked?: boolean`:Task 5 定义,Task 4 MultiQuerySearcher 填充(true/false),Task 6 agent-loop 读取 — 一致
- `search.result` payload `reranked: boolean`:Task 6 types.ts 定义,Task 6 agent-loop 发事件时填充,Task 7 ChatView 读取 — 一致
- `MultiQuerySearcher.search(query, topK): Promise<VectorSearchResult[]>`:Task 4 定义,Task 5 search_vault 调 `searcher.search(query, topK)` — 一致
- `createSearchVaultTool(searcher, getSearchReady)`:Task 5 定义新签名,Task 9 main.ts 用 `createSearchVaultTool(multiQuerySearcher, ...)` — 一致
- `IndexerDeps = { vault, indexController }`:Task 8 定义,Task 9 main.ts 用 `new Indexer({ vault: this.vault, indexController: this.indexController })` — 一致

### 4. 范围检查

W4 plan 范围与 S-W4-RAG-ENHANCEMENT spec 完全对齐:

- Query Rewrite ✅(Task 2)
- RRF 多查询融合 ✅(Task 1 + Task 4)
- Reranker 百炼适配器 ✅(Task 3 + Task 9)
- MultiQuerySearcher 编排 ✅(Task 4)
- search_vault 透明升级 ✅(Task 5)
- search.result reranked 字段 ✅(Task 6 + Task 7)
- Indexer subagent ✅(Task 8)
- main.ts 接线 ✅(Task 9)

非目标(明确不做):
- 混合搜索(W3 已实现)— 本 plan 不重复
- 意图分类器(W3 已实现)— 本 plan 不重复
- 跨语言检索 / 多模态检索 — spec §3 已说明推迟

---

## 执行选择

Plan complete and saved to `docs/superpowers/plans/2026-06-26-ratel-w4-rag-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
