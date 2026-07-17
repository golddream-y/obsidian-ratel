# Chat Trace 收口 Implementation Plan(P-CHAT-TRACE)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工具旁注收敛为「形状 → ToolDetailModel → i18n 叙事句」中间层,并固底 reasoning 回传与 Trace 分组;人读清晰、禁止 per-tool 胶水爆炸。

**Architecture:** `normalizeToolDetail` 按结果形状产出封闭判别联合;`renderToolDetail` 只拼 i18n;`formatToolDetail` 门面;`metaShortFromModel` 与展开共用 Model。reasoning / Trace 分组已落地,本 plan 以测固 + 旁注重构为主。

**Tech Stack:** TypeScript、Vitest、Svelte 5、项目 i18n(`tNow`/`setLang`)

## Global Constraints

- 形态种类 ≤ 7:`busy|error|listing|links|hits|snippet|kv`(见 S-CHAT-TRACE §4.3.2)
- 禁止按工具名写长大段文案分支;工具名仅允许弱提示表(≤ 数行)
- 用户可见字符串必须 i18n(`chat.tool.detail.*`)
- 不改 tool `execute` 返回值契约
- 不擅自 `git commit`(除非用户明确要求)
- 验证优先:`node`/esbuild harness 或 `npx vitest run <单文件>`;环境若 vitest SIGKILL 则用 esbuild 捆绑断言

---

## File Map

| 文件 | 职责 |
|------|------|
| Create: `src/ui/chat/tool-detail-model.ts` | `ToolDetailModel` 类型 |
| Create: `src/ui/chat/normalize-tool-detail.ts` | 形状 → Model |
| Create: `src/ui/chat/render-tool-detail.ts` | Model → 多行 string + `metaShortFromModel` |
| Modify: `src/ui/chat/format-tool-detail.ts` | 门面:`normalize`+`render`;删旧 switch |
| Modify: `src/ui/chat/message-stream/ToolSegment.svelte` | meta/detail 均走门面 |
| Modify: `src/i18n/types.ts` `zh.ts` `en.ts` | 叙事句 key;清理无用标签 key |
| Modify: `tests/ui/chat/format-tool-detail.test.ts` | 形状用例 + 叙事断言 |
| Keep: reasoning / groupTrace 既有测试 | T0 确认存在即可 |

---

### Task 1: T0 — 确认 reasoning / groupTrace 测试在位

**Files:**
- Verify: `tests/adapters/llm-deepseek.test.ts`(reasoning_content)
- Verify: `tests/core/agent-loop.test.ts`(session reasoning)
- Verify: `tests/ui/chat/message-stream/group-trace-segments.test.ts`

- [x] **Step 1:** 确认上述测试文件含对应用例(已写入则勾选完成,无需新代码)
- [x] **Step 2:** 若缺失则补最小用例(与 S-CHAT-TRACE §4.2 / §4.1 一致)

---

### Task 2: T1 — ToolDetailModel + normalize + render + 叙事 i18n

**Files:**
- Create: `src/ui/chat/tool-detail-model.ts`
- Create: `src/ui/chat/normalize-tool-detail.ts`
- Create: `src/ui/chat/render-tool-detail.ts`
- Modify: `src/ui/chat/format-tool-detail.ts`
- Modify: `src/i18n/*`
- Test: `tests/ui/chat/format-tool-detail.test.ts`

**Interfaces:**
- Produces:
  - `export type ToolDetailModel = …`
  - `export function normalizeToolDetail(input: { name?: string; args?: unknown; result?: unknown; errorMessage?: string; status?: 'calling'|'done'|'failed' }): ToolDetailModel`
  - `export function renderToolDetail(model: ToolDetailModel): string`
  - `export function metaShortFromModel(model: ToolDetailModel): string`
  - `export function formatToolDetail(name, args, result, errorMessage?, status?): string` — 门面

- [x] **Step 1: 写失败测试(叙事句)**

`list_files` 结果应含「在 Adventurer 找到 3 个文件」,且不含 `"files"`。

- [x] **Step 2: 实现 Model / normalize / render / i18n / 门面**

normalize 规则(优先级):
1. errorMessage → `error`
2. status===calling → `busy`
3. 对象含 `files` 或 `folders` 数组 → `listing`
4. 含 `outgoing` 或 `backlinks` → `links`
5. 顶层数组 / `notes|paths|files` 路径列表 → `hits`(name===search_vault 时探测 reranked)
6. `content: string` 或长字符串结果 → `snippet`
7. 其它对象 → `kv`;否则 empty → 渲染 `noResult`

render 叙事 key(须写入 types/zh/en):
- `listingFiles` / `listingFolders` / `listingBoth` / `listingEmpty`
- `hitsFound` / `hitsReranked`
- `snippetChars`
- 保留 `bullet` / `more` / links 短标签 / `kv`

- [x] **Step 3: 跑测试通过**
- [x] **Step 4: 删除旧 per-tool formatXxx 实现**

---

### Task 3: T2 — ToolSegment 共用 Model + 构建

**Files:**
- Modify: `src/ui/chat/message-stream/ToolSegment.svelte`
- Modify: `src/ui/chat/format-tool-detail.ts`(导出 `formatToolMeta` 或门面返回 meta)

- [x] **Step 1:** ToolSegment 用 `normalizeToolDetail` + `metaShortFromModel` / `renderToolDetail`,删除组件内 formatMeta 复制逻辑
- [x] **Step 2:** `node esbuild.config.mjs production` 成功
- [x] **Step 3:** 更新 STATUS:P-CHAT-TRACE → Completed(或 In Progress 收尾)

---

## 自审

- [x] Spec §4.1–4.3 / §5 / §7 / §8 均有任务覆盖
- [x] 无 TBD;接口签名写清
- [x] 与「形态 ≤7 / 禁止大 switch」一致
