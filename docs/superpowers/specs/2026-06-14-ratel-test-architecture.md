# Ratel 测试架构设计 — 按功能维度的完成标准

> 日期: 2026-06-14
> 状态: Active
> 关联: 2026-06-14-ratel-rag-architecture.md

---

## 1. 功能维度总览

```
                    ┌─────────────┐
                    │   Settings   │ ← 配置中枢
                    └──────┬──────┘
                           │ 所有维度读取配置
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │     RAG      │ │    Chat     │ │   Worker    │
    │ 索引/检索/嵌入│ │ 对话/流式   │ │ 线程/消息   │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │    Tools     │ │   Hooks     │ │     UI      │
    │ 工具注册/执行│ │ 写入治理    │ │ ChatView    │
    └─────────────┘ └─────────────┘ └─────────────┘
                           │
                    ┌──────┴──────┐
                    │Infrastructure│
                    │ 持久化/类型  │
                    └─────────────┘
```

**8 个功能维度：**

| # | 维度 | 核心职责 | 源文件 |
|---|---|---|---|
| 1 | RAG | 索引、嵌入、分块、向量存储、检索 | chunker, embedding-*, vector-vectra, ports/embedding, ports/vector |
| 2 | Chat | Agent Loop、上下文管理、流式输出、引用 | agent-loop, context-manager, llm-deepseek, ports/llm |
| 3 | Settings | 配置接口、设置面板、迁移、默认值 | settings |
| 4 | Tools | 工具注册、执行、readOnly 标记 | tool-registry, read-note, ports/vault |
| 5 | Worker | 线程管理、消息调度、超时 | worker/manager, worker/index |
| 6 | Hooks | 写入前/后钩子、治理规则 | hooks |
| 7 | UI | ChatView、Svelte 组件、交互 | ChatView.ts, ChatView.svelte |
| 8 | Infrastructure | 持久化、哈希、类型定义 | persistence-json, hash, types, ports/persistence |

---

## 2. 测试层级定义

每个维度的测试分三层：

| 层级 | 名称 | 目的 | 运行环境 | 速度 |
|---|---|---|---|---|
| L1 | **单元测试** | 验证单个函数/类的行为 | vitest (Node.js) | <10ms/test |
| L2 | **集成测试** | 验证模块间协作 | vitest (Node.js) | <100ms/test |
| L3 | **E2E 测试** | 验证用户可见的端到端行为 | Obsidian 运行时 | 手动/自动化 |

**原则：**
- L1 覆盖所有逻辑分支，mock 外部依赖
- L2 使用真实依赖（真实 vectra、真实 persistence），仅 mock 网络
- L3 在 Obsidian 中手动验证，或用 Obsidian API mock 框架

---

## 3. 各维度完成标准

### 3.1 RAG 维度

**完成标准：** 用户笔记从创建到可检索的全链路可验证

| 测试项 | 层级 | 当前状态 | 完成标准 |
|---|---|---|---|
| chunkMarkdown — 标题/段落/句子/CJK 分块 | L1 | ✅ 10 tests | 全部通过 |
| chunkMarkdown — 空输入/超长输入/边界值 | L1 | ✅ 已覆盖 | 全部通过 |
| chunkMarkdown — Unicode emoji / 代码块 / frontmatter | L1 | ✅ 3 tests | 全部通过 |
| EmbeddingApi — 正常请求/API Key/错误/空输入 | L1 | ✅ 5 tests | 全部通过 |
| EmbeddingApi — 维度校验(不匹配抛错 / 匹配通过) | L1 | ✅ 2 tests | 全部通过 |
| EmbeddingLocal — 初始化/embed/复用 pipeline | L1 | ✅ 5 tests (mock) | 全部通过 |
| EmbeddingLocal — 真实模型加载+推理 | L2 | ❌ 未覆盖 | 至少 1 个真实推理测试 |
| VectraStore — upsert/search/delete/status | L1 | ✅ 4 tests | 全部通过 |
| VectraStore — 重复 upsert 去重 | L1 | ✅ 1 test | 全部通过 |
| VectraStore — 空索引搜索 / 空索引 status | L1 | ✅ 2 tests | 全部通过 |
| Embed → Upsert → Search 端到端 | L2 | ✅ 1 test | 全部通过 |
| 切换 embedProvider 后维度不匹配 | L2 | ✅ 1 test (EmbeddingApi 早失败) | 全部通过 |
| Worker 向量搜索 + BM25 搜索 | L2 | ❌ 未覆盖 | Worker 收到请求返回正确结果 |

**L2 集成测试关键路径：**
```
Markdown → chunkMarkdown → EmbeddingLocal.embed → VectraStore.upsert → VectraStore.search → 验证 top1 是原文
```

**完成阈值：** L1 100% 通过 + L2 至少 3 个集成测试通过

---

### 3.2 Chat 维度

**完成标准：** 用户消息到 AI 回答的完整对话流可验证

| 测试项 | 层级 | 当前状态 | 完成标准 |
|---|---|---|---|
| agentLoop — 简单回复 | L1 | ✅ | 通过 |
| agentLoop — 工具调用 | L1 | ✅ | 通过 |
| agentLoop — MAX_STEPS 限制 | L1 | ✅ | 通过 |
| agentLoop — 工具执行错误 | L1 | ✅ | 通过 |
| agentLoop — readOnly 不触发 write hooks | L1 | ✅ | 通过 |
| agentLoop — 非 readOnly 触发 write hooks | L1 | ✅ | 通过 |
| agentLoop — LLM 流中途错误 + session 保存 | L1 | ❌ | 验证 finally 中 ctx.save() 被调用 |
| agentLoop — 多轮工具调用（2+ steps） | L1 | ❌ | 验证 context 正确累积 |
| ContextManager — load/add/save 完整流程 | L1 | ✅ | 通过 |
| ContextManager — 未 load 就操作 | L1 | ❌ | 验证抛出明确错误 |
| ContextManager — tokenCount 估算 | L1 | ✅ | 通过 |
| DeepSeekLLM — chat 流式输出 | L1 | ✅ (mock) | 通过 |
| DeepSeekLLM — buildRequestBody 序列化 | L1 | ✅ | 通过 |
| DeepSeekLLM — toolArgs 序列化 | L1 | ✅ | 通过 |
| DeepSeekLLM — SSE 格式异常/网络中断 | L1 | ❌ | 验证错误恢复 |
| DeepSeekLLM — 多 tool_calls 同一响应 | L1 | ❌ | 验证多个 toolCall 正确解析 |
| Agent Loop + Tool + Hook 集成 | L2 | ❌ | 完整对话流：消息→工具→hook→回复 |

**L2 集成测试关键路径：**
```
User message → agentLoop → LLM stream → tool call → tool result → LLM reply → 验证完整事件序列
```

**完成阈值：** L1 100% 通过 + L2 至少 1 个完整对话流测试通过

---

### 3.3 Settings 维度

**完成标准：** 配置变更正确传播到所有依赖模块

| 测试项 | 层级 | 当前状态 | 完成标准 |
|---|---|---|---|
| DEFAULT_SETTINGS 完整性 | L1 | ❌ | 验证所有字段有默认值 |
| 旧版设置迁移 (embedModel → embedProvider) | L1 | ❌ | Object.assign 后新字段有值、旧字段不残留 |
| embedProvider 切换 → 正确 adapter 创建 | L2 | ❌ | local → EmbeddingLocal, api → EmbeddingApi |
| rerankerApiKey 非空 → RerankerApi 创建 | L2 | ❌ | 空 → undefined, 非空 → RerankerApi |
| dimensions 配置正确传递 | L2 | ❌ | embedLocalDimensions → EmbeddingLocal 构造参数 |

**L2 集成测试关键路径：**
```
loadSettings(旧格式数据) → 验证新字段有默认值 → embedProvider='api' → 创建 EmbeddingApi → 验证 dimensions
```

**完成阈值：** L1 迁移测试 + L2 adapter 创建测试通过

---

### 3.4 Tools 维度

**完成标准：** 每个工具的输入/输出契约可验证

| 测试项 | 层级 | 当前状态 | 完成标准 |
|---|---|---|---|
| ToolRegistry — register/execute/definitions | L1 | ✅ 5 tests | 通过 |
| ToolRegistry — isReadOnly | L1 | ❌ | 验证 readOnly=true/false |
| ToolRegistry — 未注册工具抛错 | L1 | ❌ | 验证错误消息 |
| read_note — 正常读取 | L1 | ✅ | 通过 |
| read_note — 文件不存在 | L1 | ✅ | 通过 |
| read_note — 依赖 VaultPort 而非 Adapter | L1 | ✅ | 通过 (C3 修复) |
| search_vault — 混合检索 + RRF | L1 | ❌ (W3) | W3 实现后覆盖 |
| search_vault — 空/错误结果 | L1 | ❌ (W3) | W3 实现后覆盖 |

**完成阈值：** L1 所有已实现工具 100% 通过 + isReadOnly 测试

---

### 3.5 Worker 维度

**完成标准：** 主线程与 Worker 线程的消息通信可验证

| 测试项 | 层级 | 当前状态 | 完成标准 |
|---|---|---|---|
| WorkerManager — request/response 匹配 | L1 | ✅ 3 tests (mock) | 通过 |
| WorkerManager — 超时 reject | L1 | ❌ | 验证 30s 后 reject |
| WorkerManager — Worker 错误传播 | L1 | ❌ | 验证 onerror → reject all pending |
| WorkerManager — destroy 清理 | L1 | ❌ | 验证 pending 清空 + timer 清理 |
| Worker index.ts — vector.search 处理 | L2 | ❌ | 真实 Worker + vectra |
| Worker index.ts — bm25.search 处理 | L2 | ❌ (W3) | W3 实现后覆盖 |
| Worker index.ts — 未知请求类型 | L1 | ❌ | 返回 error response |

**L2 集成测试关键路径：**
```
Main thread → WorkerManager.request({type:'vector.search'}) → Worker 处理 → 返回结果 → 验证类型正确
```

**完成阈值：** L1 超时+错误+清理测试通过 + L2 至少 1 个真实 Worker 通信测试

---

### 3.6 Hooks 维度

**完成标准：** 钩子注册、执行、容错可验证

| 测试项 | 层级 | 当前状态 | 完成标准 |
|---|---|---|---|
| HookRegistry — 注册并运行 | L1 | ✅ | 通过 |
| HookRegistry — 多 hook 顺序执行 | L1 | ✅ | 通过 |
| HookRegistry — 单个 hook 异常不阻塞后续 | L1 | ✅ | 通过 |
| HookRegistry — 未注册 phase 不报错 | L1 | ✅ | 通过 |
| Hook + AgentLoop 集成 — readOnly 跳过 | L1 | ✅ | 通过 |
| Hook + AgentLoop 集成 — 非 readOnly 触发 | L1 | ✅ | 通过 |

**完成阈值：** ✅ 已完成 — 6/6 通过

---

### 3.7 UI 维度

**完成标准：** Chat 交互流程可验证

| 测试项 | 层级 | 当前状态 | 完成标准 |
|---|---|---|---|
| ChatView — sessionId 跨消息复用 | L1 | ❌ | 验证不每次创建新 session |
| ChatView — 消息列表渲染 | L3 | ❌ | 手动验证 |
| ChatView — 流式输出更新 | L3 | ❌ | 手动验证 |
| ChatView — 错误消息显示 | L3 | ❌ | 手动验证 |
| ChatView — 发送按钮禁用状态 | L3 | ❌ | 手动验证 |
| Svelte 5 语法迁移 | L1 | ❌ | on:click → onclick |

**说明：** UI 维度以 L3（手动 Obsidian 测试）为主，L1 仅验证逻辑（如 sessionId 复用）。Svelte 组件的单元测试需要 svelte-testing-library，成本较高，优先级低于 L3 手动验证。

**完成阈值：** L1 sessionId 测试通过 + L3 手动测试 checklist 全部勾选

---

### 3.8 Infrastructure 维度

**完成标准：** 基础设施模块的边界条件可验证

| 测试项 | 层级 | 当前状态 | 完成标准 |
|---|---|---|---|
| PersistenceJson — load/save/upsert | L1 | ✅ 11 tests | 通过 |
| PersistenceJson — 并发 persist 序列化 | L1 | ✅ | 通过 |
| PersistenceJson — 损坏数据加载 | L1 | ❌ | loadData 返回无效 JSON 时的恢复 |
| PersistenceJson — 并发 load 去重 | L1 | ❌ | 验证 loadingPromise 共享 |
| hash — 一致性/碰撞/空输入 | L1 | ✅ 5 tests | 通过 |
| types — WorkerRequest/WorkerResponse 完整性 | L1 | ❌ | 编译时已验证，运行时无需测试 |

**完成阈值：** L1 损坏数据 + 并发 load 测试通过

---

## 4. 跨维度集成测试

这些测试验证多个维度协作的正确性：

| 测试名 | 涉及维度 | 关键路径 | 优先级 |
|---|---|---|---|
| **完整 RAG 管线** | RAG + Worker + Settings | 配置 local embedding → 分块 → 嵌入 → 存储 → 检索 | P0 |
| **完整对话流** | Chat + Tools + Hooks | 用户消息 → LLM → 工具调用 → hook → 回复 | P0 |
| **设置变更传播** | Settings + RAG + Chat | 切换 embedProvider → 重建 embedding → 验证搜索 | P1 |
| **Worker 通信** | Worker + RAG | 主线程发 vector.search → Worker 返回结果 | P1 |
| **索引 + 检索闭环** | RAG + Tools + Chat | 索引文件 → search_vault → Agent 引用结果 | P2 |

---

## 5. 测试文件组织

```
tests/
  ├── unit/                          ← L1 单元测试
  │   ├── core/
  │   │   ├── agent-loop.test.ts
  │   │   ├── context-manager.test.ts
  │   │   ├── tool-registry.test.ts
  │   │   └── hooks.test.ts
  │   ├── adapters/
  │   │   ├── llm-deepseek.test.ts
  │   │   ├── embedding-api.test.ts
  │   │   ├── embedding-local.test.ts
  │   │   ├── vector-vectra.test.ts
  │   │   ├── persistence-json.test.ts
  │   │   └── obsidian-vault.test.ts     ← NEW
  │   ├── tools/
  │   │   └── read-note.test.ts
  │   ├── worker/
  │   │   ├── chunker.test.ts
  │   │   └── manager.test.ts            ← NEW (从 worker-bridge 迁移)
  │   ├── settings.test.ts               ← NEW
  │   └── utils/
  │       └── hash.test.ts
  │
  ├── integration/                    ← L2 集成测试
  │   ├── rag-pipeline.test.ts         ← NEW: embed → upsert → search
  │   ├── chat-flow.test.ts            ← NEW: message → tool → reply
  │   ├── settings-migration.test.ts   ← NEW: 旧格式 → 新格式
  │   └── worker-communication.test.ts ← NEW: 真实 Worker 消息
  │
  └── e2e/                            ← L3 E2E (手动 checklist)
      └── manual-test-checklist.md     ← NEW: Obsidian 内手动验证项
```

**迁移策略：** 现有测试文件保持原位，新增的测试文件按新结构组织。后续逐步迁移。

---

## 6. 完成标准总表

| 维度 | L1 完成 | L2 完成 | L3 完成 | 总体状态 |
|---|---|---|---|---|
| RAG | 10/12 (83%) | 0/3 (0%) | N/A | 🟡 需补充 |
| Chat | 13/16 (81%) | 0/1 (0%) | N/A | 🟡 需补充 |
| Settings | 0/2 (0%) | 0/2 (0%) | N/A | 🔴 未覆盖 |
| Tools | 8/8 (100%) | N/A | N/A | 🟢 完成 |
| Worker | 3/7 (43%) | 0/1 (0%) | N/A | 🔴 需补充 |
| Hooks | 6/6 (100%) | N/A | N/A | 🟢 完成 |
| UI | 0/1 (0%) | N/A | 0/5 | 🔴 需补充 |
| Infrastructure | 18/18 (100%) | N/A | N/A | 🟢 完成 |

**W1 backfill 影响(W1 完成后更新):**

- Tools L1: 5/8 → 8/8(T1 完成: isReadOnly + 未注册工具抛错)
- Chat L1: 11/16 → 13/16(T2 + T4 + T5 完成: ContextManager 守卫 + LLM SSE 异常/多 tool_calls + Agent Loop 中途错误/多轮)
- Infrastructure L1: 16/18 → 18/18(T3 完成: 损坏数据 + 并发 load 去重)
- M1 单元测试夯实:51/65 (78%) → 65/65 (100%) ✅

**里程碑定义：**

| 里程碑 | 标准 | 当前 |
|---|---|---|
| **M1: 单元测试夯实** | 所有维度 L1 ≥ 90% | 65/65 (100%) ✅ |
| **M2: 集成测试闭环** | RAG + Chat + Settings L2 通过 | 0/7 (0%) |
| **M3: E2E 验证** | L3 manual checklist 全部勾选 | 0/5 |
| **M4: 生产就绪** | M1 + M2 + M3 全部通过 | ❌ |

---

## 7. 优先执行顺序

```
Phase 1 (M1): 补齐 L1 单元测试缺口
  ├── Settings: DEFAULT_SETTINGS 完整性 + 迁移测试
  ├── Worker: 超时 + 错误 + 清理 + 未知请求
  ├── Tools: isReadOnly + 未注册工具
  ├── Chat: LLM 流错误 + 多轮工具 + ContextManager 未 load
  ├── RAG: VectraStore 重复 upsert + 空索引搜索
  └── Infrastructure: PersistenceJson 损坏数据 + 并发 load

Phase 2 (M2): L2 集成测试
  ├── RAG Pipeline: embed → upsert → search
  ├── Chat Flow: message → tool → reply
  ├── Settings Migration: 旧格式 → adapter 创建
  └── Worker Communication: 真实 Worker 消息

Phase 3 (M3): L3 手动验证
  ├── Obsidian 加载插件
  ├── Chat 对话流
  ├── 设置面板交互
  ├── 索引 + 搜索
  └── 错误恢复
```
