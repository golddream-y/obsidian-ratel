# 工具历史协议 400 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `/compact` 与坏会话历史上送时 DeepSeek 400（孤立 `role:tool`）。

**Architecture:** 纯函数 `alignPreservedToolMessages` + 上送前 `sanitizeToolMessageOrder`；compact 与 LLM adapter 双接入。

**Tech Stack:** TypeScript、现有 `ChatMessage`、vitest

**Spec:** [2026-07-15-tool-history-protocol-400-design.md](../specs/2026-07-15-tool-history-protocol-400-design.md)

---

### Task 1: align/sanitize 纯函数 + 测试

**Files:**
- Create: `src/core/tool-message-align.ts`
- Create: `tests/core/tool-message-align.test.ts`

- [ ] **Step 1: RED** — 用例：`[asst A, tool A, asst B, tool B]` 的 `slice(-3)` 输入经 align 后无孤立 tool A  
- [ ] **Step 2: GREEN** — 实现 align + sanitize（丢弃无法配对的 tool）  
- [ ] **Step 3: commit** `fix(chat): 对齐 tool 消息避免孤立 role=tool`

### Task 2: 接入 compactSession

**Files:**
- Modify: `src/ui/chat/compact-session.ts`
- Modify: `tests/ui/chat/compact-session.test.ts`

- [ ] preserved 经 `alignPreservedToolMessages`  
- [ ] 测试：含工具对的长历史 compact 后 preserved 合法  
- [ ] commit `fix(chat): compact 保留窗口对齐 tool 对`

### Task 3: 接入 DeepSeek buildRequestBody（双保险）

**Files:**
- Modify: `src/adapters/llm-deepseek.ts`
- Modify: `tests/adapters/llm-deepseek.test.ts`

- [ ] map 之前 `sanitizeToolMessageOrder(req.messages)`  
- [ ] 测试：含孤立 tool 的 messages 上送前被剥掉  
- [ ] commit `fix(llm): 上送前丢弃孤立 tool 消息`

---

## 自审

- [ ] 不改变无 tool 的普通对话  
- [ ] compact 仍尽量保留近 N 条用户可见内容  
