# S-RUN-STATUS-PHASES — 执行日志(按时间倒序)

> 归档时汇总;详细记录见 git log。

---

## 2026-10-16 — 随 1.1.1 发版并归档

| Task / Group | 文件 | 状态 | Commit | 备注 |
|---|---|---|---|---|
| 新增 `message.request` 事件标记主 LLM 请求出站 | `src/types.ts` / `src/core/agent-loop.ts` | ✅ | `d3b0d87` | 每步在 `llm.chat()` 前 yield;意图分类那次小 LLM 调用不发此事件 |
| 忙态行显示门槛放宽:发送即出现(含意图分类期) | `src/ui/chat/ChatView.svelte` / `MessageList.svelte` | ✅ | `d3b0d87` | 由「运行中且末条是 assistant」改为「运行中且存在消息」;新增 `llmRequestInFlight` 状态 |
| 阶段推导与轮换分档(准备 4s / 在途 8s / 撰写 8s) | `src/ui/chat/message-stream/MessageList.svelte` | ✅ | `d3b0d87` | 阶段切入时 tick 归零并随机起点;相邻两拍强制不重复 |
| 状态行拼装改为三阶段优先级 | `src/ui/chat/run-status-line.ts` | ✅ | `d3b0d87` | `RunStatusInput.streaming` → `phase`;`RunStatusPhrases` 删 `wait`、增 `prepare` / `await` |
| 思考球新增忙态映射 | `src/ui/orbs/map-orb-state.ts` | ✅ | `d3b0d87` | `preparing` → `shaping`;`awaiting` → `listening` |
| 文案池落地(准备 6 句 / 在途 8 句含 3 句古诗) | `src/i18n/{zh,en,types}.ts` | ✅ | `d3b0d87` | 删 3 个 `orb.run.wait.*`;新增 14 个 key,中英同步 |

**发版:** 随 1.1.1(2026-10-16,`7d37ff8`)。实现提交 `d3b0d87` 已在 `1.1.1` tag 内,`git merge-base --is-ancestor d3b0d87 1.1.1` 通过。

**验证数据(归档时复测,develop @ `3b1ba75`):**

| 项 | 结果 |
|---|---|
| 定向测试 | `tests/ui/chat/run-status-line.test.ts` + `tests/ui/orbs/map-orb-state.test.ts` + `tests/core/agent-loop.test.ts` — 3 文件 75 tests 全通过 |
| 全量测试 | 274 文件 2066 tests 全通过 |
| lint | 0 errors / 15 warnings(存量,均为 `obsidianmd/hardcoded-config-path` 等,不在本次改动文件内) |
| typecheck | 241 errors,与父提交 `6e607d6` 基线一致 —— 本次改动零新增类型错误 |

**Plan 偏差 / 遗留:**

- **无独立 plan**:本次按中档直做执行,只产出 spec + 单个实现提交,未拆 plan 文件;归档目录因此只含 spec 与本执行日志。
- **架构文档未新增页面**:spec 影响面一节判定 `AgentEvent` 判别联合追加成员、无既有字段变更,协议说明以本 spec 正文为准,未补 `docs/architecture/` 页面。若后续 `message.request` 语义变更,需回到架构层对齐。
- **`LLMClient` 类型缺口为存量**:定向测试中 `tests/core/agent-loop.test.ts` 的 `embed` / `supportsImages` 类型报错属 241 项存量基线,本次未新增、未修复。
- **分支与 worktree 已清理**:`feat/run-status-phases` 已完全并入 develop,归档前删除 worktree `.worktrees/feat-run-status-phases` 与同名分支。
