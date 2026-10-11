# 目录约束注入上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 第一次移动、复制、写入就按磁盘真实结果执行；子目录 `AGENTS.md` 进入本轮上下文，不再当成工具失败返回。

**架构：** `note-agents.ts` 只负责按目录链收集尚未注入的约束。工具调用它之后继续执行。`ContextManager` 把新链追加到现有库根约束后面，下一次模型请求能看见。`move_note` / `copy_note` 的错误只来自路径检查和 Obsidian。

**技术栈：** TypeScript、vitest。不新增依赖。

**所属 spec：** [S-AGENTS-INJECT](../specs/2026-10-02-agents-inject-design.md)

## Global Constraints

- 不取消库根每轮注入，子目录注入不重复库根全文。
- 写、删、移动、复制的第一次调用就执行。不再返回 `Error: 未改动文件`。
- 同一条目录链本轮只注入一次。去重按目录链，不按完整文件路径。
- 工具结果不包含 `AGENTS.md` 正文。`read_note` 的 `content` 只有笔记正文。
- 移动仍走 `fileManager.renameFile`。目标已存在不覆盖，不做内容 hash。
- 父目录不存在先创建，再移动或复制。
- 失败文案：原路径不存在；目标已存在，未覆盖；原路径和目标路径相同。接口抛错则附上原文。
- 注释与测试描述用中文。测试名：`行为 - 条件 - 期望结果`。

## 文件

| 文件 | 职责 |
|---|---|
| `src/tools/note-agents.ts` | 收集未注入的子目录链；去掉写操作的 `proceed: false` |
| `src/core/context-manager.ts` | `appendNoteAgentsChain`，追加到库根约束之后 |
| `src/tools/move-note.ts`、`copy-note.ts`、`write-note.ts`、`append-note.ts`、`edit-note.ts`、`delete-note.ts`、`read-note.ts` | 注入后继续执行 |
| `src/i18n/zh.ts`、`en.ts` | 移动/复制的三条失败文案 |
| 测试与 CHANGELOG | 见任务 |

---

### Task 1: 收集目录链，不再拦住

**Files:**
- Modify: `src/tools/note-agents.ts`
- Modify: `src/core/context-manager.ts`
- Test: `tests/tools/note-agents-gate.test.ts`

**Interfaces:**
- Produces: `collectUnseenAgentsChain(notePath, seen, readAgentsFile) => Promise<string>`
  返回尚未注入的子目录约束文本；库根层不包含在内。没有新内容时返回空串。`seen` 按目录链标记，同一链再调用返回空串。
- Produces: `ContextManager.appendNoteAgentsChain(text: string): void`
  追加到 `noteAgentsSystemPrompt` 末尾。空串不改。

- [ ] **Step 1: 写失败测试**

`collectUnseenAgentsChain`：

- 路径 `卷一/第一幕/a.md`，只有 `卷一/第一幕` 有 `AGENTS.md`：第一次返回含该文件正文，不含库根正文。
- 同一条链的 `卷一/第一幕/b.md`：第二次返回空串。
- 另一条链 `卷一/第二幕/c.md`：返回第二幕的正文。

`appendNoteAgentsChain`：库根已设置为「库根规则」后追加「第一幕规则」，`toMessages()` 里两段都在，且第一幕在库根之后。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/note-agents-gate.test.ts`

Expected: FAIL，函数未导出。

- [ ] **Step 3: 实现**

写路径上删除 `proceed: false` 和 `Error: 未改动文件`。`read_note` 不再写入 `agentsConstraints`。各修改工具在执行前调用 `collectUnseenAgentsChain`，把非空结果交给当前 `ContextManager.appendNoteAgentsChain`。工具如何拿到 `ContextManager`：沿用现有 `getAgents()`，在 `NoteAgentsToolDeps` 上增加 `appendChain(text: string): void`，由 `main.ts` 在 `ask` 里绑到 `ctx.appendNoteAgentsChain`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/note-agents-gate.test.ts`

Expected: PASS。

---

### Task 2: 移动和复制按真实结果返回

**Files:**
- Modify: `src/i18n/zh.ts`、`en.ts`、`types.ts`（若文案 key 已够用则只改中文措辞）
- Modify: `src/adapters/obsidian-vault.ts`（确认父目录创建与三条错误仍在；源不存在的文案改为「原路径不存在」）
- Modify: `src/tools/move-note.ts`、`copy-note.ts`
- Test: `tests/tools/move-copy-note.test.ts`、`tests/adapters/obsidian-vault.test.ts`

- [ ] **Step 1: 写失败测试**

- `move_note` 在源和目标目录都有 `AGENTS.md` 时，第一次调用就移动成功，返回 `{ from, to }`，结果文本不含 `AGENTS.md`、不含「未改动文件」。
- 原路径不存在：错误含「原路径不存在」，且未调用移动。
- 目标已存在：错误含「目标已存在」，原文还在。
- 父目录不存在：先创建再移动（适配器测试已有则保持）。
- `copy_note` 同样：第一次就复制，原文件还在。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/move-copy-note.test.ts tests/adapters/obsidian-vault.test.ts`

Expected: 移动在有约束时仍返回「未改动文件」则 FAIL。

- [ ] **Step 3: 实现**

`move_note` 对 `from` 和 `to` 各收集一次目录链，然后无条件 `renameFile`。`copy_note` 对 `to` 收集后 `copyFile`。错误从端口抛出，工具不改写成约束文本。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/move-copy-note.test.ts tests/tools/note-agents-gate.test.ts tests/adapters/obsidian-vault.test.ts tests/tools/write-append-delete.test.ts`

Expected: PASS。

---

### Task 3: 读结果与更新日志

**Files:**
- Modify: `src/tools/read-note.ts`
- Modify: `CHANGELOG.md` 的 `[Unreleased]`「笔记」一节
- Test: 现有 read_note 测试里若断言 `agentsConstraints`，改为不存在该字段

- [ ] **Step 1: 去掉 `agentsConstraints`**

读笔记仍可调用收集函数，把新目录链注入上下文。返回对象只有 `content`、`path`、元数据和反链。

- [ ] **Step 2: CHANGELOG**

在「笔记」下把现有「第一次改某个目录时会标明没写上」改成：

**Changed：第一次改某个目录就会执行** — 该目录的写作约束出现在上下文里，不再作为失败结果返回。

- [ ] **Step 3: 跑测试**

Run: `npx vitest run tests/tools/note-agents-gate.test.ts tests/tools/move-copy-note.test.ts tests/tools/read-note.test.ts`

若 `read-note.test.ts` 不存在，只跑前两个。Expected: PASS。

---

## 自审

| spec | 任务 |
|---|---|
| 第一次修改就执行 | Task 1、Task 2 |
| 目录链注入且不重复库根、按链去重 | Task 1 |
| 工具结果不含约束；读结果不含整篇 AGENTS.md | Task 1、Task 3 |
| 原路径不存在、目标已存在、路径相同、父目录先建 | Task 2 |
| 不做 hash、不改移动接口 | 无对应代码任务 |
