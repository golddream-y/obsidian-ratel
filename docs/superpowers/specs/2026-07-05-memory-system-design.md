# Ratel Vault 用户记忆系统设计

> 日期: 2026-07-05
> 状态: Active
> 作者: Erwin（用户明确要求的记忆管理方式）
> 关联: ARCHITECTURE.md / 2026-06-14-ratel-rag-architecture.md

---

## 1. 背景

### 1.1 问题

当前 Ratel 的 Agent 没有跨会话记忆能力。每次打开聊天面板，Agent 从零开始，不知道用户偏好、不知道过往决策、不知道已讨论过的主题。用户需要在每次会话中重复说明上下文。

### 1.2 目标

构建一个两层记忆系统，让 Ratel 能够：

- **跨会话持久化**：关闭 Obsidian 再打开，Agent 依然"认识"用户
- **按需检索**：不把所有记忆塞进上下文，Agent 自主判断何时查什么
- **用户可控**：记忆文件人类可读可编辑，区分"用户要求记录"和"模型推断"

### 1.3 非目标

- 不做每笔记记忆（记忆是"关于用户的认知"，不是"对笔记的标注"）
- 不修改原笔记内容（除非用户显式要求）
- 不引入新数据库（复用 vectra + markdown）
- Phase 1 不做自动固化（会话结束后的自动提取与合并，留到 Phase 2）

---

## 2. 设计决策（Erwin 明确要求）

| # | 决策 | 说明 |
|---|------|------|
| 1 | 混合记忆写入模式 | 用户显式说"记住 X"→ 立即写入；Agent 自行推断 → 标记 `source: model`，设置中可选择关闭自动推断 |
| 2 | 存储位置 | `.ratel/memory/`，vault 内用户可见可编辑；**绝不修改原笔记** |
| 3 | 记忆隔离 | vault 索引（`.index/`）与记忆索引（`.memory-index/`）物理隔离，`.ratelignore` 默认排除整个 `.ratel/` |
| 4 | 两层记忆 | 全局基础记忆（启动注入）+ 主题记忆（工具按需检索） |
| 5 | 记忆创建 | Agent 自动创建 + 用户命令触发；主题文件按需生成 |
| 6 | 独立索引 | 记忆用独立 vectra 索引，不走 Worker 管道（主线程直接操作） |
| 7 | 来源标注 | 每条记忆标注 `source: user`（用户要求记录）或 `source: model`（模型推断） |

---

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                      Agent Loop                          │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ 启动注入  │  │ search_memory│  │ remember │  │ forget_memory │  │
│  │ 全局记忆  │  │    工具       │  │   工具    │  │    工具        │  │
│  └────┬─────┘  └──────┬───────┘  └────┬─────┘  └───────┬───────┘  │
│       │               │               │                 │          │
└───────┼───────────────┼───────────────────┼──────────────┘
        │               │                   │
        ▼               ▼                   ▼
┌──────────────────────────────────────────────────────────┐
│                    Memory Layer                           │
│                                                          │
│  ┌─────────────────┐   ┌──────────────────────────────┐  │
│  │ Global Memory    │   │ Topic Memory                  │  │
│  │ .ratel/memory/   │   │ .ratel/memory/topics/         │  │
│  │ global.md        │   │ GraphQL.md, 后端架构.md ...    │  │
│  │ (启动时全量注入)  │   │ (工具按需检索)                │  │
│  └─────────────────┘   └──────────┬───────────────────┘  │
│                                   │                      │
│                          ┌────────▼──────────┐           │
│                          │ Memory VectraStore │           │
│                          │ .memory-index/     │           │
│                          │ (独立索引)          │           │
│                          └───────────────────┘           │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                    Vault Layer（现有，不改）                │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ Vault      │  │ VectraStore  │  │ .ratelignore     │  │
│  │ .md 文件   │  │ .index/      │  │ 排除 .ratel/     │  │
│  └────────────┘  └──────────────┘  └──────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**关键边界**：
- Vault 索引和记忆索引物理隔离，互不干扰
- 记忆索引不走 Worker 管道 — 主题文件少，主线程直接 `upsert`
- 记忆文件使用 Obsidian vault 文件 API 读写，保证与其他插件兼容

---

## 4. 文件结构

```
.ratel/
├── memory/
│   ├── global.md              ← 全局基础记忆（启动时全量注入）
│   ├── index.md               ← 主题索引（启动时加载，按需跳转）
│   ├── topics/                ← 主题记忆文件
│   │   ├── GraphQL.md
│   │   ├── 后端架构.md
│   │   └── TypeScript.md
│   └── sessions/              ← 会话日志（供 Phase 2 固化流程消费）
│       └── 2026-07-05.md
```

### 4.1 全局基础记忆 — `global.md`

启动时全量注入 Agent 系统提示，受 `基础记忆注入上限`（默认 20 KB）硬限制。

```markdown
---
memory_type: global
updated: 2026-07-05T14:23:00
---

## 用户身份
- 名称：Erwin
- 角色：全栈开发者，Ratel Vault 作者
  source: user

## 偏好
- 代码风格：TypeScript strict mode，async/await 优先
  source: model
- 回答语言：中文
  source: user

## 当前项目
- Ratel CLI：Obsidian 插件，vectra + ONNX 本地 embedding
  source: model

## 关键决策
- 2026-07-05：记忆系统两层架构，markdown 存储，独立 vectra 索引
  source: user
```

每条记忆用 YAML frontmatter 标记元数据，内容中用 `source: user` 或 `source: model` 区分类别。

### 4.2 主题索引 — `index.md`

启动时加载（极轻量），Agent 据此判断有哪些主题可用。**注意**：`global.md` 不写入记忆索引，避免 `search_memory` 与启动注入重复。`index.md` 本身也不入索引。

```markdown
---
memory_type: index
updated: 2026-07-05T14:23:00
---

## 主题列表
- [[topics/GraphQL]] — 性能优化、DataLoader、Schema 设计
- [[topics/后端架构]] — 微服务决策、数据库选型
- [[topics/TypeScript]] — 类型体操、esbuild 配置
```

### 4.3 主题记忆 — `topics/<主题>.md`

按需通过 `search_memory` 工具检索，单次返回受 `动态记忆注入上限`（默认 30 KB）限制。

```markdown
---
memory_type: topic
topic: GraphQL
updated: 2026-07-05T14:23:00
---

## 关键事实
- 2026 Q2 从 REST 迁移到 GraphQL
  source: user
- 使用 Apollo Server + TypeGraphQL
  source: model
- 性能瓶颈在 N+1 查询，已引入 DataLoader
  source: user

## 决策记录
- 2026-06-28：确认使用 code-first 而非 schema-first
  source: user
- 2026-07-01：决定不做 subscription，用 polling 替代
  source: model

## 关联
- 相关 vault 笔记：[[GraphQL Schema 设计]]、[[后端性能优化]]
```

---

## 5. 工具设计

### 5.1 `search_memory`

Agent 按需检索主题记忆。**仅检索 `topics/` 目录下文件**，不检索 `global.md` 和 `index.md`。

| 属性 | 值 |
|------|-----|
| 名称 | `search_memory` |
| 参数 | `query: string`, `topK?: number`（默认 5） |
| 返回 | 相关记忆片段 + 来源标注 + 所属文件路径 |
| 权限 | 默认允许（读操作，无副作用） |

**内部流程**：

```
Agent 调 search_memory("GraphQL DataLoader 最佳实践")
  → 主线程 embedding(query) → queryVector
  → memoryStore.hybridSearch(query, queryVector, topK)
  → 返回 [{docId: "topics/GraphQL.md", score: 0.92, text: "..."}, ...]
  → 格式化为 Agent 可读的搜索结果块（类似 search_vault 的 [1][2] 引用格式）
  → 硬限制：单次返回内容 ≤ 动态记忆注入上限（默认 30 KB）
```

### 5.2 `remember`

Agent 写入记忆。用户显式指令立即写入；Agent 推断需确认或取决于设置。

| 属性 | 值 |
|------|-----|
| 名称 | `remember` |
| 参数 | `type: "global" | "topic"`, `topic?: string`, `section?: string`, `content: string`, `source: "user" | "model"` |
| 返回 | 确认消息 + 写入位置 |
| 权限 | 默认需确认（写操作） |

**分类指引**（写入工具描述，供 Agent 判断用哪个 type）：

- 涉及用户身份、通用偏好、跨项目决策 → `type: "global"`
- 涉及特定技术栈、领域、项目 → `type: "topic"`

**内部流程**：

```
Agent 调 remember({type: "global", section: "关键决策", content: "API 地址改为 xxx", source: "user"})
  → 读 global.md 全文
  → 定位到 `## 关键决策` 区块
  → 追加新条目（标注 source: user）
  → 写回文件
  → 不更新记忆索引（global.md 不入索引，避免与启动注入重复）

Agent 调 remember({type: "topic", topic: "GraphQL", section: "关键事实", content: "...", source: "model"})
  → 若 topics/GraphQL.md 不存在：
      → 创建文件（含 YAML frontmatter + 区块标题 + 条目）
      → 在 index.md 的「主题列表」区追加一行 `[[topics/GraphQL]] — <自动摘要>`
  → 若存在：
      → 读全文 → 定位区块 → 追加 → 写回
  → memoryStore.upsert("topics/GraphQL.md", 全文) ← 同步更新记忆索引
```

**索引更新要点**：
- 主题文件创建或修改后，**必须同步** `memoryStore.upsert` 更新 `.memory-index/`，保证 `search_memory` 立即可检索
- `index.md` 仅在新主题创建时追加一行，已存在主题修改时不更新 `index.md`
- `global.md` 永远不写入记忆索引

### 5.3 `forget_memory`

Agent 删除记忆。

| 属性 | 值 |
|------|-----|
| 名称 | `forget_memory` |
| 参数 | `type: "global" | "topic"`, `topic?: string`, `match: string`（匹配要删除的条目文本） |
| 返回 | 确认消息 + 删除的条目内容 |
| 权限 | 默认需确认（写操作） |

**内部流程**：

```
Agent 调 forget_memory({type: "global", match: "API 地址"})
  → 读 global.md 全文
  → 按行匹配 match 字符串 → 删除匹配行
  → 写回文件

Agent 调 forget_memory({type: "topic", topic: "GraphQL", match: "DataLoader"})
  → 读 topics/GraphQL.md 全文
  → 按行匹配 → 删除匹配行
  → 写回文件
  → memoryStore.upsert("topics/GraphQL.md", 全文) ← 同步更新索引
  → 若文件变为空 → 删除文件 + 从 index.md 移除对应行
```

---

## 6. 数据流

### 6.1 会话启动

```
会话启动
  → ContextManager 加载 global.md 全文（≤ 20 KB）
  → ContextManager 加载 index.md 主题列表
  → 注入系统提示：

    以下是关于用户的已知信息：
    {global.md 全文}

    用户已建立以下主题记忆，当对话涉及相关领域时，请先用 search_memory 查询：
    {index.md 主题列表}

    触发规则：
    - 用户询问某技术栈/项目/领域的偏好、决策或历史 → 先调 search_memory 再回答
    - 用户说"记住 X" → 调 remember（涉及个人/全局偏好用 type=global，涉及特定技术/领域用 type=topic）
    - 用户说"忘掉 X" → 调 forget_memory
    - 不确定是否需要记忆时 → 宁可多查一次

  → Agent 从一开始就"认识"用户，并知道何时查记忆
```

### 6.2 对话中 — 记忆检索

```
用户："GraphQL 的 DataLoader 怎么配置？"
  → Agent 判断需要主题记忆
  → 调 search_memory("GraphQL DataLoader 配置")
  → 获取 topics/GraphQL.md 中相关片段
  → 基于记忆 + vault 搜索结果回答
```

### 6.3 对话中 — 记忆写入/删除

```
用户："记住，我们的 API 地址改成了 https://api.example.com"
  → Agent 识别为显式记忆指令
  → 调 remember({type: "global", section: "关键决策", content: "API 地址: https://api.example.com", source: "user"})
  → 写入 global.md（不入记忆索引）
  → Agent 回复："已记录。"

Agent 发现用户反复纠正同一行为
  → 调 remember({type: "topic", topic: "TypeScript", content: "偏好用 type 而非 interface", source: "model"})
  → 若设置中"自动记忆写入"关闭 → 跳过，仅在会话日志中记录

用户："忘掉我之前说的 API 地址"
  → Agent 调 forget_memory({type: "global", match: "API 地址"})
  → 从 global.md 删除匹配行
  → Agent 回复："已删除。"
```

### 6.4 会话结束（Phase 2）

```
会话结束
  → 写入会话日志到 sessions/YYYY-MM-DD.md
  → 扫描日志，提取候选记忆
  → 与已有记忆做冲突检测
  → 生成变更 diff，展示给用户确认
  → 用户确认 → 合并写入记忆文件
```

---

## 7. 容量控制

| 参数 | 默认值 | 说明 | 用户可调 |
|------|--------|------|----------|
| 存储总上限 | 10 MB | 所有记忆文件磁盘占用上限 | ✓ |
| 基础记忆注入上限 | 20 KB | `global.md` 注入系统提示的硬限制 | ✓ |
| 动态记忆注入上限 | 30 KB | 单次 `search_memory` 返回内容硬限制 | ✓ |
| 上下文总记忆上限 | 50 KB | 基础 + 动态记忆在上下文中的合计硬限制 | ✓ |

超限行为：
- `global.md` 超 20 KB → 注入前截断，保留前 20 KB + 末尾标注"已截断"
- `search_memory` 返回超 30 KB → 取 topK 结果中能装入 30 KB 的部分
- 上下文总记忆超 50 KB → 优先保证基础记忆，动态记忆截断
- 磁盘总占用超 10 MB → 提示用户清理，暂停自动写入

---

## 8. 记忆管理面板

独立侧边栏 View，与聊天面板同级，通过左侧功能区图标打开。

### 8.1 布局

```
┌─ 记忆管理 ────────────────────────────────┐
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ 🔍 搜索记忆...                        │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  [ 全部 ] [ 用户要求 ] [ 模型推断 ]         │
│                                            │
│  ▸ 📌 全局基础                      3 条   │
│    ├ 代码风格: TypeScript strict     [👤]  │
│    ├ 回答语言: 中文                  [👤]  │
│    └ 当前项目: Ratel CLI Obsidian    [🤖]  │
│                                            │
│  ▸ 📂 GraphQL                       4 条   │
│  ▸ 📂 后端架构                       2 条   │
│  ▸ 📂 TypeScript                     1 条   │
│                                            │
│  ────────────────────────────────────────  │
│  记忆总大小: 12 KB / 10 MB                │
│  [ 清理模型推断的记忆 ]  [ 导出记忆 ]       │
└────────────────────────────────────────────┘
```

### 8.2 交互

- **点击条目** → 展开行内编辑（不跳转文件）
- **点击删除** → 弹出确认
- **"清理模型推断的记忆"** → 一键删除所有 `source: model` 的记忆，保留 `source: user`
- **搜索** → 语义搜索 + 关键词混合，跨全局和主题
- **筛选标签** → 按 source 过滤显示

### 8.3 设置页配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 启用记忆功能 | 开 | 关闭后 Agent 不读写记忆 |
| 自动记忆写入 | 开 | 关闭后 Agent 仅响应显式"记住"指令，不主动推断写入 |
| 存储总上限 | 10 MB | 所有记忆文件磁盘占用上限 |
| 基础记忆注入上限 | 20 KB | global.md 注入上限 |
| 动态记忆注入上限 | 30 KB | 单次 search_memory 返回上限 |
| 上下文总记忆上限 | 50 KB | 上下文记忆合计上限 |

---

## 9. 现有系统隔离

### 9.1 vault 索引不索引记忆

- `.ratelignore` 默认规则追加 `.ratel/`
- `IndexController` 的 `Ratelignore.ignores()` 自动过滤 `.ratel/` 下所有文件
- `search_vault` 工具永远不返回 `.ratel/` 下的内容

### 9.2 记忆索引独立运行

- `VectraStore` 新实例，指向 `.memory-index/`，与 `.index/` 物理隔离
- 不走 Worker 管道 — 记忆文件少（几十个），主线程直接 `upsert`
- 复用同一个 ONNX embedding 模型，零额外资源
- 记忆文件变更时，`remember` 工具内部同步更新索引

### 9.3 Worker 零改动

- 不新增 Worker 消息类型
- 不修改 `IndexProcessor`
- 不修改 `handler.ts`

---

## 10. 实现阶段

### Phase 1 — 最小可用

| # | 功能 | 关键模块 |
|---|------|----------|
| 1 | `.ratel/memory/` 目录初始化 | `MemoryStore` 类 |
| 2 | `global.md` + `index.md` 读写 | `MemoryStore` |
| 3 | 启动时记忆注入到 ContextManager | `ContextManager` 扩展 |
| 4 | `search_memory` 工具 | `tools/search-memory.ts` |
| 5 | `remember` 工具 | `tools/remember.ts` |
| 6 | `forget_memory` 工具 | `tools/forget-memory.ts` |
| 7 | 独立 `.memory-index/` vectra 索引 | 第二个 `VectraStore` 实例 |
| 8 | `.ratelignore` 默认排除 `.ratel/` | `Ratelignore` 默认规则追加 |
| 9 | 容量控制（4 个上限参数） | `MemoryStore` 内建 |
| 10 | 记忆管理面板（侧边栏 View） | `ui/memory-panel/` (Svelte) |
| 11 | 设置页配置项（6 个参数） | `settings.ts` 扩展 |

**交付标准**：用户打开 Ratel 聊天 → Agent 知道用户偏好 → 用户说"记住 X"→ 下次会话 Agent 还记得 → 记忆面板可浏览/编辑/删除。

### Phase 2 — 记忆固化

| # | 功能 |
|---|------|
| 11 | 会话日志写入 `sessions/` |
| 12 | 会话结束自动提取候选记忆 |
| 13 | 变更 diff 展示 + 用户确认 |
| 14 | 记忆冲突检测与解决 |
| 15 | 模型推断记忆的确认流程 |

### Phase 3 — 远期

| # | 功能 |
|---|------|
| 16 | 时间衰减标记（标记"可能已过时"，不自动删除） |
| 17 | 主题聚类（跨笔记主题发现，手动触发） |
| 18 | 写回原笔记（用户显式要求时，将关联记忆写入 frontmatter 或文末） |

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Agent 写入错误事实 | 后续会话持续被污染 | `source: model` 标记 + 用户可随时编辑 markdown + "清理模型推断的记忆"一键清除 |
| global.md 膨胀 | 上下文窗口浪费 | 20 KB 硬限制 + 截断 + 提示用户清理 |
| 主题记忆过多 | 检索精度下降 | 10 MB 磁盘上限 + index.md 只列活跃主题 |
| 记忆索引与 vault 索引混淆 | 搜索结果污染 | 物理隔离（不同目录）+ `.ratelignore` 过滤 |
| 多设备同步冲突 | 记忆文件冲突 | 依赖 Obsidian Sync / git 的合并能力，markdown 格式天然支持 |
| Agent 不知道何时调 search_memory | 记忆白存 | 系统提示显式列出触发规则（"涉及某技术栈/项目时先查记忆"）；工具描述明确触发场景 |

---

## 12. 参考

- Claude Code MEMORY.md 与 auto-memory 系统（Anthropic, 2025-2026）
- Letta/MemGPT: LLMs as Operating Systems — Agent Memory（Packer et al., 2023）
- Zep: A Temporal Knowledge Graph Architecture for Agent Memory（arXiv 2501.13956）
- Mem0: State of AI Agent Memory 2026 — LoCoMo Benchmark
- Letta: Benchmarking AI Agent Memory — Is a Filesystem All You Need?（2025）
- Obsidian Personal Assistant plugin — Memory with user approval flow（edonyzpc）
- Memweave: Zero-Infra Agent Memory with Markdown and SQLite（2026）
