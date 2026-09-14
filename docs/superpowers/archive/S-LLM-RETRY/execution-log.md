# S-LLM-RETRY — 执行日志(按时间倒序)

> 该 spec 的实施记录。最新在前。
> 策略随 0.7.1 发版(`wrapLlmChatRetry`)。打字行提示见仍活跃的 [S-LLM-RETRY-UI](../../specs/2026-09-11-llm-retry-status-design.md)。无独立 plan 文件(随 0.7.1 合入)。

---

## 2026-09-14 — 归档

策略层已随 `0.7.1` 发版。主表移除 S-LLM-RETRY。MCP 出站重试不在范围,重启须另开 spec。

---

## 2026-09-11 — 策略落地(无独立 plan)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 可恢复网络/网关错误退避 | `src/core/llm-chat-retry.ts` | ✅ | 随 `c8673d8` 0.7.1 | 最多 3 次;已 yield 不重试;UI 另见 S-LLM-RETRY-UI |

**发版:** `0.7.1`
