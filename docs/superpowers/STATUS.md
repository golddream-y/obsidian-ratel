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
| P-W1-TEST-BACKFILL | [2026-06-14-ratel-w1-test-backfill.md](plans/2026-06-14-ratel-w1-test-backfill.md) | 🔄 In Progress | test/w1-backfill | 2026-06-14 | — | S-TEST-ARCH (W1 backfill) |
| P-W2-TEST-BACKFILL | [2026-06-14-ratel-w2-test-backfill.md](plans/2026-06-14-ratel-w2-test-backfill.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W2 backfill) |
| P-W3-TEST | [2026-06-14-ratel-w3-test-plan.md](plans/2026-06-14-ratel-w3-test-plan.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W3 plan) |
| P-W4-TEST | [2026-06-14-ratel-w4-test-plan.md](plans/2026-06-14-ratel-w4-test-plan.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W4 plan) |

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
| T5: Agent Loop mid-stream + multi-round | 🔄 In Progress | — | — |
| T6: Final verify + docs update | ⏳ Pending | — | — |

**Current state:** 91/91 tests passing across 13 files (was 75 at start, +16 from W1 backfill T1-T4).

### Future execution queue (in order)

1. Finish T5, T6 of P-W1-TEST-BACKFILL (this branch)
2. P-W2-TEST-BACKFILL (6 tasks)
3. P-W3-IMPL (W3 hybrid search + RRF + citations)
4. P-W3-TEST (test plan for W3)
5. P-W4-IMPL (Reranker + Query Rewrite + Indexer)
6. P-W4-TEST (test plan for W4+)
7. Manual E2E validation in Obsidian (M3 milestone)

---

## Superseded / Archived

*(none yet — moving here when a spec or plan is fully replaced)*
