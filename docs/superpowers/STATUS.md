# Spec 与 Plan 状态追踪表

> **用途:** `docs/superpowers/` 下所有 spec / plan 的唯一事实源。每当新建 spec / plan、状态变化、执行完成时更新。
>
> **维护规则:** 下列情况必须更新本文件:
> 1. 新建 spec(状态:Draft → Active)
> 2. 从 spec 衍生 plan(状态:Pending)
> 3. plan 开始执行(状态:In Progress)
> 4. plan 执行完成(状态:Completed / Blocked / Abandoned)
> 5. spec 被取代(链接替代者)
>
> **Owner 约定:** 文件创建者必须在同一次提交里更新本表。

---

## 活跃 Spec(设计 / 架构文档)

| ID | 文件 | 状态 | 创建日期 | 备注 |
|---|---|---|---|---|
| S-ARCH-001 | [2026-06-07-architecture-feasibility-review-design.md](specs/2026-06-07-architecture-feasibility-review-design.md) | Active | 2026-06-07 | 初始架构可行性设计 |
| S-MODEL-001 | [2026-06-13-model-config-and-local-inference-design.md](specs/2026-06-13-model-config-and-local-inference-design.md) | Active | 2026-06-13 | 模型配置 + 本地推理设计 |
| S-RAG-ROADMAP | [2026-06-13-rag-enhancement-roadmap-design.md](specs/2026-06-13-rag-enhancement-roadmap-design.md) | Active | 2026-06-13 | RAG 三阶段路线图 |
| S-RAG-ARCH | [2026-06-14-ratel-rag-architecture.md](specs/2026-06-14-ratel-rag-architecture.md) | Active | 2026-06-14 | 最终 RAG 架构(取代 S-RAG-ROADMAP 中的初步想法) |
| S-TEST-ARCH | [2026-06-14-ratel-test-architecture.md](specs/2026-06-14-ratel-test-architecture.md) | Active | 2026-06-14 | 按功能维度划分的测试架构 + 4 个里程碑 |

---

## 实施 Plan(任务拆解)

| ID | 文件 | 状态 | 分支 | 启动 | 完成 | 所属 Spec |
|---|---|---|---|---|---|---|
| P-W1-IMPL | [2026-06-13-ratel-w1-implementation.md](plans/2026-06-13-ratel-w1-implementation.md) | ✅ Completed | (merged) | 2026-06-13 | 2026-06-13 | S-ARCH-001 (W1 切片) |
| P-W2-IMPL | [2026-06-13-ratel-w2-implementation.md](plans/2026-06-13-ratel-w2-implementation.md) | ✅ Completed | (merged) | 2026-06-13 | 2026-06-13 | S-MODEL-001, S-RAG-ARCH (W2 切片) |
| P-W3-IMPL | [2026-06-13-ratel-w3-implementation.md](plans/2026-06-13-ratel-w3-implementation.md) | ⏳ Pending | — | — | — | S-RAG-ARCH (W3 切片) |
| P-W4-IMPL | [2026-06-13-ratel-w4-implementation.md](plans/2026-06-13-ratel-w4-implementation.md) | ⏳ Pending | — | — | — | S-RAG-ARCH (W4 切片) |
| P-W1-TEST-BACKFILL | [2026-06-14-ratel-w1-test-backfill.md](plans/2026-06-14-ratel-w1-test-backfill.md) | ✅ Completed | test/w1-backfill | 2026-06-14 | 2026-06-14 | S-TEST-ARCH (W1 回填) |
| P-W2-TEST-BACKFILL | [2026-06-14-ratel-w2-test-backfill.md](plans/2026-06-14-ratel-w2-test-backfill.md) | ✅ Completed | test/w2-backfill → main (`3a3cb9f`) | 2026-06-14 | 2026-06-14 | S-TEST-ARCH (W2 回填) |
| P-W3-TEST | [2026-06-14-ratel-w3-test-plan.md](plans/2026-06-14-ratel-w3-test-plan.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W3 计划) |
| P-W4-TEST | [2026-06-14-ratel-w4-test-plan.md](plans/2026-06-14-ratel-w4-test-plan.md) | ⏳ Pending | — | — | — | S-TEST-ARCH (W4 计划) |
| P-DOCS-CN | (无 — 杂项) | ✅ Completed | chore/translate-comments-to-chinese | 2026-06-14 | 2026-06-14 | AGENTS.md § 文档与注释规范 |

---

## 状态图例

- ⏳ **Pending** — Plan 已创建,未启动
- 🔄 **In Progress** — 已开始执行,subagent-driven-development 进行中
- ✅ **Completed** — 所有任务完成,测试通过,分支已合并或待合并
- ⛔ **Blocked** — 无法推进,需要人工介入
- 🚫 **Abandoned** — 中途停止,备注里写明原因

---

## 执行日志(按时间倒序)

### 2026-06-14 — W2 RAG 测试回填 (P-W2-TEST-BACKFILL)

| Task | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| T1: VectraStore 重复 upsert | `tests/adapters/vector-vectra.test.ts` | ✅ | `c8d3d52` | 升级为 `totalDocs === 1` + 搜索结果精确 1 个 |
| T2: VectraStore 空索引 | `tests/adapters/vector-vectra.test.ts` | ✅ | `c8d3d52` | search → `[]` / status → 0 |
| T3: EmbeddingApi 维度校验 | `tests/adapters/embedding-api.test.ts` + `src/adapters/embedding-api.ts` | ✅ | `73746a2` | TDD: RED → 实现 → GREEN;老 mock 同步到 1024 维 |
| T4: Chunker Unicode / 代码块 / frontmatter | `tests/worker/chunker.test.ts` | ✅ | `530fb25` | 3 个新 case(代码块切分限制留作 W3) |
| T5: L2 RAG 端到端 | `tests/integration/rag-pipeline.test.ts` + `.gitignore` | ✅ | `df7b151` | 确定性 4 维 mock 嵌入 + 分数 > 0.5 |
| T6: 验证 + 文档 | `docs/superpowers/specs/2026-06-14-ratel-test-architecture.md` | ✅ | `bf32d2a` | RAG L1 10/12 → 12/12,L2 0/3 → 2/3 |
| Squash + 合并 | (5 commits → 1) | ✅ | `0b28df0` (squash) / `3a3cb9f` (merge) | `git reset --soft` 后单 commit,再 `--no-ff` 合并到 main |

**测试总数:** 93 → 103(+10),跨 14 个测试文件。

**分支:** `test/w2-backfill`(已合并并删除)。

**Plan 偏差:**
- T1 计划用 `toBeGreaterThanOrEqual(1)`(弱断言),升级为 `totalDocs === 1` + 搜索结果精确长度 1。
- T3 计划没考虑老 mock 向量维度问题(测试用了 3 维,新校验要求 1024 维);一并修复了 2 个老测试。
- T5 计划没提到 VectraStore 内部需要 embeddings 模型;为确定性分数改用确定性 4 维 mock 注入。

### 2026-06-14 — 中文注释翻译 (P-DOCS-CN)

| Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| G1: src/core/ | agent-loop, context-manager, hooks, tool-registry | ✅ | `69d4579` | JSDoc 类头 / 函数头 / 行内 |
| G2: src/ports/ | llm, persistence, embedding, vector, vault | ✅ | `69d4579` | 端口接口 5 个全部加 JSDoc |
| G3: src/adapters/ | llm-deepseek, obsidian-vault, vector-vectra, persistence-json, embedding-local, embedding-api | ✅ | `c0e2a23` | 关键路径 / 修复点 / 设计要点 注释 |
| G4: src/worker/ | index, manager, chunker | ✅ | `88cf8eb` | Worker 入口 + chunker 三级回退策略 |
| G5: 其他 | main, settings, types, tools/read-note, ui/ChatView.ts/.svelte, utils/hash | ✅ | `88cf8eb` + `6ff869a` | UI 与入口逐项加注释;lint 修复 |
| AGENTS.md § 4 | 需加注释的代码判定准则 | ✅ | `f3483a0` | 6 项强制 / 4 项推荐 / 4 项禁止 |

**合计:** 26 个源文件(src/ 全量)+ AGENTS.md 扩展 + STATUS.md 登记。

**分支:** `chore/translate-comments-to-chinese`(本批合并时捎带入 main)。

**验证:** 103/103 tests passing,build 绿,lint 干净(除 `ChatView.svelte` 已知 svelte-eslint-parser 缺失问题)。

### 2026-06-14 — W1 测试回填 (P-W1-TEST-BACKFILL)

| Task | 状态 | Commit | 备注 |
|---|---|---|---|
| T1: ToolRegistry isReadOnly + unknown error | ✅ | `87f402f` | Reviewer 发现重复测试,删除 + amend |
| T2: ContextManager before-load guards | ✅ | `dc0c442` | Reviewer 发现测试名误导,修正 |
| T3: PersistenceJson corrupt + concurrent | ✅ | `7a11ad8` | Reviewer 通过,带少量非阻塞意见 |
| T4: DeepSeekLLM SSE + multi tool_calls | ✅ | `e724423` | Reviewer 发现弱断言 + 误导注释,修正 |
| T5: Agent Loop mid-stream + multi-round | ✅ | `dd86b86` + `9e7f245` | 多轮 mock 修正 + 3 处 lint 清理(`9e7f245`) |
| T6: 最终验证 + 文档 | ✅ | `09cd253` | 93/93 全绿;build 绿;M1 L1 100% |

**当前状态:** 13 个测试文件 93/93 passing(W1 起始 75,+18)。M1(L1 单元测试夯实)达成:65/65(100%)。

**W1 backfill commit 区间:** `87f402f..HEAD`(分支 `test/w1-backfill`,本批合并时捎带入 main)。

### Future execution queue(按顺序)

1. ~~合并 `test/w1-backfill` → main~~(本批已随 W2 合并捎带 — 实际上 W1 work 全部进了主分支)
2. ~~合并 `test/w2-backfill` → main~~ ✅(commit `3a3cb9f`)
3. P-W3-IMPL(W3 混合检索 + RRF + 引用)
4. P-W3-TEST(W3 测试计划)
5. P-W4-IMPL(Reranker + Query Rewrite + Indexer)
6. P-W4-TEST(W4+ 测试计划)
7. 在 Obsidian 里手动 E2E 验证(M3 里程碑)
8. ~~合并 `chore/translate-comments-to-chinese` → main~~(本批已捎带,中文注释已随 W2 合并进主分支)
9. **后续:** 修 `svelte-eslint-parser` 配置,让 `npx eslint src/` 覆盖 `*.svelte` 文件

---

## 已取代 / 归档

*(暂无 — spec / plan 被完全取代时移到这里)*
