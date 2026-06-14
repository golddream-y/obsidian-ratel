# Spec & Plan Status Tracker

> **Purpose:** Single source of truth for all specs and plans in `docs/superpowers/`. Updated whenever a new spec/plan is created, status changes, or execution completes.
>
> **Maintenance rule:** This file MUST be updated:
> 1. When a new spec is created (status: Draft → Active)
> 2. When a plan is created from a spec (status: Pending)
> 3. When a plan starts execution (status: In Progress)
> 4. When a plan finishes (status: Completed / Blocked / Abandoned)
> 5. When a spec is superseded (link the replacement)
>
> **Owner convention:** Whoever creates the file updates this tracker in the same commit.

---

## Active Specs (design / architecture documents)

| ID | File | Status | Created | Notes |
|---|---|---|---|---|
| S-ARCH-001 | [2026-06-07-architecture-feasibility-review-design.md](specs/2026-06-07-architecture-feasibility-review-design.md) | Active | 2026-06-07 | Original architecture feasibility design |
| S-MODEL-001 | [2026-06-13-model-config-and-local-inference-design.md](specs/2026-06-13-model-config-and-local-inference-design.md) | Active | 2026-06-13 | Model config + local inference design |
| S-RAG-ROADMAP | [2026-06-13-rag-enhancement-roadmap-design.md](specs/2026-06-13-rag-enhancement-roadmap-design.md) | Active | 2026-06-13 | RAG 3-phase roadmap |
| S-RAG-ARCH | [2026-06-14-ratel-rag-architecture.md](specs/2026-06-14-ratel-rag-architecture.md) | Active | 2026-06-14 | Final RAG architecture (supersedes S-RAG-ROADMAP's loose ideas) |
| S-TEST-ARCH | [2026-06-14-ratel-test-architecture.md](specs/2026-06-14-ratel-test-architecture.md) | Active | 2026-06-14 | Test architecture by functional dimensions + 4 milestones |

---

## Implementation Plans (work breakdowns)

| ID | File | Status | Branch | Started | Completed | Implements Spec |
|---|---|---|---|---|---|---|
| P-W1-IMPL | [2026-06-13-ratel-w1-implementation.md](plans/2026-06-13-ratel-w1-implementation.md) | ✅ Completed | (merged) | 2026-06-13 | 2026-06-13 | S-ARCH-001 (W1 slice) |
| P-W2-IMPL | [2026-06-13-ratel-w2-implementation.md](plans/2026-06-13-ratel-w2-implementation.md) | ✅ Completed | (merged) | 2026-06-13 | 2026-06-13 | S-MODEL-001, S-RAG-ARCH (W2 slice) |
| P-W3-IMPL | [2026-06-13-ratel-w3-implementation.md](plans/2026-06-13-ratel-w3-implementation.md) | ⏳ Pending | — | — | — | S-RAG-ARCH (W3 slice) |
| P-W4-IMPL | [2026-06-13-ratel-w4-implementation.md](plans/2026-06-13-ratel-w4-implementation.md) | ⏳ Pending | — | — | — | S-RAG-ARCH (W4 slice) |
| P-W1-TEST-BACKFILL | [2026-06-14-ratel-w1-test-backfill.md](plans/2026-06-14-ratel-w1-test-backfill.md) | ✅ Completed | test/w1-backfill | 2026-06-14 | 2026-06-14 | S-TEST-ARCH (W1 backfill) |
| P-W2-TEST-BACKFILL | [2026-06-14-ratel-w2-test-backfill.md](plans/2026-06-14-ratel-w2-test-backfill.md) | ✅ Completed | test/w2-backfill → main (3a3cb9f) | 2026-06-14 | 2026-06-14 | S-TEST-ARCH (W2 backfill) |
| P-W3-TEST | [2026-06-14-ratel-w3-test-plan.md](plans/2026-06-14-ratel-w3-test-plan.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W3 plan) |
| P-W4-TEST | [2026-06-14-ratel-w4-test-plan.md](plans/2026-06-14-ratel-w4-test-plan.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W4 plan) |
| P-DOCS-CN | (none — chore) | ✅ Completed | chore/translate-comments-to-chinese | 2026-06-14 | 2026-06-14 | AGENTS.md § 文档与注释规范 |

---

## Status Legend

- ⏳ **Pending** — Plan created, not yet started
- 🔄 **In Progress** — Execution has begun, subagent-driven-development active
- ✅ **Completed** — All tasks done, tests passing, branch merged or ready to merge
- ⛔ **Blocked** — Cannot proceed; needs human intervention
- 🚫 **Abandoned** — Stopped mid-way; explain why in notes

---

## Execution Log (chronological)

### 2026-06-14 — W1 Test Backfill (P-W1-TEST-BACKFILL)

| Task | Status | Commit | Notes |
|---|---|---|---|
| T1: ToolRegistry isReadOnly + unknown error | ✅ | `87f402f` | Reviewer flagged duplicate test, removed + amended |
| T2: ContextManager before-load guards | ✅ | `dc0c442` | Reviewer flagged misleading test name, fixed |
| T3: PersistenceJson corrupt + concurrent | ✅ | `7a11ad8` | Reviewer approved with minor concerns (non-blocking) |
| T4: DeepSeekLLM SSE + multi tool_calls | ✅ | `e724423` | Reviewer found weak assertion + misleading comment, fixed |
| T5: Agent Loop mid-stream + multi-round | ✅ | `dd86b86` + `9e7f245` | Multi-round mock fix + 3 lint errors cleaned (`9e7f245`) |
| T6: Final verify + docs update | ✅ | this commit | Full suite 93/93 green; build green; M1 L1 100% reached |

**Current state:** 93/93 tests passing across 13 files (was 75 at start, +18 from W1 backfill T1-T5). M1 (L1 单元测试夯实) reached: 65/65 (100%).

**W1 backfill commit range:** `87f402f..HEAD` (branch `test/w1-backfill`, ready to merge to main).

### 2026-06-14 — Chinese Comment Translation (P-DOCS-CN)

| Group | Files | Status | Commit | Notes |
|---|---|---|---|---|
| G1: src/core/ | agent-loop, context-manager, hooks, tool-registry | ✅ | `69d4579` | JSDoc 类头 / 函数头 / 行内 |
| G2: src/ports/ | llm, persistence, embedding, vector, vault | ✅ | `69d4579` | 端口接口 5 个全部加 JSDoc |
| G3: src/adapters/ | llm-deepseek, obsidian-vault, vector-vectra, persistence-json, embedding-local, embedding-api | ✅ | `c0e2a23` | 关键路径 / 修复点 / 设计要点 注释 |
| G4: src/worker/ | index, manager, chunker | ✅ | `88cf8eb` | Worker 入口 + chunker 三级回退策略 |
| G5: 其他 | main, settings, types, tools/read-note, ui/ChatView.ts/.svelte, utils/hash | ✅ | `88cf8eb` + `6ff869a` | UI 与入口逐项加注释;lint 修复 |
| AGENTS.md § 4 | 需加注释的代码判定准则 | ✅ | (同 88cf8eb) | 6 项强制 / 4 项推荐 / 4 项禁止 |

**Total:** 26 源文件 (src/ 全量) + AGENTS.md 扩展 + STATUS.md 登记。

**Branch:** `chore/translate-comments-to-chinese`(当前分支)。

**Verify:** 93/93 tests passing, build green, lint clean (除 ChatView.svelte 已知 svelte-eslint-parser 缺失问题)。

### Future execution queue (in order)

1. ~~Merge `test/w1-backfill` → main~~ (本批已随 W2 合并捎带 — 实际上 W1 work 全部进了主分支)
2. ~~Merge `test/w2-backfill` → main~~ ✅ (commit `3a3cb9f`)
3. P-W3-IMPL (W3 hybrid search + RRF + citations)
4. P-W3-TEST (test plan for W3)
5. P-W4-IMPL (Reranker + Query Rewrite + Indexer)
6. P-W4-TEST (test plan for W4+)
7. Manual E2E validation in Obsidian (M3 milestone)
8. ~~Merge `chore/translate-comments-to-chinese` → main~~ (本批已捎带,中文注释已随 W2 合并进主分支)
9. **Follow-up:** fix `svelte-eslint-parser` config so `npx eslint src/` covers `*.svelte` files

---

## Superseded / Archived

*(none yet — moving here when a spec or plan is fully replaced)*
