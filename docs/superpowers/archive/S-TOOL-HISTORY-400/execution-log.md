# S-TOOL-HISTORY-400 — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。

---

## 2026-07-15 — P-TOOL-HISTORY-400(compact 对齐 + DeepSeek sanitize)

| Task / Group | 文件 | 状态 | 备注 |
|---|---|---|---|
| align/sanitize | `src/core/tool-message-align.ts` | ✅ | 丢弃孤立 role=tool |
| compactSession | `compact-session.ts` | ✅ | 保留窗口 align |
| DeepSeek | `llm-deepseek.ts` | ✅ | buildRequestBody 前 sanitize |

**测试:** tool-message-align / compact-session / llm-deepseek green  
**分支:** main  
**Plan 偏差:** 未分步 commit

---
