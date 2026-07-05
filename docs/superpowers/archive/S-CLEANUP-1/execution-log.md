# S-CLEANUP-1 — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-07-05 — P-CLEANUP-1(杂项缺失修复与技术债清理)

**所属 Spec:** S-CLEANUP-1
**分支:** `feat/s-cleanup-1`(已删除)
**Squash Commit:** `3590b23 feat: P-CLEANUP-1 杂项缺失修复与技术债清理`(在 main,55 files, +1912/-208)
**测试结果:** 全部通过(Task 17-24 累计新增测试约 8 条,全部 PASS)

### 执行概述

24 Task 全部完成,采用 Subagent-Driven 模式(每个 task 独立 implementer + 两阶段 review:spec 合规 + 代码质量)。简单任务(纯文档/文案)合并为单次 review。

### Task 列表(本次执行的 Task 17-24;Task 1-16 在前一会话完成)

| Task | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 17 | `tests/tools/read-note.test.ts` | ✅ | `27aa310` | 5 个测试描述中文化(行为 - 条件 - 期望结果) |
| Task 18 | `src/tools/read-note.ts` + test | ✅ | `7baf4d2`(amend) | `as string` 改 `requireString`,补 path 缺失测试。Review 发现 import 空行问题,amend 修复 |
| Task 19 | `src/worker/index-processor.ts` | ✅ NO-OP | — | 预验证发现 FIXME 已移除、bug 已修复、测试已覆盖,无需改动 |
| Task 20 | `src/worker/index-processor.ts` + `src/core/index-manager.ts` + `src/main.ts` | ✅ | `e333f46`(amend) | 增量索引返回 chunkCount,main.ts 写 manifest。Review 发现 errors>0 时 chunkCount 污染,amend 加 `errors === 0` 守卫 |
| Task 21 | `src/ui/diagnostics/embedding-test.ts` | ✅ | `21de272` | 4 处"文档"改"块"(纯文案) |
| Task 22 | `tests/adapters/vector-vectra.test.ts` | ✅ | `0e42d4b` | 新增 3 测试:cancelFileUpdate 回滚 × 2 + deleteByPath 文件不存在 × 1(共 19/19 PASS) |
| Task 23 | `tests/adapters/embedding-worker-proxy.test.ts` | ✅ | `58215e6` | 新增 3 测试:init 失败 + embed 业务错误 + 并发请求 ID 不串扰 |
| Task 24 | `tests/worker/embedding-worker.test.ts` | ✅ | `19e85d9` | 新增 2 测试:embed 成功返回向量 + init 失败返回错误 |

### 文档同步(finishing-a-development-branch Step 0)

| 文件 | Commit | 改动 |
|---|---|---|
| `docs/user-guide.md` | `1d543bf` | 中英文段补 `/pause` `/resume` `/dropIndex` 命令 + 更新 `/model` 描述(切换→查看) |

### Plan 偏差

1. **Task 19 NO-OP**:plan 要求修复 `indexDelete` 的 FIXME,但预验证发现代码已修复(FIXME 已移除,`indexDelete` 已委托 `store.deleteByPath()`,3 个 deleteByPath 测试已覆盖)。直接标记 NO-OP,未派遣 implementer。
2. **Task 18 import 空行**:implementer 添加 `import { requireString }` 时多了一行空行,与其他工具文件(grep.ts)不一致。Review 指出后 amend 修复(commit `ebc6c59` → `7baf4d2`)。
3. **Task 20 chunkCount 污染**:implementer 初版未处理 errors>0 时 chunkCount 仍写入 manifest 的问题。Review 指出后,main.ts 加 `errors === 0` 守卫,amend 修复(commit `3d6b510` → `e333f46`)。
4. **Task 20 额外测试文件**:implementer 创建了 `tests/core/incremental-manifest-update.test.ts`(plan 未要求),作为 untracked 保留,未 commit。本次归档时该文件仍在工作区(随 stash pop 恢复)。

### 预先存在的问题(非本次任务引入)

- `tests/adapters/llm-deepseek.test.ts` 3 个测试 401 鉴权错误 — 在所有 base commit 上都失败
- `src/main.ts:9` `'Notice' is defined but never used` lint 警告
- `tests/adapters/embedding-worker-proxy.test.ts` 4 处 `(global as any)` lint 警告(3 处预存在 + 1 处 Task 23 新增,均沿用预存在模式)

### 协议变更评估(Task 20)

Worker `index.done` payload 增加了 `chunkCount` 运行时字段。未修改 `types.ts` 中的 payload type(避免影响 `index.full` 路径)。main.ts 用 `as { chunkCount?: number }` 安全断言访问。评估为向后兼容的字段补充,不触发 ARCHITECTURE.md / adr 更新(满足 AGENTS.md「不触发」条款:内部协议字段补充,不改变消息类型与判别联合)。

### 合并方式

用户指示:`都做完之后 git commit 做一下 square 然后再合并回去`。

执行:
1. `git stash push --include-untracked`(保存 pre-existing modified/untracked)
2. `git checkout main`
3. `git merge --squash feat/s-cleanup-1`(55 files staged)
4. `git commit` → commit `3590b23`
5. `git branch -D feat/s-cleanup-1`(squash merge 不算"真正"合并,需 -D)
6. `git stash pop`(恢复 pre-existing work)
7. 更新 STATUS.md 标记 ✅ Completed
8. 归档 spec/plan 到 `archive/S-CLEANUP-1/`(本文件)

---

(无更早执行记录 — 本 spec 仅此一个 plan)
