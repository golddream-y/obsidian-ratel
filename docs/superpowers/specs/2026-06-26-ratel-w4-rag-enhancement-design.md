# S-W4-RAG-ENHANCEMENT — W4 检索精准度增强

- **Spec ID**:S-W4-RAG-ENHANCEMENT
- **状态**:Active
- **创建日期**:2026-06-26
- **取代**:[P-W4-IMPL](../plans/2026-06-13-ratel-w4-implementation.md) 的设计假设(原 plan 基于手动 RRF + Reranker,需与 S-W3-HYBRID 的新混合搜索架构对齐)
- **所属**:S-RAG-ARCH 的 W4 切片
- **依赖**:S-W3-HYBRID 已完成(search_vault 工具 + 意图分类器 + search.result 事件)

---

## 1. 背景

W4 原 plan(P-W4-IMPL,2026-06-13)设计于架构文档重建之前,包含 Reranker + Query Rewrite + Indexer 三件套。S-W3-HYBRID 调整后需要重新对齐:

1. **混合搜索已在 W3 落地**:vectra 内置 `isBm25: true` 已启用,W4 不需要再实现 BM25
2. **RRF 在 W4 才有真实用途**:W3 是单查询混合搜索,vectra 内部融合;W4 的 Query Rewrite 产生多个变体查询,需要 RRF 把多份结果合并成一份
3. **Reranker 适配器**:S-KEYCHAIN 已把 rerankerApiKey 迁到钥匙串,settings 已有 rerankerApiBase + rerankerModel 配置项,诊断页已有 UI 占位,W4 只需实现适配器本体
4. **Indexer subagent**:独立索引子代理,与检索增强正交,保持原计划

**对齐架构文档 [retriever.md §2.3](../../architecture/rag/retriever.md) 渐进增强路径**:架构文档定义"向量 → 混合 → 重排 → 查询优化"四阶段。W3 已完成阶段 2(混合),W4 完成阶段 3(重排)和阶段 4(查询优化 — Query Rewrite)。架构文档原把 Query Rewrite 列为"远期",本 spec 提前到 W4。

---

## 2. 目标

1. **Query Rewrite**:LLM 把用户查询改写成 2-3 个语义变体,扩大召回
2. **RRF 多查询融合**:把多个变体查询的 search_vault 结果用 RRF 算法合并成一份列表
3. **Reranker**:百炼 DashScope API 对融合后的结果做精排,提升 top-K 准确度
4. **Indexer subagent**:独立索引子代理,负责全量/增量索引的编排

---

## 3. 非目标

以下已在 S-W3-HYBRID 实现,W4 不重复:

- 混合搜索(vectra `isBm25: true`)
- 意图分类器(W3 轻量版,W4 可考虑升级为完整意图路由,但非必需)
- search_vault 工具本体
- search.result 事件 + ChatView 搜索结果卡片
- 引用标记 [1][2]

以下明确不做:

- **跨语言检索**:多语言 embedding 模型选型,推迟到独立 spec
- **多模态检索**:图片/音频 embedding,推迟到独立 spec

---

## 4. 详细设计

### 4.1 Query Rewrite(`src/core/query-rewriter.ts` 新建)

**职责**:把用户查询改写成 2-3 个语义变体,扩大检索召回。

```typescript
export interface QueryRewriterDeps {
  llm: LLMClient;
}

export interface RewrittenQuery {
  text: string;
  variant: 'original' | 'rewrite-1' | 'rewrite-2';
}

/**
 * 把用户查询改写成 2-3 个语义变体。
 *
 * 关键路径:
 * - 原始查询始终保留(variant: 'original')
 * - LLM 生成 1-2 个改写变体(variant: 'rewrite-1' / 'rewrite-2')
 * - 改写提示词要求:保持原意,换用同义词/不同表述方式
 * - maxTokens 限制为 100(2 个改写 * ~50 tokens)
 * - LLM 异常时降级为只返回原始查询
 *
 * @param query - 用户原始查询
 * @returns 包含原始查询 + 改写变体的数组
 */
export async function rewriteQuery(
  query: string,
  deps: QueryRewriterDeps,
): Promise<RewrittenQuery[]>;
```

**改写提示词**:

```
把以下查询改写成 2 个语义变体,用于知识库检索扩大召回。
要求:
- 保持原意,不改变问题范围
- 换用同义词或不同表述方式
- 每行一个变体,不加编号

原始查询:{{query}}

改写变体:
```

### 4.2 RRF 多查询融合(`src/core/rrf.ts` 新建)

**职责**:把多个变体查询的搜索结果用 Reciprocal Rank Fusion 算法合并。

```typescript
export interface RankedItem {
  id: string;
  score: number;
}

export interface FusedItem {
  id: string;
  rrfScore: number;
  sourceScores: (number | undefined)[];
}

/**
 * Reciprocal Rank Fusion — 合并多个排序列表。
 *
 * 关键路径:
 * - RRF score = Σ 1/(k + rank),rank 从 0 开始
 * - 默认 k=60(Cormack et al. 2009 推荐值)
 * - 同一文档在多个列表中出现 → RRF 分数累加
 * - 按 RRF 分数降序排列,取 topK
 *
 * @param lists - 多个排序列表(每个变体查询的结果)
 * @param k - RRF 参数,默认 60
 * @param topK - 返回结果上限
 * @returns 融合后的排序列表
 */
export function reciprocalRankFusion(
  lists: RankedItem[][],
  k?: number,
  topK?: number,
): FusedItem[];
```

**W3→W4 衔接**:W3 的 VectraStore.hybridSearch 返回 `[{ docId, score, metadata }]`。W4 的 MultiQuerySearcher 对每个变体查询调 `VectraStore.hybridSearch`(经 Worker,传 `topK * 2` 过度抓取),收集多份结果,把每份结果的 `{ docId, score }` 作为 `RankedItem` 传入 RRF,融合后取 topK。注意:MultiQuerySearcher 直接调底层搜索,不调 search_vault 工具(避免循环 — search_vault 工具反过来调用 MultiQuerySearcher)。

### 4.3 多查询搜索编排(新建 `src/core/multi-query-searcher.ts`)

**决策:方案 A** — search_vault 工具对 LLM 保持 W3 单查询签名不变,内部升级为调用 `MultiQuerySearcher`。多查询 + RRF + Rerank 对 LLM 透明。

```typescript
export interface MultiQuerySearcherDeps {
  embedding: EmbeddingPort;
  workerManager: WorkerManager;
  reranker?: RerankerPort;  // W4 注入,可选
  vault: ObsidianVault;      // 供 Rerank 读取文档全文
  queryRewriter?: { rewrite: (q: string) => Promise<string[]> };  // W4 注入,可选
}

export class MultiQuerySearcher {
  /**
   * 多查询混合搜索 + RRF 融合 + 可选 Rerank 精排。
   *
   * 关键路径:
   * 1. 若 queryRewriter 可用,改写查询生成变体;否则只用原始查询
   * 2. 对每个查询做 embedding + Worker hybrid.search
   * 3. 用 RRF 融合多份结果
   * 4. 若 reranker 可用:读取 top-K 文档全文 → Rerank 精排 → 丢弃 text 返回 VectorSearchResult
   * 5. 加 index 编号返回
   *
   * @param query - 用户原始查询(单条,内部决定是否改写)
   * @param topK - 返回文档上限
   */
  async search(
    query: string,
    topK: number,
  ): Promise<VectorSearchResult[]>;
}
```

**search_vault 工具升级**(W4):execute 内部从 W3 的"单次 hybrid.search"改为调用 `MultiQuerySearcher.search(query, topK)`。LLM 调用方式不变(仍 `search_vault({ query, topK })`),但结果经过改写 + 多查询 + RRF + Rerank 精排。

### 4.4 Reranker 适配器(`src/adapters/reranker-bailian.ts` 新建 + `src/ports/reranker.ts` 新建)

**端口**(`src/ports/reranker.ts`):

```typescript
export interface RerankerPort {
  /**
   * 对查询 + 候选文档列表做精排。
   *
   * @param query - 用户查询
   * @param documents - 候选文档列表(已读取全文或摘要)
   * @param topK - 返回数量
   * @returns 精排后的文档列表(分数重新计算)
   */
  rerank(
    query: string,
    documents: Array<{ id: string; text: string }>,
    topK: number,
  ): Promise<Array<{ id: string; score: number }>>;
}
```

**百炼实现**(`src/adapters/reranker-bailian.ts`):

- 端点:`${rerankerApiBase}/rerank`(DashScope compatible-api)
- 模型:`rerankerModel`(默认 `qwen3-rerank`)
- API Key:从钥匙串 `ratel-rerank-bailian` 读取(S-KEYCHAIN 已实现 `hasRerankApiKey`/`resolveRerankApiKey`)
- 请求体:`{ model, query, documents: string[], top_n }`
- 响应体:`{ results: [{ index, relevance_score }] }`

**启用条件**(对齐架构文档 [retriever.md §3.3](../../architecture/rag/retriever.md)):`hasRerankApiKey(app) === true` 时自动启用,否则跳过 Rerank 步骤。注意:架构文档原写 `settings.rerankerApiKey` 非空,S-KEYCHAIN 已把 key 迁到 Obsidian 钥匙串(`ratel-rerank-bailian` secret),实现时用 `hasRerankApiKey(app)` 判断,不读 settings。

### 4.5 Indexer subagent(`src/subagents/indexer.ts` 新建)

**职责**:独立索引子代理,负责全量/增量索引的编排。

```typescript
export interface IndexerDeps {
  vault: ObsidianVault;
  indexController: IndexController;
}

export class Indexer {
  /**
   * 全量重建索引 — 遍历 vault 所有 markdown 文件,送 Worker 索引。
   */
  async fullReindex(): Promise<{ indexed: number; errors: number }>;

  /**
   * 增量索引 — 单文件变更后送 Worker。
   */
  async indexFile(path: string): Promise<void>;

  /**
   * 删除文件的所有 chunk。
   */
  async deleteFile(path: string): Promise<void>;
}
```

**说明**:Indexer subagent 是 Agent 机制层面的封装,让其他子代理(如 Librarian)能通过统一接口触发索引操作,不直接调 IndexController。

### 4.6 数据流(W4 完整)

```
用户消息
  ↓
[意图分类器](W3 已实现)
  ↓ intent='rag'
LLM 调 search_vault(query)
  ↓
[MultiQuerySearcher.search] 内部编排:
  ├─ Query Rewrite:LLM 生成 2-3 个变体查询
  ├─ 对每个变体:主线程 embedding + Worker hybrid.search
  ├─ RRF 融合多份结果
  ├─ 若 reranker 可用:vault.read 读取 top-K 文档全文 → 百炼 API 精排 → 丢弃 text
  └─ 加 index 编号返回
  ↓
search_vault 返回 [{ docId, score, metadata, index }]
  ↓
[search.result 事件] → ChatView 卡片(reranked 标记)
  ↓
LLM 调 read_note 读全文,引用 [1][2] 回答
```

---

## 5. 影响面

### 5.1 新建文件

| 文件 | 职责 |
|------|------|
| `src/core/query-rewriter.ts` | 查询改写 |
| `src/core/rrf.ts` | RRF 融合算法 |
| `src/core/multi-query-searcher.ts` | 多查询搜索编排 |
| `src/ports/reranker.ts` | Reranker 端口 |
| `src/adapters/reranker-bailian.ts` | 百炼 Reranker 实现 |
| `src/subagents/indexer.ts` | Indexer subagent |
| 对应测试文件(6 个) | — |

### 5.2 修改文件

| 文件 | 改动 |
|------|------|
| `src/tools/search-vault.ts` | execute 内部改为调用 MultiQuerySearcher.search(对 LLM 透明,签名不变) |
| `src/main.ts` | 注入 MultiQuerySearcher(含可选 RerankerPort + QueryRewriter)到 search_vault 工具 |
| `src/settings.ts` | Rerank 段补"未配置密钥时 Rerank 自动关闭"说明(已在 S-KEYCHAIN Minor 修复) |

### 5.3 与 W3 的衔接

- **search_vault 工具**:W3 实现单查询混合搜索;W4 内部升级为调用 MultiQuerySearcher(对 LLM 透明,签名不变)
- **search.result 事件**:W4 的 search.result payload 扩展 `reranked: boolean` 字段,标识是否经过 Rerank
- **VectorSearchResult 不扩展 text 字段**:Reranker 需要的文档全文由 MultiQuerySearcher 内部通过 `vault.read(path)` 读取,传给 Reranker 后丢弃,不进入 VectorSearchResult。保持架构文档"search_vault 只返回 docId + score + metadata"的约束

---

## 6. 测试策略

| 组件 | 测试文件 | 测试要点 |
|------|----------|----------|
| Query Rewriter | `tests/core/query-rewriter.test.ts` | mock LLM 返回改写变体,验证数量与格式;LLM 异常时降级为只返回原始查询 |
| RRF | `tests/core/rrf.test.ts` | 空输入、单列表、多列表重叠项、k 参数、topK 截断 |
| MultiQuerySearcher | `tests/core/multi-query-searcher.test.ts` | mock embedding + worker + reranker,验证 RRF 融合 + Rerank 精排流程 |
| Reranker 百炼实现 | `tests/adapters/reranker-bailian.test.ts` | mock fetch,验证请求体格式 + 响应解析;钥匙串无 key 时跳过 |
| Indexer subagent | `tests/subagents/indexer.test.ts` | mock vault + indexController,验证全量/增量/删除 |
| Agent Loop 集成 | `tests/core/agent-loop.test.ts` | 验证 search_vault(W4)调用后 search.result 事件含 `reranked` 标记 |

---

## 7. 性能考量

- **Query Rewrite 开销**:多一次 LLM 调用(maxTokens=100,延迟约 300-800ms)
- **多查询搜索开销**:N 个变体 = N 次 embedding + N 次 Worker 搜索。N=3 时约 3x 单查询延迟
- **Reranker 开销**:百炼 API 调用,延迟约 200-500ms(取决于候选数量)
- **总延迟**:W4 完整流程比 W3 多约 1-2 秒(改写 + 多查询 + Rerank),但检索准确度显著提升
- **Reranker 可选**:无 rerank key 时跳过,降级为仅 RRF 融合,延迟仅多 Query Rewrite 部分

---

## 8. 安全与隐私

- **Reranker API**:百炼 API 调用会发送查询 + 候选文档文本到阿里云。库内容只发往配置的 rerankerApiBase,与 AGENTS.md "库内容只发往配置的模型 API 端点" 一致
- **Query Rewrite**:改写查询通过现有 LLM 端点发送,无新增端点
- **Reranker key**:已通过 S-KEYCHAIN 迁到 Obsidian 钥匙串,不存 settings

---

## 9. 参考

- [S-RAG-ARCH](../specs/2026-06-14-ratel-rag-architecture.md) — 最终 RAG 架构
- [S-W3-HYBRID](2026-06-26-ratel-w3-hybrid-search-design.md) — W3 混合搜索 spec(本 spec 的前置依赖)
- [原 P-W4-IMPL plan](../plans/2026-06-13-ratel-w4-implementation.md) — 被取代的旧 plan(保留作历史参考)
- [S-KEYCHAIN 归档](../archive/S-KEYCHAIN/) — Reranker 钥匙串密钥已实现
- [vectra LocalIndex.d.ts](file:///Users/golddream/code/git-public/Ratel-CLI/node_modules/vectra/lib/LocalIndex.d.ts) — `queryItems` API
