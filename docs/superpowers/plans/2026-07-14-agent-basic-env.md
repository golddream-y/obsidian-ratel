# Agent 基础环境感知 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

> **实现状态(2026-07-14):** Phase 1+2 代码已落地并通过相关 vitest;提交步骤留给开发者确认后统一 commit。

**Goal:** 补齐知识库 Agent 办公场景下的基础环境感知 — 当前时间、当前笔记、日记与最近修改 — 避免模型瞎猜「今天」或「当前这篇」。

**Architecture:**  
(1) 每次 `ask()` 在 system 旁路注入一行本地时间（零工具调用成本）。  
(2) 新增只读工具，工厂函数 + ToolRegistry + Composer schema，默认 `toolPermissions: allow`。  
(3) 工作区感知走 `VaultPort` / 薄 `WorkspacePort` 扩展（`app.workspace.getActiveFile()`），不直接在 tools 里 `import 'obsidian'`。

**Tech Stack:** TypeScript strict、现有 Tool 工厂模式、Obsidian `workspace` / `metadataCache`、vitest

**Spec 参考:** `docs/superpowers/specs/2026-07-14-agent-basic-env-design.md`

**范围（供审阅裁剪）:**

| Phase | 内容 | 本 plan |
|---|---|---|
| Phase 1 | system 时间注入 + `get_datetime` + `get_active_note` | ✅ 必做 |
| Phase 2 | `get_daily_note` + `list_recent_notes` + `get_note_outline`（**outline 用 metadataCache.headings**） | ✅ 本 plan 含（可审阅后砍） |
| Phase 3 | `search_by_tag` / `list_unresolved_links` / 无正文的轻量 graph | ❌ 不做（另开）；**不做**独立 backlinks/frontmatter（`read_note` 已有） |
| 不做 | web_search / fetch / bash / eval / open_note / rename | ❌ 明确排除 |

---

## 文件清单

```
新建:
  src/tools/get-datetime.ts
  src/tools/get-active-note.ts
  src/tools/get-daily-note.ts
  src/tools/list-recent-notes.ts
  src/tools/get-note-outline.ts
  src/utils/local-datetime.ts          ← 格式化本地时间（注入 + 工具共用）
  tests/tools/get-datetime.test.ts
  tests/utils/local-datetime.test.ts
  tests/tools/get-active-note.test.ts
  tests/tools/list-recent-notes.test.ts

修改:
  src/ports/workspace.ts              ← 新建 WorkspacePort（推荐）
  src/adapters/obsidian-workspace.ts  ← getActiveFile / selection
  src/ports/vault.ts                  ← VaultMetadata 增加 headings
  src/adapters/obsidian-vault.ts      ← getMetadata 填入 cache.headings
  src/prompts/tool-schemas.ts          ← 5 个 schema + ALL_TOOL_NAMES
  src/prompts/defaults/zh.ts           ← tool.*.description（人话场景写清）
  src/prompts/composer.ts              ← 可选 env section
  src/core/context-manager.ts          ← setEnvContext / toMessages 插入时间行
  src/main.ts                          ← 注册工具 + ask() 注入时间
  src/settings.ts                      ← toolPermissions 默认 allow；dailyNoteFolder/format（Phase 2）
  src/i18n/types.ts + zh.ts + en.ts    ← 设置项文案（若有用户可见设置）
```

---

## Task 1: `local-datetime` 工具函数 + 单测

**Files:** `src/utils/local-datetime.ts`, `tests/utils/local-datetime.test.ts`

- [x] Step 1: 写失败测试 — `formatLocalDateTime(date)` 返回含 ISO、本地可读串、IANA 时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`）、中文星期；固定用 `new Date('2026-07-14T12:00:00+08:00')` 断言稳定字段
- [x] Step 2: 实现 `formatLocalDateTime` / `formatEnvContextLine`（给 system 注入的单行：`当前本地时间: 2026-07-14 20:25 (Asia/Shanghai, 星期二)`）
- [x] Step 3: `npx vitest run tests/utils/local-datetime.test.ts` → PASS
- [ ] Step 4: 提交 `feat(env): local-datetime 格式化工具`

---

## Task 2: ContextManager 注入环境时间

**Files:** `src/core/context-manager.ts`, `src/prompts/composer.ts`（可选 section）, `src/main.ts`

- [ ] Step 1: `ContextManager` 增加 `private envContextLine = ''` 与 `setEnvContext(line: string)`
- [ ] Step 2: `toMessages()` 在 system prompt 之后、memory / searchResults 之前插入非空 `envContextLine`（role: `system`）
- [ ] Step 3: `ask()` 在创建 ContextManager 后调用 `ctx.setEnvContext(formatEnvContextLine(new Date()))`
- [ ] Step 4: 单测或现有 context-manager 测试补一条「注入后 toMessages 含时间行」
- [ ] Step 5: 提交 `feat(env): ask 时注入当前本地时间到 system`

**验收:** 新开会话问「今天几号」— 不调工具也应答对（依赖注入）。

---

## Task 3: `get_datetime` 工具

**Files:** `src/tools/get-datetime.ts`, `tests/tools/get-datetime.test.ts`, schemas / zh defaults / main / settings

- [ ] Step 1: schema — `format?: 'iso' | 'local' | 'full'`（默认 `full`）；可选 `offsetDays?: number`（相对今天加减日，便于「三天后」）
- [ ] Step 2: 工厂 `createGetDatetimeTool(definition)` — 无 vault 依赖；`readOnly: true`；返回 `{ iso, local, timezone, weekday, epochMs }`
- [ ] Step 3: 注册到 `ALL_TOOL_NAMES`、`toolPermissions.get_datetime: 'allow'`、prompt description
- [ ] Step 4: 单测 offsetDays=1 日期进一天
- [ ] Step 5: 提交 `feat(tools): get_datetime`

---

## Task 4: Workspace 感知 — `getActiveFilePath`（端口）

**Files:** `src/ports/vault.ts` **或** `src/ports/workspace.ts` + adapter

**推荐:** 新建 `WorkspacePort`（更干净）:

```typescript
export interface WorkspacePort {
  /** 当前活动 Markdown 文件的 vault 相对路径；无则 null */
  getActiveFilePath(): string | null;
  /** 编辑器选中文本；无选区返回 null */
  getActiveSelection(): string | null;
}
```

`ObsidianWorkspace` 用 `app.workspace.getActiveFile()` + `MarkdownView.editor.getSelection()`。

- [ ] Step 1: 端口 + Obsidian 适配器 + 测试 mock
- [ ] Step 2: `main.ts` 持有 `workspacePort`，`onload` 装配
- [ ] Step 3: 提交 `feat(ports): WorkspacePort 活动文件/选区`

---

## Task 5: `get_active_note` 工具

**Files:** `src/tools/get-active-note.ts`, tests, schemas, main

- [ ] Step 1: 参数 `includeSelection?: boolean`（默认 true）、`includeFrontmatter?: boolean`（默认 true）
- [ ] Step 2: execute — 无活动文件 → 返回 `{ path: null, message: '...' }`（不抛，便于 Agent 降级）；有则 path + basename + 可选 selection + frontmatter（`vault.getMetadata`）
- [ ] Step 3: `readOnly: true`，默认 allow
- [ ] Step 4: 单测：无活动文件 / 有路径+选区
- [ ] Step 5: 提交 `feat(tools): get_active_note`

**验收:** 「总结当前这篇」→ Agent 调 `get_active_note` 再 `read_note`。

---

## Task 6: `get_daily_note`（Phase 2）

**Files:** `src/tools/get-daily-note.ts`, `src/settings.ts`, i18n

- [ ] Step 1: 设置项（可选，有默认即可）:
  - `dailyNoteFolder: string` 默认 `''`（根目录）
  - `dailyNoteFormat: string` 默认 `YYYY-MM-DD`（用简单替换，不引入 moment 依赖；或复用 Obsidian Daily Notes 插件配置若可探测）
- [ ] Step 2: 参数 `date?: string`（`YYYY-MM-DD`，默认今天本地）
- [ ] Step 3: 拼路径 → `fileExists` → 返回 `{ path, exists, date }`；不存在不自动创建（只读工具）
- [ ] Step 4: 注册 + 单测
- [ ] Step 5: 提交 `feat(tools): get_daily_note`

**说明:** 若用户未开日记插件，工具仍按约定路径探测；文档写清默认约定。

---

## Task 7: `list_recent_notes`（Phase 2）

**Files:** `src/tools/list-recent-notes.ts`, tests

- [ ] Step 1: 参数 `limit?: number`（默认 10，硬顶 50）
- [ ] Step 2: `listMarkdownFiles()` + `stat().mtime` 排序降序，过滤 `.ratel/`（走 Ratelignore 或 path-safety）
- [ ] Step 3: 返回 `[{ path, mtime, mtimeLocal }]`
- [ ] Step 4: 单测用 mock vault
- [ ] Step 5: 提交 `feat(tools): list_recent_notes`

---

## Task 8: `get_note_outline`（Phase 2）— 走 Obsidian headings 缓存

**Files:** `src/tools/get-note-outline.ts`, `src/ports/vault.ts`, `src/adapters/obsidian-vault.ts`, tests

- [ ] Step 1: 扩展 `VaultMetadata`：`headings?: Array<{ level: number; heading: string }>`（对齐 `HeadingCache.level` / `.heading`）
- [ ] Step 2: `ObsidianVault.getMetadata` 从 `cache.headings` 填入，**禁止** `cachedRead` + 正则扫全文
- [ ] Step 3: 工具参数 `path: string`（必填）；返回 `{ path, headings: [{ level, text, line? }] }`；无缓存 → 空数组 + 可提示改用 `read_note`
- [ ] Step 4: 单测 mock `getMetadata` 带 headings
- [ ] Step 5: 提交 `feat(tools): get_note_outline via metadataCache.headings`

---

## Task 9: Prompt / 权限 / 集成收口

- [ ] Step 1: toolGuide 补人话规则：涉及「今天/本周」看环境时间或 `get_datetime`；「当前笔记」先 `get_active_note`；要反链/标签用已有 `read_note`（勿再造工具）
- [ ] Step 2: `DEFAULT_SETTINGS.toolPermissions` 为全部新工具设 `allow`
- [ ] Step 3: esbuild + 相关 vitest 通过
- [ ] Step 4: 手动验收清单（见下）
- [ ] Step 5: 提交收口 + CHANGELOG `[Unreleased]` 视需要

---

## 手动验收清单

1. 问「今天星期几？」→ 答对，可不调工具  
2. 问「现在精确到分钟？」→ 可调 `get_datetime`  
3. 打开笔记说「概括当前这篇」→ `get_active_note` → `read_note`  
4. 无打开笔记问「当前笔记」→ 友好说明，不崩  
5. 「最近改过哪些笔记」→ `list_recent_notes`  
6. 「今天的日记在哪」→ `get_daily_note`  
7. 「这篇有哪些章节」→ `get_note_outline`（不读全文也应出大纲）  
8. 「这篇谁链过来」→ 用 **`read_note`** 看 `backlinks`（无新工具）

---

## 非目标（审阅时确认）

- [ ] 不自动创建日记文件  
- [ ] 不接入 Daily Notes 写 API（只读探测路径）  
- [ ] 不做独立 backlinks/frontmatter/tags 工具（`read_note` 已有）  
- [ ] Phase 3（search_by_tag / unresolvedLinks）另开  
- [ ] 不做 web / shell / open_note / rename  
- [ ] 不改 5MB 体积相关依赖  

---

## 自审

| 项 | 状态 |
|---|---|
| Spec 覆盖 Phase 1–2 + Obsidian API 对齐 | ✅ |
| outline 用 headings 缓存 | ✅ |
| 与 `read_note` 不重复 | ✅ |
| i18n：daily 设置文案 | Phase 2 需走 i18n |
| 工具 description（LLM） | zh.ts，人话场景写清 |

---

## 审阅选项（请勾选）

```
Phase 范围:
 [ ] 只做 Phase 1（时间注入 + get_datetime + get_active_note）
 [ ] Phase 1 + Phase 2（本 plan 全文，含 daily/recent/outline）

实现方式偏好:
 [ ] WorkspacePort 独立端口（推荐）
 [ ] 塞进现有 VaultPort（少文件）
```
