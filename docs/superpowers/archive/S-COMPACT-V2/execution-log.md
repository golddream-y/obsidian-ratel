# S-COMPACT-V2 — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-08-13 — P-COMPACT-V2（投影压缩，不改聊天记录）

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| Task 1 投影纯函数 | `compact-project.ts` | ✅ | 已 squash | `projectView` / microcompact / 断路器 |
| Task 2 toMessages 走投影 | `context-manager.ts` | ✅ | 已 squash | `trimHistory` 只裁 tail |
| Task 3 compactSession 写标记 | `compact-session.ts` | ✅ | 已 squash | 废除 `resetSession` |
| Task 4 UI 分隔 + 手动压 | `ChatView.svelte` | ✅ | 已 squash | 删确认框；hydrate markers |
| Task 5 默认自动压 | `compact-auto.ts` / settings | ✅ | 已 squash | 85%；断路 3 次 |
| Task 6 CONTEXT_OVERFLOW 重试 | `agent-loop.ts` / `ask()` | ✅ | 已 squash | `skipAddUserMessage` |
| Task 7 文档扫尾 | user-guide | ✅ | 已 squash | 确认框 i18n 清除 |
| 整支修复 | `untilIndex` / `compact.applied` | ✅ | 已 squash | 溢出不把当前 user 写进 marker；切场不串写；占用走投影 |

**测试总数:** 946（合入 develop 后全量）  
**分支:** `feat/p-compact-v2` → squash 合入 `develop` (`9fbe73c`)  
**Plan 偏差:** 溢出 compact 增加 `untilIndex`，避免重试时 tail 为空；`ask` 增加 `compact.applied` 事件刷新 UI 分隔。

---
