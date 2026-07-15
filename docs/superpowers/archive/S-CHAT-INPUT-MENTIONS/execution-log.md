# S-CHAT-INPUT-MENTIONS — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-07-15 — P-CHAT-INPUT-MENTIONS(`/` + `@` + file-menu)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| mention-parser/suggest | `src/ui/chat/input/*` | ✅ | — | 纯函数 + 测 |
| MentionMenu/Strip | Svelte | ✅ | — | i18n |
| ChatView 接线 | ChatView.svelte/ts | ✅ | — | 互斥 / debounce |
| file-menu | main.ts | ✅ | — | 添加到 Ratel |
| 绝对路径防御 | parser + paste | ✅ | — | Notice |
| 状态三重叠修复 | ChatView/StatusLine | ✅ | — | 同会话 follow-up |

**测试:** mention + compact 相关 green  
**分支:** main  
**Plan 偏差:** 未按 plan 分步 commit(用户要求统一提交)

---
