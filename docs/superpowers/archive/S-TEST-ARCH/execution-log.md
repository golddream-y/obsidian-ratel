# S-TEST-ARCH — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-06-14 — P-TEST-ARCH-COMPL(测试架构收口)

| Task | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| T1: Settings L1 DEFAULT_SETTINGS 完整性 | `tests/settings.test.ts` | ✅ | `c083242` | 19 字段覆盖 + 类型 + 数值范围;4 tests |
| T2: Settings L1 旧版迁移 | `tests/settings-migration.test.ts` | ✅ | `26b849a` | embedModel 兼容性 + 缺省 raw;4 tests |
| T3: Worker L1 handleMessage 抽离 | `src/worker/handler.ts` + `src/worker/index.ts` + `tests/worker/handler.test.ts` | ✅ | `e1eed33` | refactor:从 index.ts 提到独立模块可单测;4 tests |
| T4: Worker L1 WorkerManager timeoutMs 可配置 | `src/worker/manager.ts` + `tests/worker/worker-bridge.test.ts` | ✅ | `833098a` | 加 `WorkerManagerOptions.timeoutMs`,超时后 terminate;+2 tests |
| T5: Settings L2 embedProvider 切换 | `tests/settings-adapter.test.ts` | ✅ | `46b7d73` | Object.create 绕过 Obsidian 框架;5 tests |
| T6: 跨维度集成 settings 变更传播 | `tests/integration/settings-propagation.test.ts` | ✅ | `0f9c729` | 改 field → rebuild → 新 config 注入;5 tests |
| T7: 更新 test-architecture.md 状态 + STATUS | `docs/superpowers/specs/2026-06-14-ratel-test-architecture.md` + `docs/superpowers/STATUS.md` | ✅ | (squash `88e346d` 包含) | Settings 维度 4/5 → 5/5;Worker 维度 4/7 → 7/7 |
| Squash + 合并 | (7 commits → 1) | ✅ | `88e346d` (squash) / `f77d777` (merge) | `git reset --soft c378b5a` 后单 commit,再 `--no-ff` 合并到 main |

**测试总数:** 103 → 127(+24),跨 19 个测试文件。
**build:** 绿;**新增文件 lint:** 6/6 干净(0 errors)。项目 2023 个 pre-existing lint errors 留待后续。
**关键路径注释:** 7 个新测试文件 + 1 个新模块 + 2 个模块改 API,都按 AGENTS.md 中文规范加 JSDoc + `关键路径:` 注释。
**Plan 偏差:**
- T3 plan Step 4 期望"原有测试 3 个都过",实际加 T3 改了 worker/index.ts,需要 sync 改主 checkout(后续未污染 main,主 checkout git 已恢复)。
- T4 plan 期望 `vi.useFakeTimers()`,vitest 4.x 跟 async microtask 配合有问题,改用真实 50ms timeout(更稳)。

**分支:** `test/test-arch-completion`(worktree `.worktrees/test-arch-completion/`,**已合并并删除**)。

---

## 2026-06-14 — P-W2-TEST-BACKFILL(W2 RAG 测试回填)

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

---

## 2026-06-14 — P-W1-TEST-BACKFILL(W1 测试回填)

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

---

## 2026-06-14 — P-W3-TEST / P-W4-TEST(已 Superseded,未执行)

> W3/W4 测试计划,基于旧架构(手动两路搜索 + RRF)编写。
> W3/W4 实施时 vectra 内置 `isBm25` 混合搜索取代了手动两路搜索,设计前提变化,
> 测试已在各自实现 plan(P-W3-HYBRID / P-W4-RAG)中随实现一并覆盖。
>
> 此条目保留为历史档案,文件见:
> - `2026-06-14-ratel-w3-test-plan.md`
> - `2026-06-14-ratel-w4-test-plan.md`
>
> 新架构下的测试覆盖见:
> - [archive/S-W3-HYBRID/execution-log.md](../S-W3-HYBRID/execution-log.md)
> - [archive/S-W4-RAG-ENHANCEMENT/execution-log.md](../S-W4-RAG-ENHANCEMENT/execution-log.md)
