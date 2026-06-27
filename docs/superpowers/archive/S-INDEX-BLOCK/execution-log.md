# S-INDEX-BLOCK — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-06-27 — P-INDEX-BLOCK(索引阻塞 UI 修复:批量 embed + Web Worker)

| Task | 文件 | 状态 | Commit | 备注 |
|------|------|------|--------|------|
| Task 1 | `src/ports/vector.ts`、`src/adapters/vector-vectra.ts`、`tests/adapters/vector-vectra.test.ts` | ✅ | `b22dab7` | VectraStore 新增 `upsertItem` + 事务方法,支持预计算向量写入 |
| Task 2 | `src/worker/index-processor.ts`、`tests/worker/index-processor.test.ts` | ✅ | `2f65ffb` | IndexProcessor 改为批量 embed + upsertItem,ONNX 调用从 N 降到 N/16 |
| Task 3 | `src/worker/handler.ts`、`src/worker/inline-worker.ts`、`tests/worker/{handler,inline-worker}.test.ts` | ✅ | `0d35a6f` + `ebaa549` | handler/inline-worker 传递 `embeddingPort` 参数 |
| Task 4 | `src/adapters/embedding-worker-proxy.ts`、`tests/adapters/embedding-worker-proxy.test.ts` | ✅ | `f091307` | EmbeddingWorkerProxy — 实现 EmbeddingPort 代理,postMessage 到 Web Worker |
| Task 5 | `src/worker/embedding-worker.ts`、`tests/worker/embedding-worker.test.ts` | ✅ | `b1f1087` | embedding-worker.ts — Web Worker 入口,ONNX 推理在 Worker 线程 |
| Task 6 | `esbuild.config.mjs` | ✅ | `0e9c017` | esbuild 新增 `embedding-worker.js` 打包入口(platform: browser, format: iife) |
| Task 7 | `src/core/model-manager.ts`、`src/main.ts` | ✅ | `ede2a04` + `bfa7904` | main.ts 集成 EmbeddingWorkerProxy + ModelManager.getDeps() 重新读盘 |
| Task 8 | `docs/superpowers/STATUS.md` | ✅ | `b87ca75` | 全量验收:build 三产物 / 426 测试通过 |

**测试总数:** 426(实施前 396,新增 30 个;3 个预存 401 认证失败无关)
**分支:** `feat/index-blocking-fix` → fast-forward 合并到 main,分支已删除
**Plan 偏差:**
- Task 1 spec 代码有 bug:`upsertItem` metadata 缺 `documentId`,导致 search() 跳过。实现者修正
- Task 1 code review 发现 `endFileUpdate` 漏更新 `_lastIndexTime`,补上
- Task 2 `status()` 改用 `getIndexStats().items` 替代 `getCatalogStats().documents`(upsertItem 绕过 catalog),`totalDocs` 语义漂移为 chunk 数,UI 文案待同步

### 审查与修复

| 级别 | 问题 | 修复 | Commit |
|------|------|------|--------|
| Bug | `getResourcePath()` 返回 `app://<hash>/...` 与页面 origin `app://obsidian.md` 跨 origin,Web Worker SecurityError | 改用 Blob URL 模式:`fs.readFileSync` → `Blob` → `URL.createObjectURL` 生成同源 `blob:` URL | `344a747` |
| Bug | 路径拼装多写 `/dist` 前缀(插件产物直接在 `manifest.dir` 下,无 `dist/` 子目录) | 去掉 `/dist`,改用 `adapter.getFullPath(this.manifest.dir + '/embedding-worker.js')` | `344a747` |
| 重构 | M1 阶段 `createEmbeddingsVectraStore` 调用冗余 | 移除 | `e77b645` |

**关键 commit 链:** `b8b05b6`(spec+ADR) → `2706638`(plan) → `b22dab7`...`ede2a04`(Task 1-7) → `bfa7904`(spec 合规修复) → `b87ca75`(STATUS) → `344a747`(Blob URL 修复)

**Deferred 改进项(非阻塞):**
- `totalDocs` 语义漂移:UI 文案从"文档数"改为"块数"或在 VectraStore 维护文档计数
- 回滚测试补充:覆盖事务中失败场景
- EmbeddingWorkerProxy 测试补充:init 失败、embed 业务错误、并发 embed
- embedding-worker.ts 测试补充:embed 成功路径、init 失败路径
