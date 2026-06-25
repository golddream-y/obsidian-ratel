# S-DIAG — 诊断测试页设计

> **状态:** Active
> **创建日期:** 2026-06-25
> **作者:** brainstorming (与用户协作)
> **关联:** none
> **优先级:** Medium

---

## 背景

Ratel Vault 插件在排查问题时缺少可视化的调试界面。当用户配置错（API Key 错、Base URL 错）、模型未就绪、索引为空、LLM 异常时，所有错误信息要么堆在 `console` 里（用户看不到），要么以一句 Notice 弹窗（信息量极低）。用户只能盲改设置、重启插件、看 `app.js` 的 stack trace，调试效率极低。

仓库现状：
- 已有 `EmbeddingPort` 与 `VectorStore` 端口 + 适配器
- 已有 `search-vault` 工具（agent 调用的 RAG 检索入口）
- 已有 `vectraStore` 公共字段（`main.ts` 持有）
- 已有 `plugin.embedding` 公共字段
- `settings.ts` 当前只有"常规设置"一个主 Tab

## 目标

在设置面板增加"诊断测试"主 Tab，提供三个调试工具：

1. **目标一：模型是否可用（连通性 + 推理结果正确性）**
   - Embedding 模型能跑通：输入文本返回合理向量
   - LLM 模型能跑通：单轮对话有流式响应
2. **目标二：检索内容是否符合预期**
   - 输入 query，能在 vault 真实库里检索出 Top-K 文档
   - 展示 docId + score + **命中的 chunk 文本摘要**（让用户肉眼判断是否合理）

## 非目标

- 不做"功能完备的测试套件" — 这是调试用页面，不是 CI 工具
- 不引入新的对外接口（不在 `main.ts` 暴露新方法）
- 不写单元测试 — UI 渲染类价值低
- Rerank 暂不实现，仅占位
- 不实现批量压测/性能基准
- 不支持 Embedding 模型切换（只测当前 Provider 配置的模型）

## 详细设计

### 架构

设置面板拆为两个主 Tab：

```
RatelVaultSettingTab.display()
  ├─ 「常规设置」 → renderSettings()  [原逻辑,不变]
  └─ 「诊断测试」 → renderDiagnostics()
                    └─ createTabBar([Embedding, LLM, Rerank])
                       ├─ renderEmbeddingTest()
                       ├─ renderLLMTest()
                       └─ renderRerankPlaceholder()
```

### 关键约束（不可妥协）

- **不引入新接口**：诊断页只读 `plugin.embedding` + `plugin.vectraStore` 公共字段
- **不整好几套逻辑**：直接调 `embedding.embed()` + `vectraStore.search()`，不复制 search-vault 工具的内部实现
- **不绕过状态机**：本地模型未就绪时禁用对应输入区，给出明确提示

### 组件清单

| 文件 | 职责 | 行数预估 |
|------|------|---------|
| `src/ui/diagnostics/diag-utils.ts` | 错误格式化(`formatError`)、UI 辅助(`createActionButton`、`createResultArea`、`cosineSimilarity`)、CSS 注入 | ~300 |
| `src/ui/diagnostics/tab-bar.ts` | 子 Tab 切换组件 | ~60 |
| `src/ui/diagnostics/embedding-test.ts` | Embedding 调试区(主) | ~250 |
| `src/ui/diagnostics/llm-test.ts` | LLM 调试区(保留现状) | ~250 |
| `src/ui/diagnostics/rerank-placeholder.ts` | Rerank 占位(保留现状) | ~70 |
| `src/settings.ts` | 增加 renderDiagnostics() + display() 主 Tab 拆分 | +50 行 |
| `src/ports/llm.ts` | ChatRequest 新增 `options?: GenerationOptions` | +10 行 |
| `src/adapters/llm-deepseek.ts` | buildRequestBody 透传 generation params | +6 行 |
| `src/adapters/embedding-local.ts` | 新增 `isReady` 公开属性 | +5 行 |

### Embedding 调试区布局

```
┌────────────────────────────────────────────────────┐
│ 状态条:Provider=Local | 模型=bge-small-zh | 维度=512│
│        索引=12 文档 | Embedding=就绪                 │
├────────────────────────────────────────────────────┤
│ ① 库内检索(主)                                      │
│   Query: [textarea, 2 行]                            │
│   Top-K: [5 ▼]    [检索] 按钮                       │
│   索引未就绪时:整个区禁用(disabled), 顶部状态条说明  │
│   ────────────────                                  │
│   结果区:                                            │
│     #1  score=0.87  doc=notes/foo.md                │
│     命中 chunk 文本摘要(前 200 字)                  │
│     [在 Obsidian 中打开] 链接                        │
│     #2 ...                                          │
├────────────────────────────────────────────────────┤
│ ② AB 相似度(辅助)                                    │
│   [Text A] [Text B]                                 │
│   [计算相似度]                                        │
│   分数 + 进度条 + 耗时                                │
└────────────────────────────────────────────────────┘
```

### 数据流

**库内检索**：
```
[Query] → plugin.embedding.embed([query]) → [queryVector]
       → plugin.vectraStore.search(queryVector, topK) → [VectorSearchResult]
       → 渲染:rank + score + 文档路径 + chunk 摘要
```

**AB 相似度**：
```
[A, B] → plugin.embedding.embed([A, B]) → [vA, vB]
       → cosineSimilarity(vA, vB) → 0.x
       → 渲染:大字号分数 + 进度条
```

### 错误处理（核心需求 — 调试用要清楚）

所有错误走 `formatError(err, context)` → `renderError(container, diagError)`，统一呈现为结构化错误块：

```
┌─────────────────────────────────────────────┐
│ [网络错误]  ECONNREFUSED 127.0.0.1:11434   │
│ 可能原因:网络连接失败,无法访问 API 端点     │
│ 排查建议:请检查 API Base URL / 服务是否启动  │
│ ▶ 详细信息                                  │
└─────────────────────────────────────────────┘
```

错误分类启发式（已实现于 `formatError`）：

| 触发条件 | type | cause + suggestion |
|---------|------|---------------------|
| `IndexNotReadyError` | model | 模型未就绪：等待 Notice 消失 |
| HTTP 401 / unauthorized | config | API Key 错：检查设置页 |
| HTTP 404 | config | 模型/路径错：检查 base url + model 名 |
| HTTP 429 | network | 频率限制：稍后重试 |
| ENOTFOUND / ECONNREFUSED / timeout / failed to fetch | network | 网络问题：检查连接 / 服务状态 |
| ONNX / WASM / tokenizer 错误 | model | 本地模型问题：删除 models 重新下载 |
| HTTP 400 / invalid / bad request | runtime | 参数问题：检查输入 |
| 兜底 | unknown | 见详细信息 stack |

### 状态条

顶部状态条实时显示：
- Provider（Local / API）
- 模型 ID + 维度
- Key 配置状态（已配置/本地无 Key/未配置）
- **索引状态**：调用 `vectraStore.status()` 拿 `totalDocs`，0 文档时整检索区禁用
- Embedding 适配器就绪状态

### LLM 测试区（已实现，保留）

保留已有实现：
- System Prompt + 用户消息 + 参数调优(temperature / top_p / max_tokens)
- 流式输出 + 停止/清空 + Ctrl+Enter
- 实时 meta 信息

### Rerank 占位区（已实现，保留）

保留已有灰态占位：
- 当前配置状态摘要
- "🚧 Reranker 测试功能待实现"占位提示
- 未来形态预览（禁用态）

## 影响面

| 模块 | 影响 |
|------|------|
| `src/settings.ts` | display() 拆为两个主 Tab，新增 renderDiagnostics() |
| `src/ui/diagnostics/` | 新建 5 个文件，共 ~930 行 |
| `src/ports/llm.ts` | ChatRequest 加 `options` 字段（向后兼容） |
| `src/adapters/llm-deepseek.ts` | buildRequestBody 透传 generation params |
| `src/adapters/embedding-local.ts` | 加 isReady 公开属性 |
| `main.ts` | **无改动**（按"不引入新接口"原则） |
| `tools/search-vault.ts` | **无改动**（不复制其内部逻辑） |
| `adapters/vector-vectra.ts` | **无改动**（复用其 search 公共方法） |

## 验收标准

- [ ] 设置面板顶部有"常规设置"和"诊断测试"两个主 Tab
- [ ] 诊断测试下三个子 Tab：Embedding / LLM / Rerank
- [ ] Embedding 子 Tab 顶部状态条实时显示 Provider / 模型 / 索引状态
- [ ] Embedding ① 库内检索：query 检索 vault，输出 docId + score + chunk 文本摘要
      - chunk 文本获取方式：在 VectraStore 临时增加 `getDocumentText(docId)` 方法（一次读取全部 chunks 拼接），或在 plan 阶段评估 vectra 现有 API 是否可直接拿到。实施期评估后选一种。**最低保证：先显示 docId + score + 文档路径；chunk 文本不阻塞验收。**
- [ ] 索引为空时库内检索区禁用，提示"请先建索引"
- [ ] Embedding ② AB 相似度：两段文本 → 余弦分数 + 进度条
- [ ] LLM 子 Tab：流式输出 + 参数调优(temperature/top_p/max_tokens) + Ctrl+Enter
- [ ] Rerank 子 Tab：灰态占位 + 当前配置状态
- [ ] 所有错误展示为结构化错误块（type + message + cause + suggestion + 可折叠 stack/raw）
- [ ] `npm run build` 成功
- [ ] `npm test` 全部通过（219 测试不动）
- [ ] 手动 E2E：在 Obsidian 打开设置 → 诊断测试 → 三个子 Tab 各自验证

## 不在范围（Out of Scope）

- 性能基准测试
- 批量压测
- Embedding 模型切换（仅测当前 Provider）
- 单元测试（UI 渲染，价值低）
- Rerank 真实实现
- i18n 翻译（错误信息先用中文）
- 持久化测试结果

## 风险 & 缓解

| 风险 | 缓解 |
|------|------|
| `vectraStore.status()` 在 InlineWorker 模式下读不到真实数据 | 已有降级返回零值；UI 显示"索引=0 文档"时禁用检索区，用户自己判断 |
| 库内检索命中 chunk 但无原文显示 | metadata 里有 chunkIndex，但当前 vectraStore 没有按 docId 拿 chunk text 的方法。**实施时评估**：要么从 VectraStore 加 getChunksForDoc(id)，要么先显示"[chunk text 未提供]"，二期再加 |
| 诊断页加 CSS 可能污染全局 | 全部用 `.diag-*` 前缀，不污染 Obsidian 默认样式 |
| 大文档 chunk 摘要可能展示超长文本 | 截断 200 字 + ellipsis |

## 参考

- `src/ports/embedding.ts` — EmbeddingPort 端口
- `src/ports/vector.ts` — VectorStore 端口
- `src/adapters/embedding-local.ts` — EmbeddingLocal 占位器
- `src/adapters/vector-vectra.ts` — VectraStore 包装层
- `src/tools/search-vault.ts` — search_vault 工具（参考其调用模式）
- `src/main.ts` — `plugin.embedding` / `plugin.vectraStore` 公共字段
- AGENTS.md § 文档与注释规范 — 中文注释 + 文件头注释
