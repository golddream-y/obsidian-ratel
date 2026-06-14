# Ratel RAG 增强路线设计

> 日期: 2026-06-13
> 状态: Approved
> 关联: ARCHITECTURE.md / 2026-06-07-architecture-feasibility-review-design.md

---

## 1. 背景

Ratel W1 已完成最小 Agent Loop + read_note 工具。W2/W3 将实现向量检索管线。本文档定义 RAG 增强的三阶段路线，确保架构不阻碍后续增强。

## 2. 当前管线（W1）

```
用户问题 → LLM 直接回答（无检索）
```

W1 没有 RAG，LLM 只能通过 `read_note` 工具按路径读笔记。

## 3. 三阶段 RAG 路线

### 阶段 1：基础检索闭环（W2-W3）

**目标：** 用户问问题，Agent 自动检索 vault 笔记并回答。

**管线：**

```
用户问题 → Embed(BGE-M3) → vectra 向量搜索(topK=20)
                            → BM25 关键词搜索(topK=20)
                            → RRF 融合 → topK=10
                            → 塞入 Context → LLM 回答
```

**包含能力：**

| 能力 | 实现方式 | 依赖 |
|---|---|---|
| 向量检索 | vectra `queryDocuments()` | Worker 线程 |
| BM25 检索 | vectra 内置 BM25 | Worker 线程 |
| RRF 融合 | `1/(k+rank)` 倒数排名融合，k=60 | 主线程 |
| Embedding 调用 | BGE-M3 via Ollama / OpenAI-compatible API | 主线程 HTTP |

**不包含：** Rerank、查询改写、HyDE、摘要索引

**架构影响：**

- `search_vault` 工具：调用 Embedding → Worker 搜索 → RRF 融合 → 返回结果
- `ContextManager`：新增 `addSearchResults(results: VectorSearchResult[])` 方法
- Worker：实现 `vector.search` 消息处理（vectra `queryDocuments`）
- 新增 Port：`EmbeddingPort { embed(texts: string[]): Promise<number[][]> }`

### 阶段 2：检索增强（W4 之后）

**目标：** 提升检索精度，解决向量召回不准的问题。

**管线：**

```
用户问题 → 查询改写(LLM) → Embed → 向量搜索(topK=50)
                                         → BM25 搜索(topK=50)
                                         → RRF 融合 → topK=20
                                         → Rerank(cross-encoder) → topK=5
                                         → 塞入 Context → LLM 回答
```

**新增能力：**

| 能力 | 实现方式 | 依赖 |
|---|---|---|
| 查询改写 | LLM 生成 2-3 个改写查询，并行检索后合并 | 主线程 LLM 调用 |
| Rerank | Ollama `bge-reranker-v2-m3`（~570MB） | 主线程 HTTP 调用 Ollama |

**查询改写设计：**

```typescript
// 在 search_vault 工具内部
async function rewriteQuery(query: string, llm: LLMClient): Promise<string[]> {
    const prompt = `将以下问题改写为 2-3 个更具体的搜索查询，每行一个：\n${query}`;
    const response = await llm.chat({
        messages: [{ role: 'user', content: prompt }],
    });
    // 解析 LLM 返回的多行查询
    return parseQueries(response);
}
```

**Rerank 设计：**

```typescript
// 新增 Port
interface Reranker {
    rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]>;
}

interface RerankResult {
    index: number;
    score: number;
    text: string;
}

// Ollama 实现
class OllamaReranker implements Reranker {
    constructor(private apiBase: string, private model: string) {}

    async rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]> {
        // 调用 Ollama /api/rerank 端点
        // 或使用 /v1/rerank (OpenAI-compatible)
    }
}
```

**架构影响：**

- 新增 `ports/reranker.ts`：Reranker Port 接口
- 新增 `adapters/reranker-ollama.ts`：Ollama reranker 实现
- `search_vault` 工具：增加查询改写 + rerank 步骤
- 设置面板：增加 Reranker 模型配置

**Rerank 方案选型：**

| 方案 | 优点 | 缺点 | 推荐 |
|---|---|---|---|
| Ollama bge-reranker | 本地运行、隐私 | 需装 Ollama、~570MB | ✅ 推荐 |
| Cohere Rerank API | 无需本地模型 | 云端、免费额度有限 | 备选 |
| ONNX Runtime | 无需 Ollama | native 模块违反零 native 约束 | ❌ 不推荐 |

### 阶段 3：高级增强（远期）

**目标：** 进一步优化检索质量和上下文利用效率。

**可选能力：**

| 能力 | 适用场景 | 实现方式 |
|---|---|---|
| HyDE | 用户问题表述模糊 | LLM 生成假设答案 → 用假设答案 embed → 检索 |
| 摘要索引 | 长笔记检索不准 | 预生成笔记摘要 → 摘要做索引 → 检索摘要再读原文 |
| 上下文压缩 | Context 超长 | 检索结果去重/压缩后再塞 Context |
| 语义分块 | 固定分块切断语义 | 基于嵌入相似度的语义分块（替代固定 500 token） |

**这些能力暂不设计细节，等阶段 1/2 跑通后根据实际痛点决定优先级。**

## 4. 架构约束（跨阶段不变）

1. **Worker 不做 HTTP** — Embedding/Rerank 调用在主线程
2. **零 native 模块** — 不用 onnxruntime-node
3. **Port 接口先行** — 每个新能力先定义 Port，再实现 Adapter
4. **渐进式** — 阶段 1 的 `search_vault` 不预留 Rerank 参数，阶段 2 扩展时加

## 5. 对现有路线图的更新

| 周 | 原里程碑 | 更新后 |
|---|---|---|
| W2 | vectra 索引 + search_vault + 嵌入调用 | 不变 |
| W3 | 混合检索 + 流式输出 + 引用标记 | 不变（BM25 混合 + RRF 融合） |
| W4+ | Subagent: Indexer | 不变，后续加查询改写 + Rerank |
| 远期 | — | HyDE / 摘要索引 / 上下文压缩 |

## 6. 风险

| 风险 | 缓解 |
|---|---|
| Ollama reranker 模型下载慢 | 首次使用提示下载，提供进度条 |
| Rerank 增加延迟 | 阶段 2 默认关闭，用户可选开启 |
| BM25 + 向量 RRF 融合参数需调 | k=60 是业界默认值，1k 笔记够用 |
| 查询改写多一次 LLM 调用 | 阶段 2 默认关闭，用户可选开启 |
