# Ratel Vault 架构可行性审查 — 设计文档

> 日期: 2026-06-07
> 状态: Approved
> 审查对象: README.md / docs/ARCHITECTURE.md / AGENTS.md

---

## 1. 审查背景

对 Ratel Vault 现有三份文档进行可行性审查，发现 **5 个硬伤 + 3 个软伤**，逐一确认修正方案后形成本文档。

## 2. 发现的问题

### 硬伤

| ID | 问题 | 影响 |
|---|---|---|
| H1 | Worker 里 sql.js WASM 加载路径无法定位 | 增量索引跑不起来 |
| H2 | Worker 里没有 fetch / XMLHttpRequest | 嵌入和 LLM 调用做不了 |
| H3 | "自建 HNSW"没有现成轮子 | W2 里程碑延期 |
| H4 | README 和 ARCHITECTURE 内部不一致 | 实施时不知道听谁的 |
| H5 | Worker 路径解析在 CJS 环境下可能不对 | Worker 加载失败 |

### 软伤

| ID | 问题 | 影响 |
|---|---|---|
| S1 | 9 个 npm scope 包在单 main.js 里没有物理隔离 | 文档误导 |
| S2 | 没有测试策略和测试框架 | TDD 流程无法落地 |
| S3 | 首扫索引时间被低估 | 用户期望管理 |

## 3. 修正决策

| 问题 | 决策 | 理由 |
|---|---|---|
| H1: sql.js WASM | **砍掉 sql.js，用 JSON (Obsidian loadData/saveData)** | 零依赖 / 不用解决 Worker 里 WASM 加载问题 |
| H2: Worker HTTP | **Worker 不做 HTTP，主线程做** | Worker 里没有 fetch，主线程有 |
| H3: 自建 HNSW | **用 vectra** | 零 native / Electron 支持 / 内置文档索引+分块+混合检索+FolderWatcher / 33k 周下载 |
| H4: 文档不一致 | **统一修正两份文档** | 单一真相源 |
| H5: Worker 路径 | **用 `path.join(__dirname, 'worker.js')`** | CJS 环境下 __dirname 可用 |
| S1: npm scope | **1 包 + 目录模块** | Obsidian 插件不需要独立发布 / 生态惯例 |
| S2: 测试 | **后续加 vitest** | 不阻塞当前设计 |
| S3: 首扫时间 | **标注 5-10 分钟（含网络抖动）** | 诚实估计 |

### 额外决策

| 问题 | 决策 | 理由 |
|---|---|---|
| Obsidian API 封装 | **ObsidianVault facade (TS)** | 可测试 / 可追踪 / 变了只改一处 / 不过度设计 |
| 向量库选型 | **vectra** (stevenic/vectra) | 零 native / Electron 支持 / 内置 LocalDocumentIndex + FolderWatcher + BM25 混合检索 |

## 4. 修正后架构

### 4.1 分层

```
┌──────────────────────────────────────────────────────────┐
│ L3 UI 层                                                  │
│   Chat 侧边栏 (Svelte ItemView)                           │
│   Ribbon 按钮 / Cmd+P 命令 / 设置面板                      │
├──────────────────────────────────────────────────────────┤
│ L2 能力原语层 (主线程)                                     │
│   Agent Loop / Context Manager / Hooks / Tools /          │
│   Subagents / LLM 调用 (HTTP 流式) /                      │
│   Embedding 调用 (HTTP) / ObsidianVault facade            │
├──────────────────────────────────────────────────────────┤
│ L1 端口适配层                                              │
│   persistence-json  (Obsidian loadData)                   │
│   vector-vectra     (vectra 封装)                          │
│   llm-deepseek      (OpenAI 兼容)                          │
│   llm-anthropic     (Claude)                               │
├──────────────────────────────────────────────────────────┤
│ L0 Worker 层 (Worker Thread)                              │
│   vectra 索引操作 (upsert/query/delete)                   │
│   文本分块 (chunkMarkdown)                                 │
│   向量计算 / 文件监听 (FolderWatcher)                      │
└──────────────────────────────────────────────────────────┘

   ┌───────────────────────────────────────────────────┐
   │  Port 接口层 (零实现, 只定义契约)                    │
   │  persistence / vector / llm                         │
   └───────────────────────────────────────────────────┘
```

### 4.2 主线程 vs Worker 分工

**主线程**:
- Agent Loop（编排）
- Context Manager
- Hooks 注册表
- LLM 调用（HTTP 流式）
- Embedding 调用（HTTP）
- ObsidianVault facade（元数据/反链/编辑器）
- Chat 侧边栏（Svelte）
- 会话持久化（JSON via loadData/saveData）

**Worker**:
- vectra 索引操作（upsert/query/delete）
- 文本分块（chunkMarkdown）
- 向量计算
- 文件监听（FolderWatcher）

### 4.3 存储层

| 层 | 内容 | 位置 | 实现 |
|---|---|---|---|
| FS | Markdown 原文 | `vault/`（用户原 vault） | 不动 |
| JSON | 会话历史 / 设置 / 钩子日志 | `data.json`（Obsidian loadData/saveData） | 零依赖 |
| vectra | 向量 + 文档索引 + 元数据 | `.obsidian/plugins/ratel-vault/index/` | vectra 文件持久化 |

### 4.4 目录结构

```
src/
  main.ts                     # 插件入口
  settings.ts                 # 设置面板
  types.ts                    # 全局类型

  core/                       # Engine
    agent-loop.ts
    context-manager.ts
    hooks.ts

  ports/                      # Port 接口（零实现）
    persistence.ts
    vector.ts
    llm.ts

  adapters/                   # Adapter 实现
    obsidian-vault.ts         # Obsidian API 薄封装 (TS)
    persistence-json.ts       # Obsidian loadData/saveData
    vector-vectra.ts          # vectra 封装
    llm-deepseek.ts           # OpenAI 兼容
    llm-anthropic.ts          # Claude

  tools/                      # Vault 工具集 (11 个)
  subagents/                  # 4 个 Subagent
  ui/                         # Svelte 视图
  worker/                     # Worker Thread
  utils/                      # 工具函数
```

### 4.5 Worker 通信协议

```typescript
// 主线程 → Worker
type WorkerRequest =
  | { type: 'index.full'; payload: { vaultPath: string } }
  | { type: 'index.incremental'; payload: { filePath: string; content: string } }
  | { type: 'index.delete'; payload: { filePath: string } }
  | { type: 'vector.search'; payload: { queryVector: number[]; topK: number; filter?: SearchFilter } }
  | { type: 'vector.upsert'; payload: { docId: string; text: string; metadata: Record<string, unknown> } }
  | { type: 'vector.delete'; payload: { docIds: string[] } }
  | { type: 'index.status'; payload: {} };

// Worker → 主线程
type WorkerResponse =
  | { type: 'index.progress'; payload: { done: number; total: number } }
  | { type: 'index.done'; payload: { indexed: number; errors: number } }
  | { type: 'vector.search.result'; payload: Array<{ docId: string; score: number; metadata: Record<string, unknown> }> }
  | { type: 'vector.upsert.done'; payload: { docId: string } }
  | { type: 'vector.delete.done'; payload: { count: number } }
  | { type: 'index.status.result'; payload: { totalDocs: number; lastIndexTime: number } }
  | { type: 'error'; payload: { code: string; message: string } };
```

### 4.6 ObsidianVault facade

薄封装，只包我们用的 ~8 个 Obsidian API。TypeScript 完整类型。

```typescript
// src/adapters/obsidian-vault.ts
export class ObsidianVault {
  constructor(private app: App) {}
  async readFile(path: string): Promise<string>
  async writeFile(path: string, content: string): Promise<void>
  getBacklinks(path: string): Map<string, unknown>
  getMetadata(path: string): CachedMetadata | null
  onFileModify(callback: (path: string) => void): () => void
  onFileCreate(callback: (path: string) => void): () => void
  onFileDelete(callback: (path: string) => void): () => void
  onFileRename(callback: (path: string, oldPath: string) => void): () => void
  listMarkdownFiles(): string[]
}
```

### 4.7 数据流（一次问答）

```
User: "我之前提过 LangChain 的哪些坑？"
   │
   ▼
[Chat 侧边栏] → Agent Loop
   │
   ├─ 加载会话历史 (loadData)
   ├─ Embedding HTTP 调用 → query 向量
   ├─ Worker: vectra.queryDocuments(query向量) → VectorHit[]
   ├─ ObsidianVault.getBacklinks() → 增强上下文
   ├─ 组装 Context
   ├─ LLM HTTP 流式调用 → 流式输出
   ├─ 遇到 tool call → 调 tool → 回到检索
   └─ 写会话 (saveData)
   │
   ▼
[Chat 侧边栏] 渲染（打字机效果 + [[引用]] 可点击跳转）
```

## 5. 技术决策表（修正后）

| 决策 | 选型 | 理由 |
|---|---|---|
| 形态 | 纯 Obsidian 插件 | 深度结合 Obsidian API，零额外部署 |
| 重活儿 | Worker Threads | 主线程零阻塞 |
| UI | Svelte 5 | 轻量、Obsidian 生态主流 |
| 向量库 | vectra | 零 native / Electron 支持 / 内置文档索引+分块+混合检索+FolderWatcher |
| 元数据 | JSON (Obsidian API) | 零依赖 / 不用解决 WASM 加载问题 |
| 嵌入模型 | BGE-M3 | 中文好、免费 |
| 聊天模型 | DeepSeek-V3 | 便宜、中文好、可切 |
| Worker HTTP | 主线程做 HTTP | Worker 里没有 fetch |
| 包结构 | 1 包 + 目录模块 | Obsidian 插件不需要独立发布 |
| Obsidian API | ObsidianVault facade (TS) | 可测试 / 可追踪 / 变了只改一处 |
| 文件监听 | Obsidian `app.vault.on()` | 比 chokidar 更准 |
| 插件分发 | BRAT | 绕开审核周期 |

## 6. 风险点（修正后）

| 风险 | 缓解 |
|---|---|
| Obsidian 插件审核周期长 | 先 BRAT，成熟后再提交 |
| vectra 在 Worker 里跑 | 纯 JS 无问题；FolderWatcher 在主线程初始化后传给 Worker |
| 增量索引边界 | path + content hash 双键 + 幂等 |
| LLM 过度链接 | 置信度阈值（>0.75）+ 用户确认 |
| vault > 10k | Worker 限速 + 后台队列 + 分批嵌入 |
| 首扫时间 | 1k 笔记 ≈ 5-10 分钟，后台执行不阻塞 |
| data.json 膨胀 | 会话历史只保留最近 N 条 + 摘要压缩 |

## 7. 路线图（修正后）

| 周 | 里程碑 | 用户能用上 |
|---|---|---|
| W1 | 最小 Agent Loop + read_note + Worker 骨架 + ObsidianVault facade | 侧边栏能问「X 是啥」 |
| W2 | vectra 索引 + search_vault + 嵌入调用 | 搜 vault，召回可信 |
| W3 | 混合检索 + 流式输出 + 引用标记 | 问答体验闭环 |
| W4 | Subagent: Indexer 后台增量 | 写笔记自动重嵌 |
| W5 | Hooks: pre-write + post-write | 命名规范、自动补链 |
| W6 | Subagent: Librarian（语义链接） | 链接带类型 + 摘要 |
| W7 | Subagent: Curator（主动整理） | 每周报告 |
| W8 | 设置面板 + 索引健康面板 + 打磨 | 可日常使用 |
