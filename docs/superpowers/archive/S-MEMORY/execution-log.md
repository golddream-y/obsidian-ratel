# S-MEMORY — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-07-06 — P-MEMORY-LOGIC(用户记忆系统核心逻辑)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| T1 MemoryStore 骨架 | `src/core/memory-store.ts` | ✅ | 8f05c09 | 两层结构 + 独立向量索引 |
| T2 read/write/delete | `src/core/memory-store.ts` | ✅ | 8f05c09 | global + topic + index |
| T3 search_memory 工具 | `src/tools/search-memory.ts` | ✅ | 8f05c09 | 向量检索 topics/ |
| T4 remember 工具 | `src/tools/remember.ts` | ✅ | 8f05c09 | 写入 global 或 topic |
| T5 forget_memory 工具 | `src/tools/forget-memory.ts` | ✅ | 8f05c09 | 按 match 字符串删除 |
| T6 ContextManager 注入 | `src/core/context-manager.ts` | ✅ | 8f05c09 | setMemoryContext + toMessages 插入 |
| T7 main.ts 装配 | `src/main.ts` | ✅ | 8f05c09 | 启动时读 global + index |
| T8 单元测试 | `tests/core/memory-store.test.ts` | ✅ | 8f05c09 | 36 tests |

**代码审查修复(Critical + Important):**

| 级别 | 问题 | 修复 |
|---|---|---|
| C1 | `topic` 参数无路径校验,可注入 `../` 越权读写 | 新增 `validateTopicName()`,5 条规则 + 入口校验 |
| C2 | `upsertToIndex` 走 vectra 内部 embeddings,但 vectra 未配 embedding 模型 | 注入 `EmbeddingPort`,改用 `embeddingPort.embed + upsertItem` |
| I1 | 3 个 memory 工具未加入 `toolPermissions` 默认值 | 加 `search_memory: 'allow'` / `remember: 'ask'` / `forget_memory: 'ask'` |
| I2 | `composeMemorySystemPrompt` 硬编码中文模板 | 新增 `memory.systemPrompt` section,支持 override |
| I3 | 无容量上限,记忆可无限增长 | 10MB 存储上限 + 20KB 注入截断 |
| I4 | memory 注入未用 wrapper 包裹 | 复用 retrieval wrapper 前后缀(prompt injection 防护) |

**测试总数:** 36 新增 memory-store 测试 + 全套 609 passed / 7 failed(均为 pre-existing,与本次变更无关:DeepSeek 401 auth / path-safety configDir / grep literal / list-files .obsidian)
**分支:** main
**Plan 偏差:** 无(8 Task 全部按计划完成)
**Commit:** `8f05c09 feat(memory): 用户记忆系统 — global + topic 两层结构 + 3 个工具`(squash 3 subagent commit + 文档同步 amend)
**文档同步:** README(中英)+ user-guide(中英 FAQ)+ ARCHITECTURE.md(目录结构 + 8.4 Memory 子系统小节)+ CHANGELOG(Unreleased)。ADR 无需更新(决策沿用已有模式)。

---
