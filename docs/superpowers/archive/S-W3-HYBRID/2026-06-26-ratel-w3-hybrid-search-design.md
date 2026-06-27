# S-W3-HYBRID — W3 混合搜索 + 意图分类 + 引用

- **Spec ID**:S-W3-HYBRID
- **状态**:Active
- **创建日期**:2026-06-26
- **取代**:[P-W3-IMPL](../plans/2026-06-13-ratel-w3-implementation.md) 的设计假设(原 plan 基于"手动两路搜索 + RRF 融合",vectra 已内置混合搜索,设计前提不再成立)
- **所属**:S-RAG-ARCH 的 W3 切片

---

## 1. 背景

S-RAG-ARCH 的 W3 切片原 plan(P-W3-IMPL,2026-06-13)设计于架构文档重建之前,假设需要:
- Worker 做两路独立搜索(vector.search 传向量 + bm25.search 传文本)
- 主线程用 RRF 算法融合两路结果
- search_vault 返回 text 字段

代码演进后审查发现 5 个关键偏差:

1. **vectra 已内置混合搜索**:`LocalIndex.queryItems(vector, query, topK, filter?, isBm25?)` 接受向量 + 文本,`isBm25: true` 即自动追加 BM25 关键词结果,无需手动两路搜索 + RRF
2. **Worker 架构已重构**:从 `self.onmessage` 直连 `LocalDocumentIndex` 改为 `handler.ts` + `IndexProcessor` + 共享 `VectraStore`
3. **search_vault 签名已变**:`createSearchVaultTool(embedding, workerManager, getSearchReady)` 而非 plan 假设的对象参数
4. **addSearchResults 签名已对齐架构文档**:接收 `{ path, content }`,content 来自 read_note 而非 search_vault
5. **VectorSearchResult 不含 text**:架构文档明确"search_vault 只返回 docId + score + metadata"

基于这些发现重新设计 W3,使其与当前代码与架构文档对齐。

---

## 2. 目标

1. **混合搜索**:search_vault 调用 vectra `queryItems(vector, query, topK, undefined, true)` 启用向量 + BM25 混合检索
2. **意图分类器**:Agent Loop 开始时用一次快速 LLM 调用判断用户消息是否需要走 RAG 工作流
3. **动态系统提示词**:按意图分类结果选择基础提示词或 RAG 引导提示词
4. **引用标记**:search_vault 返回结果带 `index` 编号,LLM 在回答中用 [1][2] 引用
5. **search.result 事件 + UI 卡片**:ChatView 展示搜索结果列表卡片(编号 + 路径 + 分数)

---

## 3. 非目标

以下推迟到 W4(S-W4-RAG-ENHANCEMENT):

- **Query Rewrite**:LLM 把查询改写成 2-3 个变体
- **RRF 多查询融合**:多个变体查询结果用 RRF 算法合并
- **Reranker**:百炼 API 对搜索结果做精排
- **Indexer subagent**:独立索引子代理

以下明确不做(推迟到独立 spec):

- **滑动窗口(上下文压缩 Layer 2)**:架构文档 [context-manager.md §9](../../architecture/agent/context-manager.md) 演进路径原把"滑动窗口 + 引用标记"放 P-W3-IMPL。W3 重新拆分后,引用标记纳入本 spec,滑动窗口独立 — 它与"检索"功能正交,是上下文预算管理的能力,留独立 spec 处理
- **LLM 摘要(上下文压缩 Layer 3)**:远期,见 context-manager.md §6
- **意图分类器完整版**(W4 级别):先用一次 LLM 调用分类意图,再用分类结果路由到不同子工作流。W3 只做轻量版(快速分类 + 二选一提示词)

---

## 4. 详细设计

### 4.1 数据流

```
用户消息
  ↓
[意图分类器] 一次快速 LLM 调用,判断 intent: 'rag' | 'direct'
  ↓                          ↓
 intent='rag'               intent='direct'
  ↓                          ↓
RAG 系统提示词             基础系统提示词
  ↓                          ↓
LLM 自主调 search_vault    LLM 直接回答
  ↓
[主线程] embedding.embed([query]) → queryVector
  ↓
[Worker] queryItems(queryVector, query, topK, undefined, true)
  ↓
vectra 内部:向量搜索 + BM25 关键词搜索 → 自动混合
  ↓
返回 chunk 级结果 → 聚合到文档级
  ↓
search_vault 返回 [{ docId, score, metadata: { path }, index: 1 }]
  ↓
[search.result 事件] → ChatView 渲染搜索结果卡片
  ↓
LLM 看到 index,自主调 read_note 读全文
  ↓
LLM 回答时引用 [1][2]
```

### 4.2 意图分类器(新建 `src/core/intent-classifier.ts`)

**职责**:判断用户消息是否需要搜索知识库。

```typescript
export type Intent = 'rag' | 'direct';

export interface IntentClassifierDeps {
  llm: LLMClient;
}

/**
 * 用一次快速 LLM 调用判断用户消息意图。
 *
 * 关键路径:
 * - 提示词极简,只要求回答 'rag' 或 'direct',降低 token 成本
 * - maxTokens 限制为 5,避免 LLM 啰嗦
 * - 解析失败时降级为 'rag'(宁可多搜一次,不漏知识库内容)
 *
 * @param message - 用户消息
 * @returns 'rag' = 需要搜索知识库;'direct' = 直接回答
 */
export async function classifyIntent(
  message: string,
  deps: IntentClassifierDeps,
): Promise<Intent>;
```

**意图分类提示词**(中英文混合,因为 LLM 可能用任一语言):

```
判断以下用户消息是否需要搜索 Obsidian 知识库来回答。
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

用户消息:{{message}}
回答:
```

### 4.3 动态系统提示词(`src/core/context-manager.ts` 修改)

**当前**:单一静态 `SYSTEM_PROMPT`。

**改造**:按意图分类结果选择提示词。

**对齐架构文档 [context-manager.md §4](../../architecture/agent/context-manager.md)**:架构文档已定义中文版 RAG 指令。本 spec 改用英文版,原因:
- 系统提示词用英文,LLM token 效率更高(英文 token 比中文密)
- "Always respond in the same language the user uses" 约束保证用户问中文时模型仍用中文回答
- 架构文档中文版作为概念参考,实现版以本 spec 英文为准

```typescript
const BASE_PROMPT = `You are Ratel, an AI assistant that helps users explore and manage their Obsidian vault. You can read notes and answer questions about their content. Always respond in the same language the user uses.`;

const RAG_PROMPT = BASE_PROMPT + `

When answering knowledge base questions, follow this workflow:
1. Call search_vault to find relevant notes. Results include an index number for citation.
2. Call read_note for promising results to read the full content.
3. Answer the question and cite sources using [1], [2] format matching the index numbers from search results.
4. If search returns no results, tell the user honestly.
`;
```

**toMessages() 改造**:接受 `intent` 参数,选择对应提示词。

```typescript
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

### 4.4 VectraStore.hybridSearch(`src/adapters/vector-vectra.ts` 修改)

**当前 `search()` 方法**:用 `queryItems(queryVector, '', topK * 10)` 做 chunk 级向量搜索,自己聚合到文档级。第二参数(query 文本)传空串,BM25 实际未启用。

**新增 `hybridSearch()` 方法**:

```typescript
/**
 * 混合搜索 — 向量 + BM25 关键词,vectra 内置融合。
 *
 * 关键路径:
 * - 调用 queryItems(queryVector, query, topK * 10, undefined, true)
 * - 第 2 参数传 query 文本(原 search 传空串)
 * - 第 5 参数 isBm25=true 启用 BM25 追加结果
 * - 复用现有 chunk→doc 聚合逻辑
 *
 * @param query - 用户查询文本(用于 BM25)
 * @param queryVector - 查询向量(用于语义搜索,主线程 embedding)
 * @param topK - 返回文档上限
 */
async hybridSearch(
  query: string,
  queryVector: number[],
  topK: number,
): Promise<VectorSearchResult[]>;
```

**保留原 `search()` 方法**:供 vectra BM25 不可用的降级场景使用(如 true Worker Threads 模式下 embeddings 未注入)。

### 4.5 Worker 协议扩展(`src/types.ts` + `src/worker/handler.ts`)

**对齐架构文档 [worker-protocol.md §3](../../architecture/host/worker-protocol.md)**:架构文档当前只定义 `vector.search`,本 spec 新增 `hybrid.search`(传 query + queryVector + topK,启用 vectra `isBm25`)。原 `vector.search` 保留供降级场景使用。架构文档 §3 协议表后续同步更新。

**WorkerRequest 新增**:

```typescript
| { type: 'hybrid.search'; payload: { query: string; queryVector: number[]; topK: number } }
```

**WorkerResponse 新增**:

```typescript
| { type: 'hybrid.search.result'; payload: Array<VectorSearchResult> }
```

**IndexProcessor 新增**:

```typescript
async hybridSearch(query: string, queryVector: number[], topK: number) {
  return this.store.hybridSearch(query, queryVector, topK);
}
```

**handler.ts 新增 case**:

```typescript
case 'hybrid.search': {
  const req = msg as WorkerRequest & { payload: { query: string; queryVector: number[]; topK: number } };
  const results = await processor.hybridSearch(req.payload.query, req.payload.queryVector, req.payload.topK);
  return { type: 'hybrid.search.result', payload: results };
}
```

### 4.6 search_vault 工具改造(`src/tools/search-vault.ts` 修改)

**当前**:调 `workerManager.request({ type: 'vector.search', ... })`,返回 `[{ docId, score, metadata }]`。

**改造**:
- 改调 `hybrid.search`(传 query + queryVector + topK)
- 返回值加 `index` 字段(从 1 开始)

**返回格式**(对齐 [retriever.md §3.1](../../architecture/rag/retriever.md) 的 `SearchVaultResult`):

```typescript
interface SearchVaultResult {
  docId: string;       // "notes/project.md#chunk-0"
  score: number;       // 融合分数 0~1
  metadata: {
    path: string;        // "notes/project.md"
    chunkIndex: number;  // 0
  };
  index: number;       // 引用编号,从 1 开始(W3 新增,供 LLM 用 [1][2] 引用)
}
```

```typescript
async execute(args: Record<string, unknown>) {
  const query = args.query as string;
  const topK = (args.topK as number) ?? 10;

  // 主线程做 embedding(支持 local/API 两种模式)
  const [queryVector] = await embedding.embed([query]);

  // Worker 做 vectra 混合搜索
  const response = await workerManager.request({
    type: 'hybrid.search',
    payload: { query, queryVector, topK },
  });

  const results = response.type === 'hybrid.search.result' ? response.payload : [];

  // 加 index 编号,供 LLM 引用
  return results.map((r, i) => ({
    ...r,
    index: i + 1,
  }));
}
```

**工具描述更新**:

```typescript
description: 'Search the vault for notes relevant to a query. Uses hybrid vector + BM25 keyword search. Returns ranked results with index numbers for citation. Use read_note to fetch full content of promising results.',
```

### 4.7 Agent Loop 改造(`src/core/agent-loop.ts` 修改)

**当前流程**(对齐 [agent-loop.md §3](../../architecture/agent/agent-loop.md)):`ctx.load()` → `ctx.addUserMessage()` → LLM 流式 → 工具调用 → 收尾。

**新流程**(对架构文档 §3 主循环的扩展 — 在 `addUserMessage` 之后、`LLM.chat` 之前插入意图分类步骤):

```typescript
await ctx.load(req.sessionId);
ctx.addUserMessage(req.message);

// 关键路径:意图分类,判断是否需要 RAG 工作流
const intent = await classifyIntent(req.message, { llm });
const messages = ctx.toMessages(intent);

// LLM 流式(传入按意图选择的提示词)
const stream = llm.chat({ messages, tools: tools.definitions() });

// ... 工具调用处理 ...

// search_vault 返回后发 search.result 事件
// 关键路径:从 metadata.path 提取 path 字段,事件 payload 用扁平结构(不嵌套 metadata)
if (toolCall.name === 'search_vault' && Array.isArray(result)) {
  const searchResults = (result as Array<{ docId: string; score: number; metadata: { path: string }; index: number }>)
    .map(r => ({ docId: r.docId, score: r.score, path: r.metadata.path, index: r.index }));
  yield {
    type: 'search.result',
    payload: { results: searchResults },
  };
}
```

**注意**:意图分类失败时降级为 `intent='rag'`(宁可多搜不漏)。

### 4.8 search.result 事件(`src/types.ts` 修改)

**AgentEvent 新增**:

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

### 4.9 ChatView 搜索结果卡片(`src/ui/ChatView.svelte` 修改)

在工具调用展示下方,新增搜索结果卡片:

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

Message 接口新增 `searchResults` 字段,在 `search.result` 事件时填充。

---

## 5. 影响面

### 5.1 新建文件

| 文件 | 职责 |
|------|------|
| `src/core/intent-classifier.ts` | 意图分类器 |
| `tests/core/intent-classifier.test.ts` | 意图分类器测试 |

### 5.2 修改文件

| 文件 | 改动 |
|------|------|
| `src/adapters/vector-vectra.ts` | 新增 `hybridSearch()` 方法 |
| `src/worker/handler.ts` | 新增 `hybrid.search` case |
| `src/worker/index-processor.ts` | 新增 `hybridSearch()` 方法 |
| `src/types.ts` | WorkerRequest 加 `hybrid.search`,WorkerResponse 加 `hybrid.search.result`,AgentEvent 加 `search.result` |
| `src/ports/vector.ts` | VectorSearchResult 加可选 `index?: number` 字段 |
| `src/tools/search-vault.ts` | 改调 `hybrid.search`,返回带 index 编号 |
| `src/core/context-manager.ts` | 动态系统提示词,toMessages 接受 intent 参数 |
| `src/core/agent-loop.ts` | 接入意图分类器 + 发 search.result 事件 |
| `src/ui/ChatView.svelte` | 新增 searchResults 字段 + 搜索结果卡片渲染 |

### 5.3 兼容性

- **vector.search 保留**:原 `vector.search` 协议保留,供降级场景使用(如 true Worker Threads 模式)
- **VectraStore.search() 保留**:原方法不删除,hybridSearch 是新增
- **VectorSearchResult.index 可选**:老代码不传 index 也能工作

---

## 6. 测试策略

| 组件 | 测试文件 | 测试要点 |
|------|----------|----------|
| 意图分类器 | `tests/core/intent-classifier.test.ts` | mock LLM 返回 'rag'/'direct',验证分类正确;LLM 异常时降级为 'rag' |
| VectraStore.hybridSearch | `tests/adapters/vector-vectra.test.ts` | mock LocalDocumentIndex.queryItems,验证 isBm25=true 传入且 query 非空 |
| search_vault 工具 | `tests/tools/search-vault.test.ts` | mock embedding + worker,验证返回带 index 编号且从 1 开始 |
| Worker handler | `tests/worker/handler.test.ts` | 验证 hybrid.search case 路由正确,调 processor.hybridSearch |
| ContextManager 提示词 | `tests/core/context-manager.test.ts` | 验证 intent='rag' 返回 RAG_PROMPT,intent='direct' 返回 BASE_PROMPT |
| Agent Loop 集成 | `tests/core/agent-loop.test.ts` | 验证意图分类后调 ctx.toMessages(intent),search_vault 后发 search.result 事件 |

---

## 7. 性能考量

- **意图分类器开销**:多一次 LLM 调用,但 maxTokens=5,延迟约 200-500ms。对 direct 分支节省后续搜索 + read_note 的总成本,净收益为正
- **混合搜索性能**:vectra 内置 BM25 在首次查询时需构建 BM25 索引(tokenize + consolidate),首次查询可能慢 100-300ms,后续查询走缓存
- **过度抓取**:`hybridSearch` 内部 `queryItems` 抓 `topK * 10` 个 chunk 再聚合,内存占用与原 search 持平

---

## 8. 安全与隐私

- 无新增网络调用(意图分类器用现有 LLM 端点)
- search_vault 不返回 text,不泄露库内容到工具返回值(只在 read_note 时按需读取)
- 搜索结果卡片只展示路径 + 分数,不展示内容

---

## 9. 参考

- [S-RAG-ARCH](../specs/2026-06-14-ratel-rag-architecture.md) — 最终 RAG 架构
- [原 P-W3-IMPL plan](../plans/2026-06-13-ratel-w3-implementation.md) — 被取代的旧 plan(保留作历史参考)
- [vectra LocalIndex.d.ts](file:///Users/golddream/code/git-public/Ratel-CLI/node_modules/vectra/lib/LocalIndex.d.ts) — `queryItems(vector, query, topK, filter?, isBm25?)` API
- [VectraStore 现有实现](file:///Users/golddream/code/git-public/Ratel-CLI/src/adapters/vector-vectra.ts) — chunk→doc 聚合逻辑可复用
