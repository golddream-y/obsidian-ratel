# 用户记忆系统 — Plan A：核心逻辑

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 实现记忆系统核心逻辑——MemoryStore、三个工具、ContextManager 记忆注入、vectra 隔离、prompt section。不包含 UI 和设置面板。

**Architecture:** `MemoryStore` 管理 `.ratel/memory/` 文件读写与 `.memory-index/` vectra 索引。三个工具遵循工厂函数 + ToolRegistry 模式。ContextManager 启动时注入 global.md + index.md。

**前置依赖:** 无。独立可测。

**产出边界:** Agent 可通过三个工具读写记忆、记忆文件持久化、索引同步、启动注入。UI 和设置面板由 Plan B 覆盖。

**Spec 参考:** `docs/superpowers/specs/2026-07-05-memory-system-design.md`

---

## 文件清单（Plan A）

```
新建:
  src/core/memory-store.ts          ← MemoryStore 类
  src/tools/search-memory.ts        ← search_memory 工具
  src/tools/remember.ts             ← remember 工具
  src/tools/forget-memory.ts        ← forget_memory 工具
  tests/core/memory-store.test.ts   ← MemoryStore 单元测试

修改:
  src/types.ts                      ← 新增 MemoryEntry/MemoryFrontmatter/TopicIndexEntry
  src/prompts/tool-schemas.ts       ← 新增 3 个 schema + 更新 ALL_TOOL_NAMES
  src/prompts/defaults/zh.ts        ← 新增记忆 prompt section
  src/prompts/composer.ts           ← 新增 composeMemorySystemPrompt
  src/core/context-manager.ts       ← 新增 setMemoryContext() 方法
  src/main.ts                       ← 初始化 MemoryStore + 注册 3 个工具 + 注入记忆
  src/utils/ratelignore-parser.ts   ← DEFAULT_RATELIGNORE 追加 .ratel/
```

---

## Task 1: 类型定义 + 工具 Schema

**Files:** `src/types.ts`, `src/prompts/tool-schemas.ts`

- [ ] Step 1: 在 `src/types.ts` 末尾追加 `MemoryEntry`、`MemoryFrontmatter`、`TopicIndexEntry` 三个接口（定义见 spec §4.1-4.3）
- [ ] Step 2: 在 `src/prompts/tool-schemas.ts` 的 `TOOL_SCHEMA_SKELETONS` 末尾追加 `search_memory`、`remember`、`forget_memory` 三个 schema（参数见 spec §5.1-5.3）
- [ ] Step 3: 将 `ALL_TOOL_NAMES` 从 `Object.keys(...)` 改为显式数组，末尾追加 `'search_memory'`、`'remember'`、`'forget_memory'`
- [ ] Step 4: `npx tsc --noEmit` → 无新增错误
- [ ] Step 5: 提交

---

## Task 2: MemoryStore 类

**Files:** `src/core/memory-store.ts`, `tests/core/memory-store.test.ts`

- [ ] Step 1: 写测试文件 `tests/core/memory-store.test.ts`，覆盖：ensureDir 创建目录结构、readGlobal/writeGlobal 读写、readIndex/addTopicToIndex/removeTopicFromIndex、readTopic/writeTopic（不存在返回 null）、upsertToIndex 同步更新 vectra、getTotalSize 计算磁盘占用
- [ ] Step 2: `npx vitest run tests/core/memory-store.test.ts` → 全部 FAIL
- [ ] Step 3: 实现 `src/core/memory-store.ts`——`MemoryStore` 类，构造函数接收 `baseDir`（即 `.ratel/memory/` 路径）。包含方法：

| 方法 | 说明 |
|------|------|
| `ensureDir()` | 创建目录结构 + 写空模板 global.md / index.md（若不存在） |
| `readGlobal()` | 读 global.md 全文 |
| `writeGlobal(content)` | 写 global.md（不入记忆索引） |
| `readIndex()` | 解析 index.md 中 `- [[topics/X]] — Y` 行，返回 `TopicIndexEntry[]` |
| `addTopicToIndex(name, summary)` | 追加一行到 index.md |
| `removeTopicFromIndex(name)` | 移除匹配行 |
| `readTopic(name)` | 读 topics/<name>.md，不存在返回 null |
| `writeTopic(name, content)` | 写 topics/<name>.md |
| `upsertToIndex(docId, text)` | 调用 `vectra.upsert()` 同步记忆索引 |
| `searchIndex(query, queryVector, topK)` | 调 `vectra.hybridSearch()` + `getDocumentText()` 返回片段 |
| `removeTopicFromIndexStore(name)` | 从 vectra 删除对应文档 |
| `getTotalSize()` | 递归统计 baseDir 下所有文件大小 |

- [ ] Step 4: `npx vitest run tests/core/memory-store.test.ts` → 全部 PASS
- [ ] Step 5: 提交

---

## Task 3: Prompt Section

**Files:** `src/prompts/defaults/zh.ts`, `src/prompts/composer.ts`

- [ ] Step 1: 在 `src/prompts/defaults/zh.ts` 的 `ZH_DEFAULTS` 中追加 3 个工具 section（key 格式 `tool.<name>.description` 和 `tool.<name>.param.<paramKey>`）：

```
tool.search_memory.description: 搜索用户已建立的记忆（偏好、决策、技术栈相关历史）。仅检索 topics/ 下的主题记忆文件，不检索全局基础记忆。当对话涉及特定技术栈、项目或领域时，先调用此工具查询相关记忆再回答。

tool.remember.description: 写入一条记忆。type 选 global（全局偏好/身份/跨项目决策）或 topic（特定技术栈/领域/项目）。source 选 user（用户显式要求记录）或 model（Agent 推断）。涉及用户身份、通用偏好、跨项目决策用 type=global；涉及特定技术栈、领域、项目用 type=topic。

tool.remember.param.type: 记忆类型，"global" 或 "topic"
tool.remember.param.topic: 主题名，type=topic 时必填
tool.remember.param.section: 区块标题，如"关键决策"、"偏好"
tool.remember.param.content: 要记录的内容
tool.remember.param.source: 来源，"user"（用户要求记录）或"model"（模型推断）

tool.forget_memory.description: 删除一条记忆。按 match 字符串匹配要删除的条目文本。type 选 global 或 topic；type=topic 时需提供 topic 参数。

tool.forget_memory.param.type: 记忆类型，"global" 或 "topic"
tool.forget_memory.param.topic: 主题名，type=topic 时必填
tool.forget_memory.param.match: 匹配要删除的条目文本
```

- [ ] Step 2: 在 `src/prompts/composer.ts` 新增 `composeMemorySystemPrompt(globalContent, indexEntries)` 函数，返回系统提示字符串（格式见 spec §6.1 触发规则）
- [ ] Step 3: `npx tsc --noEmit` → 无新增错误
- [ ] Step 4: 提交

---

## Task 4: ContextManager 记忆注入

**Files:** `src/core/context-manager.ts`

- [ ] Step 1: 在 `ContextManager` 类新增属性 `private memorySystemPrompt: string = ''`
- [ ] Step 2: 新增方法 `setMemoryContext(globalContent: string, indexEntries: TopicIndexEntry[])`，调用 `composeMemorySystemPrompt` 生成系统提示字符串存入 `this.memorySystemPrompt`
- [ ] Step 3: 修改 `toMessages()` 方法：在 system prompt 和 searchResultsMessages 之间插入 `this.memorySystemPrompt`（如果非空），即 `[system, memoryPrompt, ...searchResults, ...history]`
- [ ] Step 4: `npx tsc --noEmit` → 无新增错误
- [ ] Step 5: 提交

---

## Task 5: 三个工具

**Files:** `src/tools/search-memory.ts`, `src/tools/remember.ts`, `src/tools/forget-memory.ts`

- [ ] Step 1: 实现 `src/tools/search-memory.ts`——`createSearchMemoryTool(memoryStore, embeddingPort, definition)` 工厂函数。execute 流程：参数校验（query 必填）→ `embeddingPort.embed(query)` → `memoryStore.searchIndex(query, queryVector, topK)` → 格式化为 `[{index, docId, score, text}]` → 硬限制返回 ≤ 30KB。readOnly: true。
- [ ] Step 2: 实现 `src/tools/remember.ts`——`createRememberTool(memoryStore, definition)` 工厂函数。execute 流程：
  - type=global → 读 global.md → 定位 section 区块 → 追加 `- {content}\n  source: {source}` → 写回（不入索引）
  - type=topic → 若 topics/<topic>.md 不存在 → 创建文件（含 frontmatter + 区块模板）+ `memoryStore.addTopicToIndex(topic, autoSummary)` → 追加条目 → 写回 → `memoryStore.upsertToIndex(docId, 全文)`
- [ ] Step 3: 实现 `src/tools/forget-memory.ts`——`createForgetMemoryTool(memoryStore, definition)` 工厂函数。execute 流程：读对应文件 → 按 match 匹配删除行 → 写回。type=topic 时：`memoryStore.upsertToIndex(全文)`；若文件变为空 → 删除文件 + `removeTopicFromIndex(name)` + `removeTopicFromIndexStore(name)`
- [ ] Step 4: `npx tsc --noEmit` → 无新增错误
- [ ] Step 5: 提交

---

## Task 6: main.ts 集成

**Files:** `src/main.ts`

- [ ] Step 1: 在 `RatelVaultPlugin` 类新增属性 `memoryStore!: MemoryStore`
- [ ] Step 2: 在 `onload()` 中 `this.indexDir` 计算之后，初始化 MemoryStore：`const memoryDir = path.join(vaultBase, '.ratel', 'memory'); this.memoryStore = new MemoryStore(memoryDir); await this.memoryStore.ensureDir();`
- [ ] Step 3: 在工具注册区（`this.tools = new ToolRegistry()` 之后），注册三个记忆工具（使用 `toolDefMap` 中的定义）：
  - `this.tools.register(createSearchMemoryTool(this.memoryStore, this.embeddingPort, toolDefMap.get('search_memory')!));`
  - `this.tools.register(createRememberTool(this.memoryStore, toolDefMap.get('remember')!));`
  - `this.tools.register(createForgetMemoryTool(this.memoryStore, toolDefMap.get('forget_memory')!));`
- [ ] Step 4: 在 `syncToolDefinitions()` 中确认 `ALL_TOOL_NAMES` 已包含新工具名
- [ ] Step 5: 在 `ask()` 方法中，创建 ContextManager 之后、agentLoop 之前，加载记忆并注入：
  ```
  const globalContent = await this.memoryStore.readGlobal();
  const indexEntries = await this.memoryStore.readIndex();
  if (globalContent) {
    ctx.setMemoryContext(globalContent, indexEntries);
  }
  ```
- [ ] Step 6: `npx tsc --noEmit` → 无新增错误
- [ ] Step 7: 提交

---

## Task 7: .ratelignore 排除

**Files:** `src/utils/ratelignore-parser.ts`

- [ ] Step 1: 在 `DEFAULT_RATELIGNORE` 字符串末尾追加 `.ratel/`
- [ ] Step 2: 确认 `Ratelignore.ignores()` 对 `.ratel/memory/global.md` 返回 true
- [ ] Step 3: 提交

---

## Task 8: 全局集成验证

- [ ] Step 1: `npm run build` → 无错误
- [ ] Step 2: `npx vitest run` → 现有测试全部 PASS，新增 MemoryStore 测试 PASS
- [ ] Step 3: 在 Obsidian 中手动验证：打开 Ratel 聊天 → 检查 `.ratel/memory/` 目录已创建 → 对 Agent 说"记住，我的名字叫 Erwin" → 检查 global.md 包含该条目 → 说"忘掉我的名字" → 检查已删除
- [ ] Step 4: 提交
