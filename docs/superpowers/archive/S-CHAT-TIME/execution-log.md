# S-CHAT-TIME — 执行日志(按时间倒序)

> 该 spec 的所有 plan 实施记录。最新在前。随 0.8.0 发版。

---

## 2026-09-17 — P-CHAT-TIME(跨日分割线 + 列表日历 + env 距上一轮)

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| T1 日历纯函数 + i18n | `src/utils/chat-time.ts` | ✅ | `20ce124` | |
| T2 createdAt 落盘 / 出站剥离 | `context-manager.ts` / `llm.ts` | ✅ | `3c560d4` | |
| T3 load 后 refreshEnvContext | `agent-loop.ts` / `main.ts` | ✅ | `fa87805` | 删 ask 双源 env |
| T4+T5 hydrate / 日线 / 会话列表 | MessageList / ChatView / SessionMenu | ✅ | `5a80f01` | |
| T6 文档一句 | persistence.md / user-guide | ✅ | `0a1bd96` | |
| compact.applied 保留 createdAt | ChatView | ✅ | `f8399c1` | 审查 Important |
| skipAdd 排除本轮 user | refreshEnvContext `excludeLatestUser` | ✅ | `92115e4` | 整支审查 Important |
| 日线发丝布局 + `{@const}` 能编译 | MessageList / SessionMenu | ✅ | 随 0.8.0 | 合入后预览修 |

**测试:** chat-time / context-manager / agent-loop / hydrate 绿；全量 skill-sandbox JSON 引号为 develop 存量失败，与本 plan 无关
**分支:** `feat/p-chat-time` 快进合入 develop `5d7711d`，随后 0.8.0
**Plan 偏差:** Wave 2 将 T4–T6 并成一路；日线视觉从压缩条带改为两侧发丝线
