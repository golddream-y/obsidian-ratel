# S-INDEX-STARTUP — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-06-30 — P-INDEX-STARTUP(smart reindex 启动路径 + manifest 持久化)

**分支:** `feat/s-index-startup`(worktree `.worktrees/feat-s-index-startup`,已清理)
**squash 合并 commit:** `79e694e`(feat(index): 实现智能重算启动路径)
**后续修复 commit:** `4760ee0`(fix(index): 修复 smartReindex 三个健壮性缺口) + `9ee1a4b`(feat(index): 适配 Diffing 状态文案与设置面板重启提示)

### Task 完成情况

| Task | 文件 | 状态 | 备注 |
|---|---|---|---|
| 1 | `src/core/index-manifest.ts` | ✅ | IndexManifest 类 — load/save 原子写 |
| 2 | `src/core/index-manifest.ts` | ✅ | diff/recordEntry/removeEntry/invalidate/shouldFullRebuild |
| 3 | `src/adapters/vector-vectra.ts` | ✅ | deleteByPath(绕过 vectra catalog bug,改用 deleteItems) |
| 4 | `src/worker/index-processor.ts` + `handler.ts` + `types.ts` | ✅ | indexBatch + reembedFile + Worker 协议 |
| 5 | `src/core/index-manager.ts` | ✅ | IndexBackend 扩展 + Diffing 状态 + smartReindex |
| 6 | `src/main.ts` | ✅ | 装配 IndexBackend.smartReindex + onLayoutReady 解耦 P3 |
| 7 | `tests/integration/index-startup.test.ts` | ✅ | 10 个集成测试场景 |
| 8 | 全量测试 + build 验证 | ✅ | 472 passed,4 pre-existing failed |

### 后续缺口修复(合并后审查发现)

| 缺口 | spec 违规 | 修复 commit |
|---|---|---|
| `/reindex` 不清 manifest | §4.4 | `4760ee0` — reindex 先 dropIndex + invalidate 再 onLayoutReady |
| `.index/` 损坏无降级 | §9 | `4760ee0` — smartReindex try-catch 降级全量重建 |
| `autoIndex=false` 仍跑 smartReindex | §5.7 | `4760ee0` — onLayoutReady(autoIndex) gate |
| mtime 快速跳过未实现 | §4.2 | `4760ee0` — mtime 未变复用旧 hash |
| Diffing 文案未适配 | §5.6 | `9ee1a4b` — 状态条加"检查变更中" |
| 设置面板无重启提示 | §7 | `9ee1a4b` — embedProvider/chunkSize/chunkOverlap 加提示 |

### 关键技术决策

1. **VectraStore catalog 旁路 bug**:`upsertItem` 不写 vectra 内部 catalog(`uriToId` map),`deleteDocument(uri)` 依赖 catalog 查找 → 静默返回不删除。`deleteByPath` 改用 `index.deleteItems(itemIds)` 按 `metadata.path` 过滤。`indexDelete` 同源 bug 加 FIXME 待修。
2. **IndexManifest 独立于 data.json**:与 `.index/` 同目录同生命周期,原子写避免半写损坏。详见 [ADR-007](../../../adr/2026-06-28-index-manifest-standalone-file.md)。
3. **smartReindex 委托模式**:IndexManager 只检查 `backend.smartReindex` 方法存在性,实现细节委托给 main.ts(core 层不依赖 IndexManifest)。

### Plan 偏差

- Task 3 的 `deleteByPath` 实现与 plan 不同(plan 用 `this.delete(ids)` + `metadata.documentId`,实际改用 `index.deleteItems(itemIds)` + `r.item.id`)— 因发现 vectra catalog 旁路 bug
- Task 4 的 `indexDelete` 同源 bug 加 FIXME,未在本次修复(deferred)
- `autoIndex` 接线(spec §5.7)在合并后审查时补做,非原 plan 范围

**测试总数:** 472 passed(合并时)/ 478 passed(缺口修复后)
**架构文档同步:** worker-protocol.md + vector-index.md + obsidian-integration.md(commit `d64e839`)+ ADR-007
