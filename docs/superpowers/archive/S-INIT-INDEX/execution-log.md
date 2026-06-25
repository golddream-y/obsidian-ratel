# S-INIT-INDEX — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-06-15 — P-INIT-INDEX(初始化嵌入 + 自动索引)

| Task | 文件 | 状态 | Commit | 备注 |
|------|------|------|--------|------|
| M-0 | `src/settings.ts`、`src/adapters/vector-vectra.ts`、`src/utils/gitignore-writer.ts` | ✅ | `b552df4` | settings 字段 + VectraStore 注入 + gitignore 自动写 + .ratelignore 解析 |
| M-1 | `src/worker/handler.ts`、`src/worker/index-processor.ts` | ✅ | `8d9835c` | Worker 6 个 case 真实现 + IndexProcessor + VectraStore 注入构造 |
| M-2 | `src/core/index-manager.ts` | ✅ | `73e81c2` | IndexManager 状态机 + 队列 + 暂停/恢复/重索引 |
| M-3 | `src/core/folder-watcher.ts` | ✅ | `7316622` | FolderWatcher 5s 单文件去抖 |
| M-4 | `src/core/index-controller.ts`、`src/ui/IndexBanner.svelte` | ✅ | `f624169` | IndexController 聚合 + IndexBanner Svelte |
| M-5 | `src/core/model-manager.ts`、`src/core/model-downloader.ts`、`src/utils/disk-checker.ts` | ✅ | `0c0456f` | ModelManager 状态机 + ModelDownloader + disk-checker |
| M-6 | `src/adapters/embedding-local.ts` | ✅ | `08080e5` | EmbeddingLocal 去懒加载 + 接受注入 + INDEX_NOT_READY |
| M-7 | `src/settings.ts`、`src/ui/*` | ✅ | `93748cd` | 多模型并存 + 切换 + 一键清理 |
| M-8 | `tests/integration/*` | ✅ | `e1fcbbd` | 集成测试覆盖 1000 文件首扫 / 降级矩阵 / 暂停恢复 / 模型下载 |
| Critical Fix | `src/core/index-manager.ts` | ✅ | `3a7abac` | snapshotForResume 读真实 paused 前状态(不再 hardcode) |
| Squash 合并 | 全部 | ✅ | `94eba47` | 13 commits squash-merge 到 main |

**测试总数:** 集成测试覆盖 1000 文件首扫 / 降级矩阵 / 暂停恢复 / 模型下载
**分支:** `feat/init-index`(已 squash 合并到 main)
**Plan 偏差:** 6 项(详见 commit `c82879f` 执行记录)
**执行记录:** [commit c82879f](#) — 11 commits + 6 plan 偏差 + 1 critical fix

---

## 参考文件

- Spec: [`2026-06-15-ratel-init-index-design.md`](./2026-06-15-ratel-init-index-design.md)
- Plan: [`2026-06-15-ratel-init-index.md`](./2026-06-15-ratel-init-index.md)
