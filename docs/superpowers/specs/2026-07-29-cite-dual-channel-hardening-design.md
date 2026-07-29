# S-CITE — 引用双通道加固设计

> **ID:** S-CITE  
> **状态:** Active  
> **日期:** 2026-07-29  
> **前置:** [S-CHAT-UI-V3 §5.5](../archive/S-CHAT-UI-V3/2026-07-16-chat-ui-v3-conversation-first.md)（正文 `[n]` ↔ 底部 cite-chip）  
> **动机:** 现网 chip（B）随 `search.result` 自动出现，正文内联标（A）依赖模型自觉写 `[n]`，命中率低；续聊 hydrate 不恢复 `searchResults`，导致即使有 `[n]` 也无法点击。

---

## 1. 背景

S-CHAT-UI-V3 规定引用为 **双通道**：

| 通道 | 形态 | 行为 |
|---|---|---|
| A. 正文内联 | Markdown 中 `[n]` / `[[n]]` → 可点铜调/强调色链 | 打开对应 `searchResults[index]` 的笔记 |
| B. 底部芯片 | `n` + 截断 path | 同上打开 |

排查结论（2026-07-29）：

1. UI 增强链路（`enhanceCiteLinks`）在正文含 `[n]` 时工作正常；`marked` 保留 `[n]` 文本。
2. 用户可见症状「只有一排 chip、没有句末标」——常见原因是 **模型未在正文写出 `[n]`**，同时 `search_vault` 仍触发 `search.result` 铺满 chip。
3. `ContextManager.addSearchResults`（注入 `[n] path` 示范块）在生产 Agent Loop **从未调用**，强化引用习惯的上下文示范缺失。
4. `hydrateSessionMessages` **不恢复** `Message.searchResults`，续聊后 A/B 均可失效或不可点。

---

## 2. 目标

1. **提高 A 通道命中率**：prompt 收紧 + `search_vault` 成功后注入 `[n] path` 索引块。  
2. **B 通道不抢戏**：  
   - 正文出现 ≥1 个有效 `[n]` → **不渲染** chip 行；  
   - 有 `searchResults` 但正文无有效 `[n]` → **折叠**「来源 N 篇」，默认收起，展开后才是 chip。  
3. **续聊可点**：会话持久化并 hydrate `searchResults`（及 `searchReranked`）。  
4. **chip 可读**：截断优先保留文件名 / 末两段路径。

成功标准（可验收）：

- 新一轮含 `search_vault` 的对话：上下文中出现与 tool `index` 对齐的注入块。  
- 模型若写出 `[1]`：可点打开笔记，且消息底部 **无** chip 行。  
- 模型若未写任何有效 `[n]`：底部为折叠「来源 N 篇」，展开可点。  
- 关闭侧栏再打开同一会话：上述行为仍成立（`searchResults` 已恢复）。

---

## 3. 非目标

- 回答结束后由系统 **自动改写/插入** `[n]` 到模型原文。  
- 改变检索算法、默认 `topK`、Rerank 策略。  
- 恢复「把 read_note 全文批量塞进 `addSearchResults`」的旧 RAG 大注入（本期注入以索引清单为主，全文仍靠 `read_note` tool 消息）。  
- 实现独立 `citation` MessageSegment 落库（类型可继续预留）。  
- 在 chip 上展示 score / 色阶墙。  
- 修复会话自动滚底（可并行，不属本 spec）。

---

## 4. 详细设计

### 4.1 编号空间

- `search_vault` 返回的 `index`（从 1 起）= 正文 `[n]` = chip 序号 = 注入块 `[n]`。  
- 同一助手回合内多次 `search_vault`：**后一次覆盖**本轮用于 UI 与注入的结果集（与现网 `am.searchResults = mapped.results` 一致），避免两套编号并存。

### 4.2 Agent Loop / Context 注入

在 `search_vault` 工具成功且 `mapSearchResults` 非空之后（现有 `yield search.result` 旁）：

1. 仍 `yield { type: 'search.result', payload: mapped }`。  
2. **新增**：向 Context 写入受 **硬编码 wrapper** 包裹的 system 注入块（复用 Composer 的 retrieval wrapper，防 prompt 注入）。  
3. 注入内容：对 `mapped.results` 每条用 `injection.searchResults.body` 模板填 `index` / `path`；**`content` 默认空字符串或一行极短提示**（不强制塞 chunk 全文）。  
4. 多次 search：采用 **清空本轮检索注入再写入最新一批**（实现上：`searchResultsMessages` 重置为仅含最新块，或等价「只保留最后一次 search 注入」），与 UI 覆盖语义一致。  
5. 注入格式化失败：`devLogger` 记录，**不阻断**对话。

可复用 / 微调 `ContextManager.addSearchResults`：允许 `content` 为空；或新增窄接口 `setSearchIndexBlock(results)`——plan 阶段二选一，契约以「最后一次 search 的 index 清单在 toMessages() 可见」为准。

### 4.3 Prompt

更新中文默认（可被 prompt override 覆盖）：

- `agent.rag.workflow`：强调「凡依据检索结论的句子句末必须 `[n]`」；禁止仅以文件名/表格代替 `[n]` 作为唯一引用方式。  
- `tool.search_vault.description`：补充「回答时用返回的 `index` 写成 `[n]`」。

不新增独立 section id（除非实施时发现 override 面板需要单独开关——默认不需要）。

### 4.4 UI 消息与持久化

**运行时 `Message`（不变字段，补齐落盘）**

- `searchResults?: { docId, score, path, index }[]`  
- `searchReranked?: boolean`

**落盘策略（选定）**

- 在对应 **assistant** 回合的持久化表示中保存 `searchResults` / `searchReranked`。  
- 推荐：扩展 session 消息旁路结构（例如 UI hydrate 专用 sidecar，或在最后一条含检索的 assistant 关联字段）。若现有 `ChatMessage` 不宜脏加字段，则在 `Session` 上增加 `messageCitations: Record<assistantKey, SearchResultItem[]>` 或「按消息序号」映射——**plan 必须选一种并写迁移/兼容：旧会话无字段 = 无 chip、正文 `[n]` 不可点（与今日一致）**。  
- 硬约束：`hydrateSessionMessages`（或其后处理）必须把 `searchResults` 填回 UI `Message`。

**运行时 `citedIndexes`（可不落盘）**

- 从该条助手全部 text segment 中匹配 `\[(\d+)\]` / `\[\[(\d+)\]\]`，与 `searchResults.index` 求交。  
- 流式过程中随文本更新重算。

### 4.5 SearchResults 呈现规则

| 条件 | 呈现 |
|---|---|
| 无 `searchResults` 或空 | 不显示 |
| `citedIndexes.size >= 1` | **不渲染** chip 行 |
| 有 `searchResults` 且 `citedIndexes` 空 | 折叠条「来源 N 篇」（i18n）；默认收起；展开后 chip 列表 |

Chip 内容：

- `n` + 可读截断 path；`title` = 全路径。  
- 截断：优先保留 **文件名**；若仍过长再保留「末两段路径」，前缀用 `…`。替换当前「一律 `…` + 末 40 字符」。  
- 不展示 score。  
- 点击 → 现有 `onOpenPath`。

正文 A 通道：维持 `MarkdownView` + `enhanceCiteLinks`；无匹配 index 则保持纯文本。

### 4.6 错误与边界

| 情况 | 行为 |
|---|---|
| `[n]` ∉ searchResults | 纯文本，不可点 |
| 打开路径失败 | 现有 Notice |
| 仅 `read_note`、从未 `search_vault` | 无注入、无 chip；正文 `[n]` 不可点 |
| 注入失败 | 日志；对话继续 |

### 4.7 i18n

新增用户可见文案（中英），至少：

- `chat.cite.sourcesCollapsed`（如「来源 {n} 篇」）  
- `chat.cite.sourcesExpand` / `sourcesCollapse`（若折叠条需要独立 aria）

走现有 `t` / `tNow`，禁止硬编码。

### 4.8 测试

- 保留并扩展 `cite-enhance` 单测。  
- 新增：截断函数单测（文件名优先）。  
- 新增：有/无 `citedIndexes` 时 SearchResults 显隐逻辑（纯函数或组件测）。  
- 新增：hydrate 恢复 `searchResults` 后 `[1]` 可解析到 path。  
- 新增：Agent Loop / Context 在 `search_vault` 成功后出现注入块（mock）。

---

## 5. 影响面

| 区域 | 影响 |
|---|---|
| `src/core/agent-loop.ts` | search 成功后触发注入 |
| `src/core/context-manager.ts` | 注入 API / 清空再写 |
| `src/prompts/defaults/zh.ts`（及 en 若有对称默认） | workflow / tool 文案 |
| `src/ui/chat/message-stream/*` | SearchResults 折叠/显隐；截断；hydrate |
| Session 持久化 | 保存 searchResults |
| `src/i18n/*` | 折叠文案 |

---

## 6. 参考

- S-CHAT-UI-V3 §5.5 引用双通道  
- `docs/prototype/chat-ui-mockup.html` cite / cite-chip  
- `src/ui/chat/cite-enhance.ts`、`SearchResults.svelte`、`search-result-mapper.ts`  
- `ContextManager.addSearchResults` + `formatSearchResultsBlock`（现有注入外壳）

---

## 7. 决策摘要

| 项 | 选择 |
|---|---|
| 成功标准范围 | A+B + 续聊可点 |
| 模型不写 `[n]` 时 | prompt + 注入 + chip 折叠兜底 |
| 正文已有有效 `[n]` 时 | 隐藏整行 chip |
| 注入内容 | 索引清单为主，不强制全文 |
| 多次 search | 后写覆盖 |
| 自动改模型原文插标 | 不做 |
