# S-RENDER-STABILITY — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。分期 A+B 已合入 develop;`fe52523`。分期 C(vectra 卸载 / 会话窗口 / 动效审计)另开 spec,不在本目录续写。

---

## 2026-09-16 — P-RENDER-STABILITY-B(单次 load + Worker 空闲回收)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| ContextManager.load 同 id 幂等 | `src/core/context-manager.ts` | ✅ | `5f667b0` | 二次 load 不打 persistence |
| EmbeddingWorker 惰性 / 空闲 / 崩溃重建 | `embedding-worker-proxy.ts` | ✅ | `5d69681` | idle 5min;`dead` 两次 init 失败 |
| Worker init 抛错后可重建 | 同上 | ✅ | `1a04104` | postMessage 抛错不得挂死 |
| ask 复用 preloadedContext | `src/main.ts` / ChatView | ✅ | `8898f39` | 一次发送只解析一遍 JSON |
| 预发送 compact 后换新 ctx | ChatView | ✅ | `74833cc` | 同 id load 幂等,旧 preCtx 会丢 marker |
| Worker 重建读新模型缓冲 | proxy / main 工厂 | ✅ | `4046faf` | transfer 会掏空旧 ArrayBuffer |
| 预热后也走空闲回收 | `ensureReady` + idle timer | ✅ | `e112cf2` | |
| 溢出压缩打在当前 ask ctx | `src/main.ts` | ✅ | `fe52523` | 另 new+load 会被 save 盖掉 |

**测试:** 聚焦 5 文件 103 通过(合入 develop 后复测)
**分支:** `feat/p-render-stability-b` 快进合入 develop `fe52523`(本地功能分支已删)
**Plan 偏差:** Wave 2 因共用 `main.ts` 改为串行;溢出压缩路径未写进原 Task,预合并审查补修

---

## 2026-09-15 — P-RENDER-STABILITY-A(面包屑 + 内存阈值 + 空索引跳过 embed)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 面包屑开关与 i18n | settings / zh+en | ✅ | `269170b` | `diag/` gitignore |
| 空索引跳过自动 embed | `memory-topics-auto-inject.ts` | ✅ | `bab05bc` | |
| 面包屑内核 + 异常退出检测 | `src/logging/breadcrumbs.ts` | ✅ | `55a068a` | 心跳不改 lastPhase |
| 测试纳入默认收集 | breadcrumbs.test.ts | ✅ | `546938a` | |
| 发送与 Loop 打点 | main / agent-loop / ChatView | ✅ | `781527c` | onBreadcrumb 挂 UserChatRequest |
| 诊断页上次运行 + 反馈 40 行 | diagnostics / feedback | ✅ | `446c70f` | 不含正文 |
| README 隐私一句 | README | ✅ | `5f9c809` | 只存本地插件目录 |

**测试:** A 合入前 vitest;已知 skill-sandbox JSON 引号失败为存量
**分支:** `feat/p-render-stability-a` squash/合入 develop `446c70f`
**Plan 偏差:** `plugin.diagnostics` 落地为 `lastRunDiag` + `memoryHigh` + `readRecentLines()`
