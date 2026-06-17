# S-RAG-LOOP — RAG 最小可用闭环

> 日期: 2026-06-15
> 状态: Active
> 关联: S-INIT-INDEX(已完成) / S-RAG-ARCH(架构总文档) / P-W3-IMPL(BM25+RRF,后续)

---

## 1. 背景

S-INIT-INDEX 完成了 9 个 task group,所有组件(ModelManager / IndexManager / IndexController / FolderWatcher / EmbeddingLocal / Worker IndexProcessor)均已实现且测试通过(176/176)。但 **main.ts 没有接入这些组件**,用户开 vault 后:
- 模型不会自动下载
- 索引不会自动构建
- 没有搜索工具可用
- LLM 无法基于 vault 内容回答

本 spec 补齐「开 vault → 自动索引 → RAG 问答」的最小闭环。

## 2. 目标

1. **main.ts 接入层**:onLayoutReady 后自动下载模型 → 注入 embeddings → 启动索引
2. **search_vault 工具**:Agent Loop 可调用向量搜索,返回 docId + score + metadata
3. **上下文注入**:ContextManager 支持注入搜索结果,LLM 能基于 vault 内容回答
4. **RAG 系统提示词**:告诉 LLM 如何使用 search_vault + read_note

## 3. 非目标

- BM25 检索 / RRF 融合 / 引用标记 — 属于 P-W3-IMPL 范围
- IndexBanner UI 真正工作 — 独立 UI 任务
- 设置面板模型选择下拉 — 独立 UI 任务
- Query Rewrite / Reranker — 远期增强(S-RAG-ARCH Phase 2)

## 4. 详细设计

### 4.1 main.ts 接入层

**时序**:

```
onload()
  ├─ loadSettings()
  ├─ 构造 ModelManager(downloader, diskChecker)
  ├─ 构造 EmbeddingLocal(settings)
  ├─ 构造 VectraStore(indexDir, { autoInit: false })  // Worker 内 init
  ├─ 构造 WorkerManager → 启动 Worker
  ├─ 构造 IndexController(vectraStore, workerManager, vault)
  ├─ 构造 ToolRegistry → 注册 search_vault + read_note 等工具
  ├─ registerView / registerCommand
  │
  └─ onLayoutReady()
       ├─ modelManager.download(settings.embedLocalModel)
       │    ├─ Checking → Downloading → Ready
       │    └─ 失败 → Notice("模型下载失败: ...")
       │
       └─ Model:Ready 后:
            ├─ extractor = modelManager.getExtractor()
            ├─ embeddingLocal.setExtractor(extractor)  // 注入桥
            ├─ workerManager.postMessage('init', { indexDir, embeddings: extractor })
            └─ indexController.start()  // 全量索引 + FolderWatcher
```

**关键约束**:
- `VectraStore` 构造时 `autoInit: false` — Worker 内 init,主线程不碰索引文件
- `ModelManager` 在 `onLayoutReady` 后才启动 — 避免阻塞 Obsidian 启动
- `setExtractor` 桥:ModelManager Ready 后把 extractor 注入 EmbeddingLocal,search_vault 查询时复用同一实例
- 模型下载失败时:IndexBanner 显示 Failed 状态,不阻塞其他功能

### 4.2 search_vault 工具

**职责单一**:只做向量搜索,返回 docId + score + metadata,不返回 chunk 原文。

**调用路径**:

```
Agent Loop → search_vault.execute({ query, topK })
  ├─ 主线程: embeddingLocal.embed(query) → queryVector  (ms 级,不卡 UI)
  ├─ WorkerManager.postMessage('vector.search', { queryVector, topK })
  ├─ Worker: IndexProcessor.vectorSearch(queryVector, topK) → results
  └─ 回主线程: VectorSearchResult[] (docId, score, metadata)
```

**工具定义**:

```typescript
{
  name: 'search_vault',
  description: '在知识库中搜索与查询相关的文档。返回文档路径和相关性分数,用 read_note 读取内容。',
  parameters: {
    query: { type: 'string', description: '搜索查询' },
    topK: { type: 'number', description: '返回结果数,默认 5', default: 5 },
  },
}
```

**返回格式**:

```typescript
interface SearchVaultResult {
  docId: string;     // "notes/project.md#chunk-0"
  score: number;     // cosine similarity 0~1
  metadata: {
    path: string;       // "notes/project.md"
    chunkIndex: number; // 0
  };
}
```

**设计决策**:
- search 和 get content 拆开 — search_vault 只返回轻量元数据,模型自主决定用 read_note 读哪些
- 查询 embed 在主线程(ms 级,不卡 UI);搜索走 Worker(读索引文件,避免主线程 IO)
- 索引和查询的 embed 模型一致性:通过同一个 EmbeddingsModel 实例注入保证

### 4.3 ContextManager 扩展

**新增方法**:

```typescript
addSearchResults(results: { path: string; content: string }[]): void
```

**格式化输出**(插入 context):

```
--- 知识库检索结果 ---
[1] notes/project.md
项目使用 TypeScript + esbuild 构建...

[2] notes/架构.md
三层架构:主线程 / Worker / UI...
```

**插入位置**:system prompt 之后、用户消息之前

**幂等性**:多次调用追加,不覆盖

### 4.4 RAG 系统提示词

追加到现有 system prompt:

```
你可以使用 search_vault 工具搜索用户知识库中的笔记。
当用户的问题可能涉及 vault 中的内容时,先搜索再回答。
搜索返回文档路径和相关性分数,你需要用 read_note 读取感兴趣的文档内容。
基于文档内容回答时,请标注来源笔记路径。
如果搜索结果不足以回答问题,请如实说明。
```

### 4.5 esbuild 修复

`esbuild.config.mjs` 加 `conditions: ['browser']`,修复 Svelte 5 mount 解析到 server runtime 的问题。

## 5. 与 S-RAG-ARCH 架构偏差

| S-RAG-ARCH 描述 | 实际实现(S-INIT-INDEX) | 影响 |
|---|---|---|
| 索引时:主线程 embed → Worker upsert | Worker 内 VectraStore 自己 embed(vectra 内部调 `createEmbeddings`) | 无功能影响;查询时主线程 embed,索引时 Worker embed,同一模型实例保证一致性 |
| 检索时:向量 + BM25 + RRF | 仅向量检索 | BM25/RRF 留给 P-W3-IMPL |
| 引用标记 `[1][2]` | 仅标注笔记路径 | 引用标记留给 P-W3-IMPL |

## 6. 影响面

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/main.ts` | 修改 | 加 ModelManager / IndexController / setExtractor 桥 / onLayoutReady |
| `src/tools/search-vault.ts` | 新增 | search_vault 工具实现 |
| `src/core/context-manager.ts` | 修改 | 加 addSearchResults() |
| `src/core/tool-registry.ts` | 修改 | 注册 search_vault |
| `src/adapters/embedding-local.ts` | 可能修改 | 确保 embed() 可被 search_vault 调用 |
| `src/worker/handler.ts` | 可能修改 | 确保 vector.search case 正确 |
| `esbuild.config.mjs` | 修改 | 加 conditions: ['browser'] |
| `src/types.ts` | 可能修改 | WorkerRequest 加 vector.search 类型(如果还没有) |

## 7. 测试策略

- **main.ts 接入层**:mock ModelManager / IndexController,验证 onLayoutReady 时序
- **search_vault 工具**:mock WorkerManager,验证 embed → postMessage → 返回结果链路
- **ContextManager.addSearchResults**:验证格式化输出和插入位置
- **集成测试**:onload → 模型 Ready → 索引 → search_vault → read_note → 回答

## 8. 参考

- S-INIT-INDEX spec: `docs/superpowers/specs/2026-06-15-ratel-init-index-design.md`
- S-RAG-ARCH 架构文档: `docs/superpowers/specs/2026-06-14-ratel-rag-architecture.md`
- P-W3-IMPL plan: `docs/superpowers/plans/2026-06-13-ratel-w3-implementation.md`
