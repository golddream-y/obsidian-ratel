# S-SR-LAYERING — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-08-19 — P-SR-LAYERING(PromptInjector 统一注入 + 记忆/Skill 分层 + 使用统计)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 1: 注入层骨架 | `src/prompts/injection/ids.ts` / `injector.ts`、`src/core/context-manager.ts` | ✅ | `1942ece` | INJECTION_SOURCE_IDS as const 元组;PromptInjector 注册/组装/ownBudgetBytes 兜底 |
| Task 2: 记忆 pinned 分层 + composer 预算 | `src/prompts/composer.ts`、`src/core/memory-store.ts`、`src/settings.ts` | ✅ | `1942ece` | `## 标题 [pinned]` 拆桶;pinned 恒注入;三档存量限制字段接线 |
| Task 3+4(合并派发): topics 自动注入 + Skill 分层/统计 | `src/skills/skill-activator.ts`、`src/core/usage-stats.ts`、`src/main.ts` | ✅ | `1942ece` | top-K 自动注入(默认 3);Discovery 相关性排序+截断 50;双命名空间计数 |
| Task 5: 统计 UI + i18n | `src/ui/memory-panel/MemoryPanel.svelte`、`src/i18n/{zh,en,types}.ts` | ✅ | `1942ece` | 面板主题行「命中 N 次」 |
| Task 6: ADR-016 + 架构文档 | `docs/adr/2026-08-19-layered-injection.md`、`docs/architecture/{overview,agent/prompt-management}.md` | ✅ | `1942ece` | ADR-016 分层注入;overview 目录树补 injection/ |
| 终审修复 | `src/settings/config-whitelist.ts` 等 | ✅ | `1942ece` | memoryTopicsAutoInjectK 登记白名单;ADR 背景字段清单纠错;pinned 围栏内 `#` 行误判;search_memory 上限热生效(getter);topics 计数批量写盘 |

**测试总数:** 1222(新增 7 个测试文件 + 若干用例;含回归补强)
**分支:** `feat/p-sr-layering`(worktree 已清理,分支已删除)
**Squash:** 原 `6b00d31` → 历史改写后并入 develop `1942ece`,随 0.4.0 发版
**Plan 偏差:** Task 3+4 合并派发给同一 subagent(usageStats 依赖耦合);Task 5+6 同步合并;审查新增批量写盘优化与断言补强
**文档同步:** CHANGELOG(3 Added + 1 Changed + 2 Fixed)/ README 双语底座 bullet / user-guide 第 6 节补充 — commit `f8de13c`(后随 squash 并入)
