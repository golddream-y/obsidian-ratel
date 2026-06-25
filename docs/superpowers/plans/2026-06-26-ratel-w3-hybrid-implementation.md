# W3 混合搜索 + 意图分类 + 引用 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 vectra 内置混合搜索(向量 + BM25)、轻量意图分类器、动态系统提示词、引用编号与 search.result 事件 + ChatView 卡片,完成 S-W3-HYBRID spec 全部目标。

**Architecture:** search_vault 工具改调 Worker 的 `hybrid.search`(vectra `queryItems` 传 `isBm25=true`);Agent Loop 在 `addUserMessage` 后用一次 maxTokens=5 的 LLM 调用判断意图('rag' | 'direct'),按意图选择 BASE_PROMPT 或 RAG_PROMPT;search_vault 返回带 `index` 编号的结果,Agent Loop 在工具返回后发 `search.result` 事件,ChatView 渲染搜索结果卡片。

**Tech Stack:** TypeScript(strict)、vectra(`queryItems` 第 5 参数 `isBm25`)、vitest、Svelte 5。

**所属 Spec:** [S-W3-HYBRID](../specs/2026-06-26-ratel-w3-hybrid-search-design.md)
**取代:** [P-W3-IMPL](2026-06-13-ratel-w3-implementation.md)(已标 Superseded)

---

## 文件结构

### 新建

| 文件 | 职责 |
|------|------|
| `src/core/intent-classifier.ts` | 轻量意图分类器(一次 LLM 调用判断 'rag' \| 'direct') |
| `tests/core/intent-classifier.test.ts` | 意图分类器单元测试 |

### 修改

| 文件 | 改动 |
|------|------|
| `src/types.ts` | WorkerRequest 加 `hybrid.search`;WorkerResponse 加 `hybrid.search.result`;AgentEvent 加 `search.result` |
| `src/ports/vector.ts` | `VectorSearchResult` 加可选 `index?: number` 字段 |
| `src/adapters/vector-vectra.ts` | 新增 `hybridSearch(query, queryVector, topK)` 方法 |
| `src/worker/index-processor.ts` | 新增 `hybridSearch(query, queryVector, topK)` 方法 |
| `src/worker/handler.ts` | 新增 `hybrid.search` case |
| `src/tools/search-vault.ts` | 改调 `hybrid.search`,返回值加 `index` 字段(从 1 开始),更新 description |
| `src/core/context-manager.ts` | 新增 `BASE_PROMPT` / `RAG_PROMPT`;`toMessages(intent?)` 按意图选提示词 |
| `src/core/agent-loop.ts` | 接入意图分类器(可选参数);search_vault 返回后发 `search.result` 事件 |
| `src/ui/ChatView.svelte` | Message 接口加 `searchResults?` 字段;新增搜索结果卡片渲染 |
| `src/main.ts` | `ask()` 注入 `intentClassifier` 到 agentLoop |
| `tests/adapters/vector-vectra.test.ts` | 加 `hybridSearch` 测试 |
| `tests/worker/handler.test.ts`(或 `index-processor.test.ts`) | 加 `hybrid.search` case 测试 |
| `tests/tools/search-vault.test.ts` | 改 mock 为 `hybrid.search.result`,断言 `index` 从 1 开始 |
| `tests/core/context-manager.test.ts` | 加 `toMessages('rag')` / `toMessages('direct')` 测试 |
| `tests/core/agent-loop.test.ts` | 加意图分类 + search.result 事件测试 |

---

## Task 1: 类型层扩展(types.ts + ports/vector.ts)

**Files:**
- Modify: `src/types.ts`
- Modify: `src/ports/vector.ts`

类型层先行,后续任务的代码可立即引用新类型。

- [ ] **Step 1: 修改 `src/types.ts` — WorkerRequest 加 hybrid.search**

在 `WorkerRequest` 联合类型中,`vector.search` 行之后插入:

```typescript
	| { type: 'hybrid.search'; payload: { query: string; queryVector: number[]; topK: number } }
```

在 `WorkerResponse` 联合类型中,`vector.search.result` 行之后插入:

```typescript
	| { type: 'hybrid.search.result'; payload: Array<import('./ports/vector').VectorSearchResult> }
```

在 `AgentEvent` 联合类型中,`tool.result` 行之后插入:

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
			};
	  }
```

- [ ] **Step 2: 修改 `src/ports/vector.ts` — VectorSearchResult 加可选 index**

把 `VectorSearchResult` 接口改为:

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
}
```

- [ ] **Step 3: 验证类型层编译通过**

Run: `npm run build`
Expected: 0 errors(类型扩展不破坏现有代码,`index` 可选 + 新增联合成员)

- [ ] **Step 4: 提交**

```bash
git add src/types.ts src/ports/vector.ts
git commit -m "feat(w3): 扩展类型层 — hybrid.search 协议 + search.result 事件 + VectorSearchResult.index"
```

---

## Task 2: VectraStore.hybridSearch + 测试

**Files:**
- Modify: `src/adapters/vector-vectra.ts`
- Test: `tests/adapters/vector-vectra.test.ts`

- [ ] **Step 1: 读现有 vector-vectra.test.ts,了解 mock 模式**

Run: `cat tests/adapters/vector-vectra.test.ts | head -60`
(目的是看 mock LocalDocumentIndex 的写法;若不存在用现有 search 测试作为参考)

- [ ] **Step 2: 写失败测试 — hybridSearch 调 queryItems 传 isBm25=true 且 query 非空**

在 `tests/adapters/vector-vectra.test.ts` 文件末尾追加(若文件不存在,新建并按现有测试 mock 模式构造 LocalDocumentIndex stub):

```typescript
describe('VectraStore.hybridSearch', () => {
	it('hybridSearch - 调用 queryItems 传 isBm25=true 且 query 非空', async () => {
		// 关键路径:mock LocalDocumentIndex,捕获 queryItems 的入参
		const queryItemsMock = vi.fn().mockResolvedValue([]);
		const listDocumentsMock = vi.fn().mockResolvedValue([]);
		const isIndexCreatedMock = vi.fn().mockResolvedValue(true);
		const fakeIndex = {
			queryItems: queryItemsMock,
			listDocuments: listDocumentsMock,
			isIndexCreated: isIndexCreatedMock,
			createIndex: vi.fn(),
			getDocumentUri: vi.fn(),
			getCatalogStats: vi.fn().mockResolvedValue({ documents: 0 }),
		} as unknown as import('vectra').LocalDocumentIndex;

		// 关键路径:用 Object.defineProperty 注入 fakeIndex,绕过 ensureIndex 的真实初始化
		const store = new VectraStore('/tmp/test-index');
		// 把 store.index 私有字段强行替换为 fakeIndex
		(store as unknown as { index: unknown }).index = fakeIndex;
		// 把 _ready 设为已 resolved,跳过 init()
		(store as unknown as { _ready: Promise<void> | null })._ready = Promise.resolve();

		await store.hybridSearch('我的笔记', [0.1, 0.2, 0.3], 5);

		expect(queryItemsMock).toHaveBeenCalledTimes(1);
		const [vectorArg, queryArg, topKArg, filterArg, isBm25Arg] = queryItemsMock.mock.calls[0]!;
		expect(queryArg).toBe('我的笔记');
		expect(vectorArg).toEqual([0.1, 0.2, 0.3]);
		expect(topKArg).toBe(50); // 5 * 10 过度抓取
		expect(filterArg).toBeUndefined();
		expect(isBm25Arg).toBe(true);
	});

	it('hybridSearch - 聚合 chunk 到文档级并按分数降序', async () => {
		// mock 两条 chunk,同属 notes/a.md,聚合后取最高分
		const queryItemsMock = vi.fn().mockResolvedValue([
			{ score: 0.8, item: { metadata: { documentId: 'doc-1', path: 'notes/a.md', chunkIndex: 0 } } },
			{ score: 0.9, item: { metadata: { documentId: 'doc-1', path: 'notes/a.md', chunkIndex: 1 } } },
			{ score: 0.6, item: { metadata: { documentId: 'doc-2', path: 'notes/b.md', chunkIndex: 0 } } },
		]);
		const fakeIndex = {
			queryItems: queryItemsMock,
			isIndexCreated: vi.fn().mockResolvedValue(true),
			createIndex: vi.fn(),
			getDocumentUri: vi.fn().mockImplementation(async (id: string) => `uri-${id}`),
			getCatalogStats: vi.fn(),
			listDocuments: vi.fn(),
		} as unknown as import('vectra').LocalDocumentIndex;

		const store = new VectraStore('/tmp/test-index');
		(store as unknown as { index: unknown }).index = fakeIndex;
		(store as unknown as { _ready: Promise<void> | null })._ready = Promise.resolve();

		const results = await store.hybridSearch('query', [0.1, 0.2], 5);

		// 关键路径:聚合后 doc-1 取最高分 0.9,doc-2 取 0.6,按降序
		expect(results).toHaveLength(2);
		expect(results[0]!.docId).toBe('uri-doc-1');
		expect(results[0]!.score).toBe(0.9);
		expect(results[1]!.docId).toBe('uri-doc-2');
		expect(results[1]!.score).toBe(0.6);
		// 关键路径:hybridSearch 不填 index(由 search_vault 工具层填)
		expect(results[0]!.index).toBeUndefined();
	});
});
```

- [ ] **Step 3: 运行测试,验证失败**

Run: `npx vitest run tests/adapters/vector-vectra.test.ts`
Expected: FAIL,`store.hybridSearch is not a function`

- [ ] **Step 4: 实现 VectraStore.hybridSearch**

在 `src/adapters/vector-vectra.ts` 中,`search()` 方法之后(类内)新增:

```typescript
	/**
	 * 混合搜索 — 向量 + BM25 关键词,vectra 内置融合。
	 *
	 * 关键路径:
	 * - 调用 `queryItems(queryVector, query, topK * 10, undefined, true)`
	 * - 第 2 参数传 query 文本(原 search 传空串,BM25 未启用)
	 * - 第 5 参数 isBm25=true 启用 BM25 追加结果
	 * - 复用 search() 的 chunk→doc 聚合逻辑(同文档取最高分,按分数降序)
	 *
	 * @param query - 用户查询文本(用于 BM25)
	 * @param queryVector - 查询向量(用于语义搜索,主线程 embedding)
	 * @param topK - 返回文档上限
	 * @returns 文档级结果(不含 index 字段,index 由 search_vault 工具层填)
	 */
	async hybridSearch(query: string, queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
		const index = await this.ensureIndex();
		// 过度抓取:与 search() 一致,聚合后确保 topK 文档都能拿到。
		const results = await index.queryItems(queryVector, query, topK * 10, undefined, true);

		// --- chunk → document 聚合(与 search() 同逻辑) ---
		const internalIds = new Set<string>();
		for (const r of results) {
			const chunkMeta = r.item.metadata as DocumentChunkMetadata;
			if (chunkMeta.documentId) {
				internalIds.add(chunkMeta.documentId);
			}
		}

		const uriMap = new Map<string, string>();
		for (const internalId of internalIds) {
			const uri = await index.getDocumentUri(internalId);
			if (uri) uriMap.set(internalId, uri);
		}

		const docMap = new Map<string, { docId: string; score: number; metadata: Record<string, unknown> }>();
		for (const r of results) {
			const chunkMeta = r.item.metadata as DocumentChunkMetadata;
			const internalDocId = chunkMeta.documentId;
			if (!internalDocId) continue;

			const docId = uriMap.get(internalDocId) ?? internalDocId;
			const existing = docMap.get(docId);
			if (!existing || r.score > existing.score) {
				docMap.set(docId, {
					docId,
					score: r.score,
					metadata: chunkMeta as unknown as Record<string, unknown>,
				});
			}
		}

		return Array.from(docMap.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, topK);
	}
```

- [ ] **Step 5: 运行测试,验证通过**

Run: `npx vitest run tests/adapters/vector-vectra.test.ts`
Expected: PASS(2 个 hybridSearch 测试通过)

- [ ] **Step 6: 提交**

```bash
git add src/adapters/vector-vectra.ts tests/adapters/vector-vectra.test.ts
git commit -m "feat(w3): VectraStore.hybridSearch — vectra isBm25 混合搜索"
```

---

## Task 3: Worker 协议扩展(index-processor + handler)

**Files:**
- Modify: `src/worker/index-processor.ts`
- Modify: `src/worker/handler.ts`
- Test: `tests/worker/handler.test.ts`(若无则新建,参考现有 handler 测试 mock 模式)

- [ ] **Step 1: 写失败测试 — hybrid.search case 路由到 processor.hybridSearch**

在 `tests/worker/handler.test.ts` 末尾追加(若文件不存在,新建并 mock IndexProcessor):

```typescript
describe('handler — hybrid.search', () => {
	it('hybrid.search - 路由到 processor.hybridSearch 并返回 hybrid.search.result', async () => {
		const fakeStore = {} as import('../../src/adapters/vector-vectra').VectraStore;
		const processor = new IndexProcessor(fakeStore);
		// 关键路径:mock processor.hybridSearch,避免真实 vectra 调用
		processor.hybridSearch = vi.fn().mockResolvedValue([
			{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 } },
		]);

		// 用 initProcessorWithStore 注入 processor
		initProcessorWithStore(fakeStore);
		// 关键路径:initProcessorWithStore 会用新 store 重建 processor,
		// 这里改用直接替换全局 processor 的方式 — 见 handler 导出的 setProcessorForTest(若有);
		// 若无此 helper,在 handler.ts 暴露一个 testOnly.setProcessor 函数。

		const response = await handleMessage(
			{ type: 'hybrid.search', payload: { query: 'test', queryVector: [0.1, 0.2], topK: 5 } },
			() => {},
		);

		expect(response.type).toBe('hybrid.search.result');
		expect(response.payload).toHaveLength(1);
		expect(processor.hybridSearch).toHaveBeenCalledWith('test', [0.1, 0.2], 5);
	});

	it('hybrid.search - 未知 payload 字段 - 仍能解析并路由', async () => {
		// 关键路径:_requestId 是主线程注入的字段,handler 不应受其影响
		const fakeStore = {} as import('../../src/adapters/vector-vectra').VectraStore;
		const processor = new IndexProcessor(fakeStore);
		processor.hybridSearch = vi.fn().mockResolvedValue([]);

		const response = await handleMessage(
			{ type: 'hybrid.search', payload: { query: 'x', queryVector: [0.1], topK: 3 }, _requestId: 'req_1' } as never,
			() => {},
		);

		expect(response.type).toBe('hybrid.search.result');
	});
});
```

> **注意:** 若 `handleMessage` 当前不导出 test helper 来替换全局 `processor`,在 Task 3 Step 4 中新增一个 `setProcessorForTest` 导出函数,仅用于测试。

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/worker/handler.test.ts`
Expected: FAIL,`processor.hybridSearch is not a function` 或 `Unknown request type: hybrid.search`

- [ ] **Step 3: 实现 IndexProcessor.hybridSearch**

在 `src/worker/index-processor.ts` 的 `vectorSearch()` 方法之后新增:

```typescript
    /**
     * 混合搜索 — 向量 + BM25 关键词。
     *
     * 关键路径:委托给 VectraStore.hybridSearch,后者调 vectra queryItems 传 isBm25=true。
     *
     * @param query - 用户查询文本(用于 BM25)
     * @param queryVector - 查询向量(主线程 embedding)
     * @param topK - 返回文档上限
     */
    async hybridSearch(query: string, queryVector: number[], topK: number) {
        return this.store.hybridSearch(query, queryVector, topK);
    }
```

- [ ] **Step 4: 实现 handler.ts 的 hybrid.search case**

在 `src/worker/handler.ts` 的 `case 'vector.search'` 之后插入:

```typescript
        case 'hybrid.search': {
            const req = msg as WorkerRequest & { payload: { query: string; queryVector: number[]; topK: number } };
            const results = await processor.hybridSearch(req.payload.query, req.payload.queryVector, req.payload.topK);
            return { type: 'hybrid.search.result', payload: results };
        }
```

> 同时,若 Task 3 Step 1 测试需要 `setProcessorForTest`,在 handler.ts 末尾追加:

```typescript
/**
 * 仅供测试 — 替换全局 processor。
 * 关键路径:测试需要 mock processor.hybridSearch,但 initProcessor/initProcessorWithStore
 * 会重建 VectraStore,不适合纯函数测试。此 helper 让测试直接注入 mock processor。
 */
export function setProcessorForTest(p: IndexProcessor | null): void {
    processor = p;
}
```

并在 Task 3 Step 1 测试中改用:

```typescript
import { handleMessage, setProcessorForTest, IndexProcessor } from '../../src/worker/handler';
// 或从 index-processor 导入 IndexProcessor
```

把每个测试中的 `initProcessorWithStore(fakeStore)` 替换为 `setProcessorForTest(processor)`,并在测试 `afterEach` 中 `setProcessorForTest(null)` 清理。

- [ ] **Step 5: 运行测试,验证通过**

Run: `npx vitest run tests/worker/handler.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/worker/index-processor.ts src/worker/handler.ts tests/worker/handler.test.ts
git commit -m "feat(w3): Worker hybrid.search 协议 — IndexProcessor + handler case"
```

---

## Task 4: search_vault 工具改造 + 测试

**Files:**
- Modify: `src/tools/search-vault.ts`
- Test: `tests/tools/search-vault.test.ts`

- [ ] **Step 1: 改测试 — mock 改为 hybrid.search.result,断言 index 从 1 开始**

把 `tests/tools/search-vault.test.ts` 中所有 `vector.search` / `vector.search.result` 替换为 `hybrid.search` / `hybrid.search.result`,并在断言中加入 `index` 字段验证。

具体改动:

(1) 第一个测试 "查询命中 — 返回 docId + score + metadata" 改为:

```typescript
	it('search_vault - 查询命中 - 返回 docId + score + metadata + index(从1开始)', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager();
		worker.request = vi.fn().mockResolvedValue({
			type: 'hybrid.search.result',
			payload: [
				{ docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 } },
				{ docId: 'notes/other.md#chunk-0', score: 0.80, metadata: { path: 'notes/other.md', chunkIndex: 0 } },
			] as VectorSearchResult[],
		});

		const tool = createSearchVaultTool(embedding, worker, () => true);
		const result = await tool.execute({ query: '技术栈', topK: 5 });

		// 关键路径:embedding 在主线程执行,query 传给 worker 用于 BM25
		expect(embedding.embed).toHaveBeenCalledWith(['技术栈']);
		expect(worker.request).toHaveBeenCalledWith({
			type: 'hybrid.search',
			payload: { query: '技术栈', queryVector: [0.1, 0.2, 0.3], topK: 5 },
		});
		// 关键路径:index 从 1 开始,供 LLM 引用 [1][2]
		expect(result).toEqual([
			{ docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 }, index: 1 },
			{ docId: 'notes/other.md#chunk-0', score: 0.80, metadata: { path: 'notes/other.md', chunkIndex: 0 }, index: 2 },
		]);
	});
```

(2) "未命中 — 返回空数组" 测试的 mock 改为 `hybrid.search.result`,断言 result 为 `[]`。

(3) "Worker 返回异常类型" 测试的 mock 改为 `{ type: 'error', ... }`,断言抛错信息更新为 `Unexpected worker response type: error`。

(4) "未传 topK — 默认使用 5" 测试的 expect 改为:

```typescript
		expect(worker.request).toHaveBeenCalledWith({
			type: 'hybrid.search',
			payload: { query: '技术栈', queryVector: [0.1, 0.2, 0.3], topK: 5 },
		});
```

(5) "检索未就绪 — 抛 INDEX_NOT_READY" 测试不变(未到 worker 调用层)。

(6) 新增测试 "query 非字符串" 已有,无需改。

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/tools/search-vault.test.ts`
Expected: FAIL(`worker.request` 被调用的参数是 `vector.search` 而非 `hybrid.search`)

- [ ] **Step 3: 改 search_vault.ts — 调 hybrid.search,返回加 index,更新 description**

把 `src/tools/search-vault.ts` 的 `createSearchVaultTool` 内部改为:

```typescript
	return {
		definition: {
			name: 'search_vault',
			description: 'Search the vault for notes relevant to a query. Uses hybrid vector + BM25 keyword search. Returns ranked results with index numbers for citation. Use read_note to fetch full content of promising results.',
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

			// 关键路径:查询向量化在主线程完成,单条 ms 级,不阻塞 UI。
			const [queryVector] = await embedding.embed([query]);

			// Worker 做 vectra 混合搜索(向量 + BM25,vectra 内置融合)
			const response = await workerManager.request({
				type: 'hybrid.search',
				payload: { query, queryVector: queryVector!, topK },
			});

			if (response.type !== 'hybrid.search.result') {
				throw new Error(`Unexpected worker response type: ${response.type}`);
			}

			// 关键路径:加 index 编号(从 1 开始),供 LLM 用 [1][2] 引用。
			return response.payload.map((r, i) => ({
				...r,
				index: i + 1,
			}));
		},
	};
```

- [ ] **Step 4: 运行测试,验证通过**

Run: `npx vitest run tests/tools/search-vault.test.ts`
Expected: PASS(全部 6 个测试通过)

- [ ] **Step 5: 提交**

```bash
git add src/tools/search-vault.ts tests/tools/search-vault.test.ts
git commit -m "feat(w3): search_vault 改调 hybrid.search + 返回带 index 编号"
```

---

## Task 5: 意图分类器 + 测试

**Files:**
- Create: `src/core/intent-classifier.ts`
- Test: `tests/core/intent-classifier.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/core/intent-classifier.test.ts`:

```typescript
/**
 * @file tests/core/intent-classifier.test.ts
 * @description 意图分类器单元测试
 * @module tests/core/intent-classifier
 */

import { describe, it, expect, vi } from 'vitest';
import { classifyIntent } from '../../src/core/intent-classifier';
import type { LLMClient, ChatRequest, ChatDelta } from '../../src/ports/llm';

function createMockLLM(streamOutput: string): LLMClient {
	return {
		async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
			// 关键路径:模拟 LLM 流式返回意图判断结果
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

describe('classifyIntent', () => {
	it('classifyIntent - LLM 返回 rag - 返回 rag', async () => {
		const llm = createMockLLM('rag');
		const intent = await classifyIntent('我的笔记里有什么关于 X 的内容?', { llm });
		expect(intent).toBe('rag');
	});

	it('classifyIntent - LLM 返回 direct - 返回 direct', async () => {
		const llm = createMockLLM('direct');
		const intent = await classifyIntent('帮我写一个模板', { llm });
		expect(intent).toBe('direct');
	});

	it('classifyIntent - LLM 返回带前后空白 - trim 后判断', async () => {
		const llm = createMockLLM('  rag\n');
		const intent = await classifyIntent('问题', { llm });
		expect(intent).toBe('rag');
	});

	it('classifyIntent - LLM 返回非预期值 - 降级为 rag', async () => {
		// 关键路径:LLM 输出不符合 rag/direct,降级为 rag(宁可多搜不漏)
		const llm = createMockLLM('我不确定');
		const intent = await classifyIntent('问题', { llm });
		expect(intent).toBe('rag');
	});

	it('classifyIntent - LLM 抛错 - 降级为 rag', async () => {
		// 关键路径:LLM 异常时降级为 rag,不阻断主流程
		const llm = createMockLLMThrowing();
		const intent = await classifyIntent('问题', { llm });
		expect(intent).toBe('rag');
	});

	it('classifyIntent - 调用 LLM 时 maxTokens=5', async () => {
		// 关键路径:验证 maxTokens 限制,降低 token 成本
		const chatSpy = vi.fn();
		const llm: LLMClient = {
			async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
				chatSpy(req);
				yield { text: 'rag' };
			},
			countTokens: () => 10,
		};
		await classifyIntent('问题', { llm });
		expect(chatSpy).toHaveBeenCalledWith(expect.objectContaining({
			options: expect.objectContaining({ maxTokens: 5 }),
		}));
	});
});
```

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/core/intent-classifier.test.ts`
Expected: FAIL,`Cannot find module '../../src/core/intent-classifier'`

- [ ] **Step 3: 实现 intent-classifier.ts**

新建 `src/core/intent-classifier.ts`:

```typescript
/**
 * @file src/core/intent-classifier.ts
 * @description 轻量意图分类器 — 一次 LLM 调用判断用户消息是否需要走 RAG 工作流
 * @module core/intent-classifier
 * @depends ports/llm
 */

import type { LLMClient, ChatMessage } from '../ports/llm';

/**
 * 用户消息意图。
 * - 'rag' = 需要搜索知识库(问笔记内容、查关系、找信息)
 * - 'direct' = 直接回答(通用问题、生成任务、统计、闲聊)
 */
export type Intent = 'rag' | 'direct';

export interface IntentClassifierDeps {
	llm: LLMClient;
}

/**
 * 意图分类提示词 — 中英文混合,因 LLM 可能用任一语言回答用户。
 * 关键路径:只要求回答一个词,降低 token 成本(maxTokens=5)。
 */
const INTENT_PROMPT_TEMPLATE = (message: string): string =>
	`判断以下用户消息是否需要搜索 Obsidian 知识库来回答。
只回答一个词:'rag'(需要搜索)或 'direct'(不需要搜索)。

需要搜索(rag)的例子:
- 问知识库内容:"我的笔记里有什么关于 X 的内容?"
- 问笔记关系:"X 和 Y 有什么联系?"
- 查找信息:"我写过关于 X 的东西吗?"

不需要搜索(direct)的例子:
- 通用问题:"今天天气怎么样?"
- 生成任务:"帮我写一个模板"
- 统计任务:"库里有几个文件夹?"
- 闲聊:"你好"

用户消息:${message}
回答:`;

/**
 * 用一次快速 LLM 调用判断用户消息意图。
 *
 * 关键路径:
 * - 提示词极简,只要求回答 'rag' 或 'direct',降低 token 成本
 * - maxTokens 限制为 5,避免 LLM 啰嗦
 * - 解析失败或 LLM 异常时降级为 'rag'(宁可多搜一次,不漏知识库内容)
 *
 * @param message - 用户消息
 * @param deps - 依赖(LLM 客户端)
 * @returns 'rag' = 需要搜索知识库;'direct' = 直接回答
 */
export async function classifyIntent(
	message: string,
	deps: IntentClassifierDeps,
): Promise<Intent> {
	const messages: ChatMessage[] = [
		{ role: 'system', content: 'You are a helpful intent classifier. Reply with exactly one word: rag or direct.' },
		{ role: 'user', content: INTENT_PROMPT_TEMPLATE(message) },
	];

	try {
		let output = '';
		// 关键路径:maxTokens=5 限制输出长度,降低成本(意图词 + 少量噪声)
		const stream = deps.llm.chat({ messages, options: { maxTokens: 5 } });
		for await (const delta of stream) {
			if (delta.text) output += delta.text;
		}

		const trimmed = output.trim().toLowerCase();
		// 关键路径:精确匹配 'rag' 或 'direct',其余一律降级为 'rag'
		if (trimmed === 'rag' || trimmed.includes('rag')) return 'rag';
		if (trimmed === 'direct' || trimmed.includes('direct')) return 'direct';
		// 未识别输出 → 降级 rag
		return 'rag';
	} catch {
		// 关键路径:LLM 异常不阻断主流程,降级为 rag
		return 'rag';
	}
}
```

- [ ] **Step 4: 运行测试,验证通过**

Run: `npx vitest run tests/core/intent-classifier.test.ts`
Expected: PASS(6 个测试通过)

- [ ] **Step 5: 提交**

```bash
git add src/core/intent-classifier.ts tests/core/intent-classifier.test.ts
git commit -m "feat(w3): 意图分类器 — 一次 LLM 调用判断 rag/direct"
```

---

## Task 6: ContextManager 动态提示词 + 测试

**Files:**
- Modify: `src/core/context-manager.ts`
- Test: `tests/core/context-manager.test.ts`

- [ ] **Step 1: 写失败测试 — toMessages(intent) 按意图选提示词**

在 `tests/core/context-manager.test.ts` 末尾追加:

```typescript
	// ==================== 动态提示词(W3) ====================

	it('toMessages(direct) - 返回 BASE_PROMPT(不含 RAG 工作流指令)', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('s1');
		ctx.addUserMessage('你好');

		const msgs = ctx.toMessages('direct');
		expect(msgs[0]!.role).toBe('system');
		// 关键路径:direct 模式不含 RAG workflow 指令
		expect(msgs[0]!.content).not.toContain('search_vault');
		expect(msgs[0]!.content).toContain('Ratel');
	});

	it('toMessages(rag) - 返回 RAG_PROMPT(含 search_vault 工作流指令)', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('s1');
		ctx.addUserMessage('我的笔记里有什么?');

		const msgs = ctx.toMessages('rag');
		expect(msgs[0]!.role).toBe('system');
		// 关键路径:rag 模式含 search_vault + read_note + 引用 [1][2] 指令
		expect(msgs[0]!.content).toContain('search_vault');
		expect(msgs[0]!.content).toContain('read_note');
		expect(msgs[0]!.content).toContain('[1]');
	});

	it('toMessages(默认) - 不传 intent 时降级为 direct', async () => {
		// 关键路径:向后兼容,老调用方不传 intent 仍能工作
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('s1');
		ctx.addUserMessage('hi');

		const msgs = ctx.toMessages();
		expect(msgs[0]!.content).not.toContain('search_vault');
	});
```

> **注意:** 现有测试 `creates a new session when none exists` 调 `ctx.toMessages()` 不传参数,仍应通过(降级 direct)。`tokenCount works even before load` 内部调 `this.toMessages()` 也不传参,仍通过。

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/core/context-manager.test.ts`
Expected: FAIL,`toMessages('direct')` 等参数版本不存在(类型错误)或 `BASE_PROMPT` 未定义

- [ ] **Step 3: 改 context-manager.ts — BASE_PROMPT + RAG_PROMPT + toMessages(intent?)**

(1) 把文件顶部 `SYSTEM_PROMPT` 替换为:

```typescript
/**
 * 基础系统提示词 — direct 模式(闲聊、生成、统计等不需要搜索的场景)。
 *
 * 关键路径:英文版,token 效率高于中文;`Always respond in the same language the user uses`
 * 强制 LLM 跟随用户语言,避免用户问中文时模型用英文回答。
 */
const BASE_PROMPT = `You are Ratel, an AI assistant that helps users explore and manage their Obsidian vault. You can read notes and answer questions about their content. Always respond in the same language the user uses.`;

/**
 * RAG 系统提示词 — rag 模式(问知识库内容、查笔记关系等需要搜索的场景)。
 *
 * 关键路径:在 BASE_PROMPT 基础上追加 RAG 工作流指令,引导 LLM:
 * 1. 调 search_vault 找相关笔记(结果带 index 编号)
 * 2. 调 read_note 读全文
 * 3. 回答时用 [1][2] 引用 search_vault 返回的 index
 */
const RAG_PROMPT = BASE_PROMPT + `

When answering knowledge base questions, follow this workflow:
1. Call search_vault to find relevant notes. Results include an index number for citation.
2. Call read_note for promising results to read the full content.
3. Answer the question and cite sources using [1], [2] format matching the index numbers from search results.
4. If search returns no results, tell the user honestly.
`;

/**
 * 意图类型 — 由意图分类器判断,决定 toMessages 用哪个提示词。
 */
type Intent = 'rag' | 'direct';
```

(2) 把 `toMessages()` 改为 `toMessages(intent: Intent = 'direct')`:

```typescript
	/**
	 * 拼接最终给 LLM 的消息列表(系统提示 + 检索结果 + 历史消息)。
	 *
	 * 关键路径:
	 * - 按意图选择 BASE_PROMPT(direct)或 RAG_PROMPT(rag)
	 * - 历史消息超出 `maxHistoryTokens` 时触发 Layer 1 截断
	 * - 系统提示词和搜索结果不在裁剪范围
	 *
	 * @param intent - 意图分类结果,默认 'direct'(向后兼容)
	 * @returns 消息数组,首条为 system 角色
	 */
	toMessages(intent: Intent = 'direct'): ChatMessage[] {
		const systemPrompt = intent === 'rag' ? RAG_PROMPT : BASE_PROMPT;
		const history = this.session?.messages ?? [];
		const trimmed = this.trimHistory(history);
		return [
			{ role: 'system', content: systemPrompt },
			...this.searchResultsMessages,
			...trimmed,
		];
	}
```

(3) `tokenCount()` 方法内部调 `this.toMessages()` — 不传参默认 direct,行为不变,无需改。

- [ ] **Step 4: 运行测试,验证通过**

Run: `npx vitest run tests/core/context-manager.test.ts`
Expected: PASS(全部测试通过,包括新增 3 个 + 现有 14 个)

- [ ] **Step 5: 提交**

```bash
git add src/core/context-manager.ts tests/core/context-manager.test.ts
git commit -m "feat(w3): ContextManager 动态提示词 — toMessages(intent) 按 rag/direct 选 BASE/RAG"
```

---

## Task 7: Agent Loop 接入意图分类 + search.result 事件 + 测试

**Files:**
- Modify: `src/core/agent-loop.ts`
- Test: `tests/core/agent-loop.test.ts`

- [ ] **Step 1: 写失败测试 — 意图分类被调用 + search_vault 后发 search.result 事件**

在 `tests/core/agent-loop.test.ts` 末尾追加:

```typescript
	// ==================== W3: 意图分类 + search.result 事件 ====================

	it('agentLoop - 注入 intentClassifier - 调用分类器并按意图选提示词', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		// 关键路径:LLM 第二轮调用用于真实 chat,第一轮被意图分类器消费
		const chatSpy = vi.fn();
		const llm: LLMClient = {
			async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
				chatSpy(req);
				// 关键路径:第一次调用是意图分类(maxTokens=5),第二次是真实回复
				if (req.options?.maxTokens === 5) {
					yield { text: 'rag' };
					return;
				}
				yield { text: '回答' };
			},
			countTokens: () => 10,
		};
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();
		const intentClassifier = vi.fn().mockResolvedValue('rag' as const);

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: '我的笔记有什么' },
			ctx,
			llm,
			tools,
			hooks,
			undefined,
			intentClassifier,
		)) {
			events.push(event);
		}

		// 关键路径:意图分类器被调用,参数是用户消息
		expect(intentClassifier).toHaveBeenCalledWith('我的笔记有什么');
		// 关键路径:第二次 chat 调用的 messages[0] 应是 RAG_PROMPT(含 search_vault)
		const realChatCall = chatSpy.mock.calls.find(([{ options }]) => !options?.maxTokens || options.maxTokens !== 5);
		const realMessages = realChatCall?.[0]?.messages;
		expect(realMessages?.[0]?.content).toContain('search_vault');
	});

	it('agentLoop - 无 intentClassifier - 不调分类,默认 direct 提示词', async () => {
		// 关键路径:向后兼容,老调用方不传 intentClassifier 仍能工作
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([[{ text: 'hi' }]]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			events.push(event);
		}

		// 关键路径:无 search.result 事件(没有调 search_vault)
		expect(events.some((e) => e.type === 'search.result')).toBe(false);
	});

	it('agentLoop - search_vault 返回后发 search.result 事件', async () => {
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
				{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1 },
				{ docId: 'notes/b.md#chunk-0', score: 0.8, metadata: { path: 'notes/b.md', chunkIndex: 0 }, index: 2 },
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

		// 关键路径:search.result 事件被发出
		const searchResultEvent = events.find((e) => e.type === 'search.result');
		expect(searchResultEvent).toBeDefined();
		if (searchResultEvent?.type === 'search.result') {
			expect(searchResultEvent.payload.results).toHaveLength(2);
			// 关键路径:path 从 metadata.path 提取,扁平结构(不嵌套 metadata)
			expect(searchResultEvent.payload.results[0]).toEqual({
				docId: 'notes/a.md#chunk-0',
				score: 0.9,
				path: 'notes/a.md',
				index: 1,
			});
		}
	});
```

- [ ] **Step 2: 运行测试,验证失败**

Run: `npx vitest run tests/core/agent-loop.test.ts`
Expected: FAIL(`agentLoop` 不接受第 7 个参数;无 search.result 事件)

- [ ] **Step 3: 改 agent-loop.ts — 接受 intentClassifier 可选参数 + 发 search.result 事件**

(1) 在文件顶部 import 区追加:

```typescript
import type { Intent } from './intent-classifier';
```

(2) 把 `agentLoop` 函数签名加第 7 个参数:

```typescript
export async function* agentLoop(
	req: UserChatRequest,
	ctx: ContextManager,
	llm: LLMClient,
	tools: ToolRegistry,
	hooks: HookRegistry,
	signal?: AbortSignal,
	intentClassifier?: (message: string) => Promise<Intent>,
): AsyncIterable<AgentEvent> {
	// 加载或初始化 session,然后把用户消息压入上下文。
	await ctx.load(req.sessionId);
	ctx.addUserMessage(req.message);

	// 关键路径:意图分类,判断是否需要 RAG 工作流。无 classifier 时降级 direct(向后兼容)。
	let intent: Intent = 'direct';
	if (intentClassifier) {
		intent = await intentClassifier(req.message);
	}

	try {
		// 单步循环:每轮产生一段 assistant 回复 + (可选)一次工具调用。
		for (let step = 0; step < MAX_STEPS; step++) {
			if (signal?.aborted) {
				yield { type: 'error', payload: { code: 'CANCELLED', message: '用户取消' } };
				break;
			}

			yield { type: 'message.start', payload: { role: 'assistant' as const } };

			let accumulatedText = '';
			let toolCall: ToolCall | null = null;

			try {
				// 关键路径:按意图选择提示词
				const stream = llm.chat({
					messages: ctx.toMessages(intent),
					tools: tools.definitions(),
				});

				for await (const delta of stream) {
					if (signal?.aborted) {
						yield { type: 'error', payload: { code: 'CANCELLED', message: '用户取消' } };
						break;
					}
					if (delta.text) {
						accumulatedText += delta.text;
						yield { type: 'message.delta', payload: { text: delta.text } };
					}
					if (delta.toolCall) {
						toolCall = delta.toolCall;
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				yield { type: 'error', payload: { code: 'LLM_ERROR', message } };
				ctx.addAssistantMessage(accumulatedText || `Error: ${message}`);
				break;
			}

			if (signal?.aborted) {
				ctx.addAssistantMessage(accumulatedText);
				break;
			}

			if (!toolCall) {
				ctx.addAssistantMessage(accumulatedText);
				break;
			}

			yield { type: 'tool.call', payload: { name: toolCall.name, args: toolCall.args } };

			if (!tools.isReadOnly(toolCall.name)) {
				await hooks.run('pre-write', toolCall);
			}

			let result: unknown;
			try {
				result = await tools.execute(toolCall);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const code = (err as Error & { code?: string }).code ?? 'TOOL_ERROR';
				yield { type: 'error', payload: { code, message } };
				result = `Error: ${message}`;
			}

			yield { type: 'tool.result', payload: { name: toolCall.name, result } };

			// 关键路径:search_vault 返回后发 search.result 事件(payload 用扁平结构)。
			// 从 metadata.path 提取 path,避免 UI 层再嵌套解析 metadata。
			if (toolCall.name === 'search_vault' && Array.isArray(result)) {
				const searchResults = (result as Array<{
					docId: string;
					score: number;
					metadata: { path?: string };
					index: number;
				}>)
					.filter((r) => r.metadata && typeof r.metadata.path === 'string')
					.map((r) => ({
						docId: r.docId,
						score: r.score,
						path: r.metadata.path as string,
						index: r.index,
					}));
				if (searchResults.length > 0) {
					yield {
						type: 'search.result',
						payload: { results: searchResults },
					};
				}
			}

			if (!tools.isReadOnly(toolCall.name)) {
				await hooks.run('post-write', toolCall);
			}

			ctx.addAssistantToolCall(toolCall, accumulatedText);
			ctx.addToolResult(toolCall.id, JSON.stringify(result));
		}
	} finally {
		yield { type: 'message.end', payload: { tokens: ctx.tokenCount() } };
		await ctx.save();
	}
}
```

- [ ] **Step 4: 运行测试,验证通过**

Run: `npx vitest run tests/core/agent-loop.test.ts`
Expected: PASS(全部测试通过,包括新增 3 个 + 现有)

- [ ] **Step 5: 提交**

```bash
git add src/core/agent-loop.ts tests/core/agent-loop.test.ts
git commit -m "feat(w3): Agent Loop 接入意图分类器 + search.result 事件"
```

---

## Task 8: ChatView 搜索结果卡片

**Files:**
- Modify: `src/ui/ChatView.svelte`

UI 改动无单测(Svelte 5 组件单测本项目未建立),靠 build + 手动 E2E 验证。

- [ ] **Step 1: Message 接口加 searchResults 字段**

在 `src/ui/ChatView.svelte` 的 `interface Message` 中追加:

```typescript
interface Message {
	role: 'user' | 'assistant';
	content: string;
	toolCalls?: ToolCallEntry[];
	chatError?: DiagError;
	cancelled?: boolean;
	searchResults?: Array<{
		docId: string;
		score: number;
		path: string;
		index: number;
	}>;
}
```

- [ ] **Step 2: sendMessage 事件循环加 search.result case**

在 `for await (const event of events)` 的 switch 中,`tool.result` case 之后追加:

```typescript
					case 'search.result':
						assistantMsg.searchResults = event.payload.results;
						messages = [...messages];
						break;
```

- [ ] **Step 3: 模板加搜索结果卡片渲染**

在 `{#if msg.toolCalls && msg.toolCalls.length > 0}...{/if}` 块之后、`{#if msg.content}` 之前插入:

```svelte
			{#if msg.searchResults && msg.searchResults.length > 0}
				<div class="ratel-search-results">
					<div class="ratel-search-header">🔍 搜索结果</div>
					{#each msg.searchResults as r}
						<div class="ratel-search-item">
							<span class="ratel-search-index">[{r.index}]</span>
							<span class="ratel-search-path">{r.path}</span>
							<span class="ratel-search-score">{r.score.toFixed(3)}</span>
						</div>
					{/each}
				</div>
			{/if}
```

- [ ] **Step 4: 样式追加**

在 `<style>` 块末尾(`</style>` 之前)追加:

```css
	.ratel-search-results {
		margin-bottom: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--background-modifier-form-field);
		font-size: 0.85em;
	}

	.ratel-search-header {
		font-weight: 600;
		margin-bottom: 4px;
		opacity: 0.8;
	}

	.ratel-search-item {
		display: flex;
		gap: 6px;
		align-items: center;
		padding: 2px 0;
	}

	.ratel-search-index {
		font-family: var(--font-monospace);
		font-weight: 600;
		color: var(--interactive-accent);
		min-width: 24px;
	}

	.ratel-search-path {
		flex: 1;
		font-family: var(--font-monospace);
		font-size: 0.9em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-search-score {
		font-family: var(--font-monospace);
		color: var(--text-muted);
		font-size: 0.85em;
	}
```

- [ ] **Step 5: 验证 build 通过**

Run: `npm run build`
Expected: 0 errors(Svelte 5 编译通过)

- [ ] **Step 6: 提交**

```bash
git add src/ui/ChatView.svelte
git commit -m "feat(w3): ChatView 搜索结果卡片 — 编号 + 路径 + 分数"
```

---

## Task 9: main.ts 接线 + 集成验证

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: 改 ask() — 注入 intentClassifier**

在 `src/main.ts` 顶部 import 区追加:

```typescript
import { classifyIntent } from './core/intent-classifier';
```

把 `ask()` 方法改为:

```typescript
	async *ask(sessionId: string, message: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
		const ctx = new ContextManager(this.persistence);

		// 关键路径:注入意图分类器,让 agentLoop 在 addUserMessage 后判断意图。
		// 闭包捕获 this.llm,与 agentLoop 解耦。
		const intentClassifier = (msg: string) => classifyIntent(msg, { llm: this.llm });

		yield* agentLoop(
			{ sessionId, message },
			ctx,
			this.llm,
			this.tools,
			this.hooks,
			signal,
			intentClassifier,
		);
	}
```

- [ ] **Step 2: 运行全量测试**

Run: `npm test`
Expected: 全部测试通过(原 258 个 + 新增约 15 个 = 约 273 个)

- [ ] **Step 3: 运行 build**

Run: `npm run build`
Expected: 0 errors,`dist/main.js` 与 `dist/worker.js` 生成成功

- [ ] **Step 4: 运行 lint**

Run: `npm run lint`
Expected: 0 errors

- [ ] **Step 5: 提交**

```bash
git add src/main.ts
git commit -m "feat(w3): main.ts 注入意图分类器到 agentLoop"
```

- [ ] **Step 6: 手动 E2E 验证(用户操作)**

在 Obsidian 中重载插件,验证:
1. 发送 "你好" → 意图分类为 direct,LLM 直接回答(不调 search_vault)
2. 发送 "我的笔记里有什么关于 X 的内容?" → 意图分类为 rag,LLM 调 search_vault
3. 搜索结果卡片正常渲染(编号 + 路径 + 分数)
4. LLM 回答中引用 [1][2]

---

## Self-Review

### 1. Spec 覆盖检查

| Spec 章节 | 覆盖 Task |
|----------|----------|
| §4.1 数据流 | Task 5 + 7 + 9(意图分类 → 动态提示词 → 混合搜索 → search.result → ChatView) |
| §4.2 意图分类器 | Task 5 |
| §4.3 动态系统提示词 | Task 6 |
| §4.4 VectraStore.hybridSearch | Task 2 |
| §4.5 Worker 协议扩展 | Task 1(types)+ Task 3(handler + processor) |
| §4.6 search_vault 工具改造 | Task 4 |
| §4.7 Agent Loop 改造 | Task 7 |
| §4.8 search.result 事件 | Task 1(types)+ Task 7(agent-loop 发事件)+ Task 8(ChatView 处理) |
| §4.9 ChatView 搜索结果卡片 | Task 8 |
| §5 影响面(新建 / 修改文件) | 全部覆盖 |
| §6 测试策略(6 个测试点) | 全部覆盖 |
| §7 性能(maxTokens=5 / 过度抓取) | Task 5(maxTokens=5)+ Task 2(topK×10) |

无遗漏。

### 2. Placeholder 扫描

- 无 TBD / TODO / "implement later"
- 每个 Step 含完整代码或完整命令
- 测试代码完整,可直接运行
- 无 "类似 Task N" 引用(每个 Task 自包含)

### 3. 类型一致性

- `Intent = 'rag' | 'direct'`:Task 5 定义,Task 6 import,Task 7 import — 名称一致
- `VectorSearchResult.index?: number`:Task 1 定义,Task 2 不填(hybridSearch),Task 4 填(search_vault)— 一致
- `search.result` 事件 payload 结构:Task 1 定义 `{ results: Array<{ docId, score, path, index }> }`,Task 7 agent-loop 发事件时提取 path 从 metadata.path,Task 8 ChatView 接收 — 一致
- `IntentClassifierDeps = { llm: LLMClient }`:Task 5 定义,Task 9 main.ts 用 `classifyIntent(msg, { llm: this.llm })` — 一致
- `toMessages(intent: Intent = 'direct')`:Task 6 定义,Task 7 agent-loop 调 `ctx.toMessages(intent)` — 一致

### 4. 范围检查

W3 plan 范围与 S-W3-HYBRID spec 完全对齐,无 W4 内容(Query Rewrite / RRF / Reranker 留 P-W4-RAG)。滑动窗口明确不在范围(spec §3 已说明)。

---

## 执行选择

Plan complete and saved to `docs/superpowers/plans/2026-06-26-ratel-w3-hybrid-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
