# Ratel RAG 架构技术文档

> 日期: 2026-06-14
> 状态: Active
> 关联: ARCHITECTURE.md / 2026-06-13-rag-enhancement-roadmap-design.md / 2026-06-13-model-config-and-local-inference-design.md

---

## 1. 概述

Ratel 的 RAG（Retrieval-Augmented Generation）系统是插件的核心知识检索能力。本文档描述从知识预处理到最终检索回答的完整技术架构。

**设计原则：**

- 零配置可用 — 本地 Embedding 开箱即用，无需 API Key
- 渐进增强 — 每个增强步骤都是可选的，不配就不走
- 零 native 模块 — 纯 JS + WASM，不违反 Obsidian 插件约束
- Worker 隔离 — CPU 密集任务在 Worker 线程，HTTP 调用在主线程

---

## 2. 端到端数据流

### 2.1 索引流程（知识预处理）

```
┌─────────────────────────────────────────────────────────────────┐
│                        Indexer Subagent                         │
│                                                                 │
│  Obsidian Vault ──→ listMarkdownFiles() ──→ readFile(path)     │
│                                                                 │
│  Markdown Content                                               │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────┐    Worker Thread (CPU-intensive)               │
│  │   Chunker   │    chunkMarkdown(content, 500, 100)            │
│  │             │    → Chunk[] {text, index, startOffset, ...}   │
│  └─────┬───────┘                                               │
│        │                                                        │
│        ▼                                                        │
│  ┌─────────────┐    Main Thread (HTTP / WASM)                   │
│  │  Embedding  │    embed(chunks.map(c => c.text))              │
│  │  Port       │    → number[][] (vectors)                      │
│  └─────┬───────┘                                               │
│        │                                                        │
│        ▼                                                        │
│  ┌─────────────┐    Worker Thread                               │
│  │  VectraStore│    upsert(docId, text, vector, metadata)       │
│  │  (vectra)   │    → LocalDocumentIndex 持久化                  │
│  └─────────────┘                                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**关键约束：**

| 约束 | 原因 |
|---|---|
| Embedding 在主线程调用 | Worker 不做 HTTP，不做 WASM 初始化 |
| 向量存储在 Worker 线程 | vectra 是 CPU 密集操作 |
| 分块在 Worker 线程 | 纯计算，无 IO |
| 索引数据存于 `.obsidian/plugins/ratel-vault/` | 随 vault 移动 |

### 2.2 检索流程（用户查询）

```
┌──────────────────────────────────────────────────────────────────────┐
│                     search_vault Tool                                │
│                                                                      │
│  用户问题 (query)                                                    │
│       │                                                              │
│       ▼                                                              │
│  ┌──────────────┐  (可选, W4+)                                       │
│  │ Query Rewrite │  LLM 生成 2-3 个改写查询                           │
│  │  (LLM chat)  │  → queries: string[]                               │
│  └──────┬───────┘                                                    │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────┐  Main Thread                                       │
│  │   Embedding   │  embed(queries)                                   │
│  │    Port       │  → queryVectors: number[][]                       │
│  └──────┬───────┘                                                    │
│         │                                                            │
│         ├─────────────────────┐                                      │
│         ▼                     ▼                                      │
│  ┌─────────────┐    ┌──────────────┐   Worker Thread                 │
│  │   Vector     │    │    BM25      │                                 │
│  │   Search     │    │   Search     │                                 │
│  │ (cosine sim) │    │ (keyword)    │                                 │
│  │  topK=20     │    │  topK=20     │                                 │
│  └──────┬──────┘    └──────┬───────┘                                 │
│         │                  │                                         │
│         ▼                  ▼                                         │
│  ┌────────────────────────────────────┐                              │
│  │         RRF Fusion (k=60)          │  Main Thread                 │
│  │  score = Σ 1/(k + rank_i)          │                              │
│  │  → fused results, topK=10          │                              │
│  └──────────────┬─────────────────────┘                              │
│                 │                                                    │
│                 ▼                                                    │
│  ┌──────────────┐  (可选, W4+)                                       │
│  │   Reranker    │  外部 API (Cohere/Jina/SiliconFlow)               │
│  │  (API only)  │  rerank(query, docs, topK) → topK=5               │
│  └──────┬───────┘                                                    │
│         │                                                            │
│         ▼                                                            │
│  ContextManager.addSearchResults(results)                            │
│         │                                                            │
│         ▼                                                            │
│  Agent Loop → LLM 回答 (带 [1][2] 引用标记)                          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. 知识预处理

### 3.1 Markdown 分块 (Chunker)

**位置：** `src/worker/chunker.ts`

**策略：** 三级分块优先级

```
1. Heading 边界 (# ## ###)
   ↓ 超过 chunkSize 时
2. 段落边界 (\n\n)
   ↓ 仍然超长时
3. 句子边界 (。 . )
   ↓ 仍然超长时
4. 强制切分 (chunkSize)
```

**参数：**

| 参数 | 默认值 | 说明 |
|---|---|---|
| `chunkSize` | 500 | 目标分块大小（字符数） |
| `chunkOverlap` | 100 | 分块间重叠（字符数） |

**输出：**

```typescript
interface Chunk {
  text: string;        // 分块文本
  index: number;       // 分块序号
  startOffset: number; // 原文起始偏移
  endOffset: number;   // 原文结束偏移
}
```

**docId 命名规则：** `{filePath}#chunk-{index}`，例如 `notes/LangChain.md#chunk-0`

### 3.2 Embedding

**位置：** `src/ports/embedding.ts` (Port) + `src/adapters/embedding-*.ts` (Adapter)

**双模式架构：**

```
EmbeddingPort (interface)
    ├── EmbeddingLocal  ← @huggingface/transformers ONNX WASM
    │   默认: Xenova/bge-small-zh-v1.5 (~90MB, 512维, 中文优先)
    │   零配置，首次使用自动下载模型到 .cache/huggingface/
    │
    └── EmbeddingApi    ← OpenAI-compatible /v1/embeddings
        通用: Ollama / SiliconFlow / OpenAI / 任何兼容端点
        默认模型: bge-m3 (1024维)
```

**模式选择逻辑：**

```typescript
// main.ts
if (settings.embedProvider === 'local') {
  embedding = new EmbeddingLocal(settings.embedLocalModel, 512);
} else {
  embedding = new EmbeddingApi({
    apiBase: settings.embedApiBase,
    apiKey: settings.embedApiKey,
    model: settings.embedApiModel,
    dimensions: 1024,
  });
}
```

**维度不一致处理：** 切换 Provider 时（local 512维 ↔ API 1024维），需要重建索引。设置面板应提示用户。

**EmbeddingLocal 实现要点：**

- 懒初始化：首次 `embed()` 调用时才加载 pipeline
- 8-bit 量化 (`dtype: 'q8'`)：模型体积 ~90MB
- 下载进度：通过 `progress_callback` 通知用户
- 缓存：`@huggingface/transformers` 自动缓存到 `.cache/huggingface/`

### 3.3 向量存储 (VectraStore)

**位置：** `src/adapters/vector-vectra.ts` (主线程适配器) + Worker 内部使用

**底层：** vectra `LocalDocumentIndex`

**存储路径：** `.obsidian/plugins/ratel-vault/index/`

**能力：**

| 操作 | 方法 | 线程 |
|---|---|---|
| 插入/更新 | `upsert(docId, text, metadata)` | Worker |
| 向量搜索 | `queryDocuments(queryVector, topK)` | Worker |
| BM25 搜索 | `queryDocuments(queryText, topK)` | Worker |
| 删除 | `deleteDocument(docId)` | Worker |
| 状态 | `getIndexStats()` | Worker |

**metadata 结构：**

```typescript
{
  path: string;        // 原始文件路径
  chunkIndex: number;  // 分块序号
  startOffset: number; // 原文偏移
  endOffset: number;
  hash: string;        // 内容哈希 (用于增量索引)
}
```

---

## 4. 检索管线

### 4.1 向量检索 (Vector Search)

**原理：** 余弦相似度 (Cosine Similarity)

```
query → embed(query) → queryVector
queryVector vs. 所有文档向量 → cosine similarity → topK=20
```

**vectra 实现：** `LocalDocumentIndex.queryDocuments(queryVector, topK)`

**输出：**

```typescript
interface VectorSearchResult {
  docId: string;
  score: number;       // cosine similarity, 0~1
  text: string;        // 分块原文
  metadata: Record<string, unknown>;
}
```

### 4.2 BM25 检索 (Keyword Search)

**原理：** BM25 关键词匹配，适合精确术语搜索

```
query → 分词 → BM25 打分 → topK=20
```

**vectra 实现：** `LocalDocumentIndex.queryDocuments(queryText, topK)` (文本模式)

**输出：**

```typescript
interface BM25SearchResult {
  docId: string;
  score: number;       // BM25 分数
  text: string;
  metadata: Record<string, unknown>;
}
```

### 4.3 RRF 融合 (Reciprocal Rank Fusion)

**位置：** `src/core/rrf.ts`

**原理：** 将向量检索和 BM25 检索的排名融合为一个统一排序

```
RRF_score(d) = Σ_{i=1}^{N} 1/(k + rank_i(d))
```

- `k = 60`（Cormack et al. 2009 推荐值）
- `N` = 检索列表数量（当前为 2：向量 + BM25）
- `rank_i(d)` = 文档 d 在第 i 个列表中的排名（0-based）

**示例：**

| 文档 | 向量排名 | BM25排名 | RRF Score |
|---|---|---|---|
| doc1 | 0 | 1 | 1/60 + 1/61 = 0.0328 |
| doc2 | 1 | 0 | 1/61 + 1/60 = 0.0328 |
| doc3 | 2 | — | 1/62 = 0.0161 |
| doc4 | — | 2 | 1/62 = 0.0161 |

**实现：**

```typescript
function reciprocalRankFusion(
  lists: RankedItem[][],
  k = 60,
  topK?: number,
): FusedItem[]
```

**去重：** 同一 docId 在两个列表中出现时，RRF 分数叠加，排名更高。

### 4.4 查询改写 (Query Rewrite, 可选)

**位置：** `src/core/query-rewrite.ts`

**原理：** 用 LLM 将用户问题改写为 2-3 个不同角度的搜索查询，扩大召回

```
用户问题 → LLM → 2-3 个改写查询
每个查询独立检索 → 合并去重 → RRF 融合
```

**触发条件：** `settings.queryRewriteEnabled === true`

**Prompt：**

```
You are a search query optimizer. Given a user's question,
generate 2-3 alternative search queries that would help find
relevant information. Each query should focus on a different
aspect or use different terminology.

Output format: one query per line, no numbering, no explanation.
```

**代价：** 每次搜索增加一次 LLM 调用

### 4.5 Rerank (可选)

**位置：** `src/ports/reranker.ts` (Port) + `src/adapters/reranker-api.ts` (Adapter)

**原理：** Cross-encoder 对 query-document 对重新打分，精度高于双塔模型

```
RRF 融合结果 topK=20 → Rerank API → topK=5
```

**触发条件：** `settings.rerankerApiKey` 非空（配了就用，无需开关）

**支持的 Provider：**

| Provider | API Base | 模型 |
|---|---|---|
| Cohere | `https://api.cohere.ai/v1` | `rerank-v3.5` |
| Jina | `https://api.jina.ai/v1` | `jina-reranker-v2` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `BAAI/bge-reranker-v2-m3` |
| Custom | 用户自定义 | 用户自定义 |

**不做本地 Rerank 的原因：**
- bge-reranker ONNX ~420MB，运行时内存 500-800MB
- 对 Obsidian 用户太重，Rerank 本身是可选增强
- 外部 API 按需调用，不占本地资源

---

## 5. 完整管线配置矩阵

| 配置 | 向量检索 | BM25 | RRF | 查询改写 | Rerank | 阶段 |
|---|---|---|---|---|---|---|
| 最小 (W3) | ✅ | ✅ | ✅ | ❌ | ❌ | 阶段1 |
| +查询改写 (W4+) | ✅ | ✅ | ✅ | ✅ | ❌ | 阶段2 |
| +Rerank (W4+) | ✅ | ✅ | ✅ | ✅/❌ | ✅ | 阶段2 |
| 完整 | ✅ | ✅ | ✅ | ✅ | ✅ | 阶段2 |

**配置规则：**
- 向量检索 + BM25 + RRF：始终启用（W3 起）
- 查询改写：`queryRewriteEnabled` 开关控制
- Rerank：`rerankerApiKey` 非空即启用，无需额外开关

---

## 6. 线程模型

```
┌─────────────────────────────────────────────────────┐
│                    Main Thread                       │
│                                                     │
│  Plugin (onload)                                    │
│    ├── EmbeddingPort.embed()  ← HTTP / WASM         │
│    ├── RerankerPort.rerank()  ← HTTP                │
│    ├── LLMClient.chat()       ← HTTP                │
│    ├── Agent Loop                                    │
│    ├── Context Manager                               │
│    ├── Tool Registry                                 │
│    └── WorkerManager.request() ← postMessage        │
│              │                                      │
│              │ postMessage (typed)                   │
│              ▼                                      │
│  ┌─────────────────────────────────────┐            │
│  │          Worker Thread              │            │
│  │                                     │            │
│  │  chunkMarkdown()   ← CPU-intensive  │            │
│  │  vectra upsert     ← CPU-intensive  │            │
│  │  vectra search     ← CPU-intensive  │            │
│  │  vectra BM25       ← CPU-intensive  │            │
│  │                                     │            │
│  │  ❌ 不做 HTTP                        │            │
│  │  ❌ 不导入 obsidian                  │            │
│  └─────────────────────────────────────┘            │
│                                                     │
└─────────────────────────────────────────────────────┘
```

**通信协议：** `WorkerRequest` → `WorkerResponse`，通过 `WorkerManager` 封装为 Promise API

```typescript
// 请求类型
type WorkerRequest =
  | { type: 'vector.search'; payload: { queryVector: number[]; topK: number } }
  | { type: 'bm25.search'; payload: { query: string; topK: number } }
  | { type: 'vector.upsert'; payload: { docId: string; text: string; metadata: Record<string, unknown> } }
  | { type: 'vector.delete'; payload: { docIds: string[] } }
  | { type: 'index.full'; payload: { vaultPath: string } }
  | { type: 'index.status'; payload: {} };

// 响应类型
type WorkerResponse =
  | { type: 'vector.search.result'; payload: VectorSearchResult[] }
  | { type: 'bm25.search.result'; payload: BM25SearchResult[] }
  | { type: 'vector.upsert.done'; payload: { docId: string } }
  | { type: 'vector.delete.done'; payload: { count: number } }
  | { type: 'index.status.result'; payload: { totalDocs: number; lastIndexTime: number } }
  | { type: 'error'; payload: { code: string; message: string } };
```

---

## 7. Port / Adapter 架构

```
ports/                    ← 零实现接口
  ├── embedding.ts        EmbeddingPort { embed(), dimensions, modelId }
  ├── reranker.ts         RerankerPort { rerank(), modelId }
  ├── vector.ts           VectorStore { upsert(), search(), delete(), status() }
  └── llm.ts             LLMClient { chat(), countTokens() }

adapters/                 ← 具体实现
  ├── embedding-local.ts  EmbeddingPort ← @huggingface/transformers ONNX
  ├── embedding-api.ts    EmbeddingPort ← OpenAI-compatible /v1/embeddings
  ├── reranker-api.ts     RerankerPort  ← Cohere/Jina/SiliconFlow /rerank
  ├── vector-vectra.ts    VectorStore   ← vectra LocalDocumentIndex
  └── llm-deepseek.ts     LLMClient     ← DeepSeek / OpenAI-compatible
```

**依赖方向：** `adapters → ports`，`core → ports`，`tools → ports + core`

---

## 8. 索引生命周期

### 8.1 全量索引

```
触发: 用户手动 "Index vault" 命令
流程:
  1. vault.listMarkdownFiles() → paths[]
  2. for each path:
     a. vault.readFile(path) → content
     b. chunkMarkdown(content) → chunks
     c. embedding.embed(chunks.map(c => c.text)) → vectors
     d. workerManager.request({ type: 'vector.upsert', ... })
  3. Notice("Indexed N chunks")
```

### 8.2 增量索引

```
触发: 文件 create/modify/delete 事件
流程:
  - create/modify: 同全量索引的单文件流程
  - delete: workerManager.request({ type: 'vector.delete', docIds: [path] })
```

**去重策略：** 每个 chunk 的 docId = `{path}#chunk-{index}`，upsert 时先删后插。

**哈希校验：** metadata 中存 `hash: hashString(chunk.text)`，可用于跳过未变更的 chunk（W4+ 优化）。

### 8.3 索引存储

```
.obsidian/plugins/ratel-vault/
  ├── main.js
  ├── worker.js
  ├── manifest.json
  ├── styles.css
  ├── data.json              ← settings (含 API Keys)
  └── index/                 ← vectra 索引目录
      ├── index.json         ← 文档元数据
      └── items/             ← 向量 + 文本
          ├── doc1.json
          └── ...
```

---

## 9. 性能考量

### 9.1 Embedding 性能

| 模式 | 首次 | 后续 | 批量 (10 chunks) |
|---|---|---|---|
| Local (bge-small-zh) | ~90MB 下载 + ~5s 初始化 | ~100ms/chunk | ~500ms/batch |
| API (bge-m3 via Ollama) | 即时 | ~50ms/chunk | ~200ms/batch |
| API (云端) | 即时 | ~100ms/chunk (含网络) | ~300ms/batch |

### 9.2 检索性能

| 操作 | 1k 文档 | 5k 文档 | 10k 文档 |
|---|---|---|---|
| 向量搜索 | ~10ms | ~50ms | ~100ms |
| BM25 搜索 | ~5ms | ~20ms | ~50ms |
| RRF 融合 | <1ms | <1ms | <1ms |
| Rerank (API) | ~200ms | ~500ms | ~1s |

### 9.3 优化策略

- **批量 Embedding：** Indexer 每批 10 个 chunk 调用一次 embed()
- **并行检索：** 向量搜索和 BM25 搜索并行执行 (Promise.all)
- **懒初始化：** EmbeddingLocal pipeline 首次调用时才加载
- **增量索引：** 文件变更时只索引变更文件

---

## 10. 安全与隐私

| 原则 | 实现 |
|---|---|
| 默认本地 | Embedding 默认用本地 ONNX，无需网络 |
| 最小网络 | 仅模型 API 调用走网络，无遥测无数据收集 |
| API Key 安全 | password input 存储，Obsidian data.json 加密 |
| 数据不出 vault | 索引数据存于 `.obsidian/plugins/ratel-vault/` |
| 可选外部 | Rerank / API Embedding 均为可选，不配不调用 |

---

## 11. 远期增强 (Phase 3)

以下能力暂不实现，待 Phase 1/2 跑通后根据实际痛点决定优先级：

| 能力 | 适用场景 | 实现思路 |
|---|---|---|
| HyDE | 用户问题表述模糊 | LLM 生成假设答案 → embed 假设答案 → 检索 |
| 摘要索引 | 长笔记检索不准 | 预生成笔记摘要 → 摘要做索引 → 检索摘要再读原文 |
| 上下文压缩 | Context 超长 | 检索结果去重/压缩后再塞 Context |
| 语义分块 | 固定分块切断语义 | 基于嵌入相似度的语义分块（替代固定 500 token） |
