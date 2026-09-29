# S-LOOP-STABILITY 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一轮对话在步数将尽、空步、工具挂住时都有一句明白的话，并且循环还能继续或干净结束。

**Architecture:** 判断放在 `src/core/loop-stability.ts` 纯函数里。`agentLoop` 只负责在出站消息末尾追加不落盘的 system，到顶时只写一句助手正文，以及给 `tools.execute` 套 60 秒截止。

**Tech Stack:** TypeScript、Vitest、现有 `tNow`。

**基线:** 从 `develop` 开分支。不要叠在 `feat-model-catalog` 上。

**Spec:** [2026-09-26-loop-stability-design.md](../specs/2026-09-26-loop-stability-design.md)

## Global Constraints

- 默认最大步数仍是 50，到顶后不加步。
- 不改接口重试，不改停止钮语义。
- 不处理短正文续写（S-TURN-CARRY）。
- `run_host_command` 仍是自己的 30 秒，循环兜底 60 秒。
- 收束句和空步说明只追加在出站副本上，不写入会话。
- 到顶只留一句助手正文，不再同时 `yield error`。
- 用户可见句子走 i18n。

---

### Task 1: 纯判断

**Files:**
- Create: `src/core/loop-stability.ts`
- Test: `tests/core/loop-stability.test.ts`

**Interfaces:**
- Produces:
  - `WRAP_UP_REMAINING_STEPS = 5`
  - `TOOL_DEADLINE_MS = 60_000`
  - `shouldAppendWrapUp(step, maxSteps): boolean` — `step >= maxSteps - 5` 且 `step < maxSteps`
  - `isEmptyModelStep(text, reasoning, toolCallCount): boolean`
  - `shouldContinueEmptyStep({ step, sawTool, alreadyContinued, text, reasoning, toolCallCount }): boolean`

- [ ] **Step 1: Write the failing test**

覆盖：maxSteps=50 时 step 44 不收束、step 45 收束；空正文不算空步；第一步空不续；第二步空续一次；已续过不再续。

- [ ] **Step 2: Run** `npx vitest run tests/core/loop-stability.test.ts` — 预期 FAIL。

- [ ] **Step 3: 实现上述函数。**

- [ ] **Step 4: 同一命令 PASS。**

- [ ] **Step 5: Commit** `feat: 步数将尽和空步的判断`

---

### Task 2: 接到循环

**Files:**
- Modify: `src/core/agent-loop.ts`
- Modify: `src/i18n/zh.ts`、`src/i18n/en.ts`、`src/i18n/types.ts`
- Modify: `tests/core/agent-loop.test.ts`

**i18n:**

| key | zh |
|---|---|
| `loop.wrapUp` | 用剩下的步数收束回答，不要再开新的工具链。 |
| `loop.emptyStep` | 上一步没有产出。请根据已有结果把话说完，或说明做不到。 |
| `loop.stepLimit` | 这一轮步数用完了，可以让我接着做。 |

行为：

- `shouldAppendWrapUp` 为真时，`llm.chat` 的消息副本末尾加 `{ role: 'system', content: tNow('loop.wrapUp') }`，不调用 `ctx.add*`。
- 步数走完且没有 break：只 `message.delta` 追加 `loop.stepLimit`，并 `ctx.addAssistantMessage` 同一句。不再 `yield error`。
- 无工具且 `shouldContinueEmptyStep`：不把空助手消息入库，标记已续一次，下一请求追加 `loop.emptyStep`，然后 `continue`。第一步空仍入库并结束。空步不走短正文护栏。
- 旧测试「达到步数上限时应 yield error」改为：delta 里有 `loop.stepLimit`，没有 code 为 `LLM_ERROR` 的事件。

- [ ] **Step 1–4:** 先改断言看红，再接线，再跑 `npx vitest run tests/core/agent-loop.test.ts tests/core/loop-stability.test.ts`。

- [ ] **Step 5: Commit** `feat: 步数将尽先收束，空步只再写一次`

---

### Task 3: 工具 60 秒截止

**Files:**
- Modify: `src/core/loop-stability.ts` 增加 `withToolDeadline`
- Modify: `src/core/agent-loop.ts`
- i18n 增加 `loop.toolTimeout`：这个工具超时了，没有返回结果。
- Test: `tests/core/loop-stability.test.ts`

**`withToolDeadline(work, ms, signal, timeoutMessage)`：**

- `signal` 已中止或等待中中止：抛 `code: 'CANCELLED'`，清定时器。
- 定时器先到：抛 `code: 'TOOL_TIMEOUT'`，message 为 `timeoutMessage`。
- 工作先完成：清定时器并返回。超时后原 Promise 若再拒绝，吞掉，避免未处理拒绝。

循环传入 `TOOL_DEADLINE_MS` 和 `tNow('loop.toolTimeout')`。`TOOL_TIMEOUT` 走现有工具失败：`yield error` code `TOOL_ERROR`、`post-tool-failure`、结果写入工具消息、循环继续。`CANCELLED` 结束整轮。不改 `host-access.ts`。

单测用 20ms 截止和立即 abort，不依赖整轮假时钟。

- [ ] **Step 5: Commit** `feat: 工具挂住超过 60 秒就告诉模型并继续`

## 自审

| Spec | 任务 |
|---|---|
| LS-01 | Task 1、Task 2 |
| LS-02 | Task 2 |
| LS-03 | Task 1、Task 2 |
| LS-04 | Task 3 |
| LS-05 | Task 3 |
| 不改 30 秒本机命令、不改短正文护栏 | 无对应改动 |
