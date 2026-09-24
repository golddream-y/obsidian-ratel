# S-LLM-RETRY-UI — 对话网络重试的打字行提示

> 日期: 2026-09-11
> 状态: Active
> Spec ID: **S-LLM-RETRY-UI**
> 关联: [S-LLM-RETRY](2026-09-09-llm-chat-retry.md)（策略已落地）、[thinking-orbs](https://libraries.dev/orbs)（`connecting` 态）

---

## 1. 背景

S-LLM-RETRY 已在 `wrapLlmChatRetry` 里对首次 yield 前的 429 / 5xx / 断连做最多 3 次尝试。用户可见仍是静默：底部 `.ratel-typing` 继续写「撰写中…」，抖动那几秒和正常思考无法区分。对话进行中 StatusStrip 会故意清掉忙态文案，把「还在跑」交给这一行。

已拍板：提示挂在这行，球换成上游 `connecting`（星座连线），成功则当没发生过。不进 StatusStrip，不加失败后的「重试」按钮。

## 2. 目标

1. 主对话 `ask` 路径上，某次 `llm.chat` 进入退避或尚未吐出首个 delta 的重试请求时，`.ratel-typing` 换成 `connecting` 球 + 重试文案。
2. 该次 `chat()` 一旦 yield、最终失败、或用户停止：立刻回到原忙态（思考 / 工具 / 检索），或随 `isRunning` 结束而撤行。
3. 标题、压缩、分类器、诊断页、改写仍走同一套重试策略，**不**驱动这条打字行。
4. 停止钮在退避等待中仍然立刻生效（现网 `sleepMs` 已看 `signal`）。

## 3. 非目标

- StatusStrip / Drawer / Notice / 独立气泡 / 错误块上的「再试一次」按钮
- 20 秒无首字节的 stall 横幅
- 已 yield 后中途断流的自动重开（S-LLM-RETRY 已禁止）
- 改次数、间隔、可恢复判定；不进设置页
- 新增 thinking-orbs 动画或 npm 包（九态已移植）
- 改 `AgentEvent` 判别联合、消息持久化、架构文档

## 4. 详细设计

### 4.1 谁看见

只有 ChatView 主循环。`wrapLlmChatRetry` 读 `ChatRequest` 上的可选回调；标题 / compact / 分类器不传回调，包装器无 UI 副作用。

```
ChatView $state
  → plugin.ask(..., { onRetryWait })  // 挂在现有 ask opts，不另开参数
  → agentLoop 每次 llm.chat({ ..., onRetryWait })
  → wrapLlmChatRetry 在退避 / 再发前调用
  → MessageList 读 retryWait，覆盖 busyKind 与文案
```

`ChatRequest.onRetryWait` 可选，适配器忽略。不新增 `LLMClient` 方法，不新增 `AgentEvent` 成员。

### 4.2 回调形状

```ts
type LlmRetryWait =
  | { phase: 'backoff'; attempt: number; maxAttempts: number; delayMs: number }
  | { phase: 'request'; attempt: number; maxAttempts: number };

onRetryWait?: (state: LlmRetryWait | null) => void;
```

- `attempt`：即将进行或正在进行的尝试序号，1-based。首次失败后是 `2`，再失败后是 `3`。`maxAttempts` 固定 `3`。
- `backoff`：进入 `sleepMs` 之前调用一次，带本次等待的 `delayMs`（含 Retry-After 封顶 30s）。
- `request`：睡醒、即将再次 `inner.chat()` 时调用一次。
- `null`：本次 `chat()` 第一次 yield、成功结束、把错误抛给上层、或 abort 取消等待。必须在这些出口都清掉，避免打字行卡在「重试中」。

Agent 多步时，每一步是一次独立 `chat()`。工具跑完后下一枪若再抖，可以再次出现提示。工具执行期间本回调为 `null`，打字行仍是 working / searching。

### 4.3 打字行

`MessageList` 在 `showBusyOrb` 为真且 `retryWait != null` 时：

| | 平时 | 重试中 |
|---|---|---|
| 球 | `thinking` → composing；工具 → working / searching | **`connecting`**（`mapOrbState` 增加 `retry`） |
| 文案 | `orb.state.*` | 下面三条 i18n，不复用「连接中…」 |

文案（zh / en 都要）：

| 条件 | 中文 |
|---|---|
| `backoff` 且剩余 &lt; 1s | 即将重试（{attempt}/{max}） |
| `backoff` 且剩余 ≥ 1s | 网络不稳，{seconds} 秒后重试（{attempt}/{max}） |
| `request` | 网络不稳，正在重试（{attempt}/{max}） |

`seconds` = `floor(剩余毫秒 / 1000)`。ChatView 在 `backoff` 期间用收到回调的时刻 + `delayMs` 本地倒计时（约 250ms 一跳即可）；剩余落到 0 先切「正在重试」，即使 `request` 回调晚一帧。

成功 yield：`onRetryWait(null)`，球和文案回到 composing / 工具态，不闪错误、不留痕迹。

最终失败：现网错误块不变；`isRunning` 变 false，打字行整行消失。

### 4.4 不放哪

- **StatusStrip**：`isRunning` 时 `workBar` 仍返回 `null`。索引 / 目标条优先级不变。
- **空助手气泡内部**：不再插第二条状态。
- **吉祥物**：不为此单独加脸。

`connecting` 已用于索引条的 orb。对话中 Strip 让路给打字行，两条不会叠在同一行。

### 4.5 测试

- 包装器：`onRetryWait` 序列为 `backoff(2)` → `request(2)` → `null`（第二次成功 yield）；abort 在 sleep 中也要收到 `null`。
- 文案纯函数：500ms →「即将重试」；1500ms 刚开始 →「1 秒后」；`request` →「正在重试」。
- `mapOrbState('retry') === 'connecting'`。
- 不要求打真网；不要求 Svelte 组件测倒计时动画。

## 5. 影响面

| 区域 | 变化 |
|---|---|
| `ports/llm.ts` `ChatRequest` | 可选 `onRetryWait` |
| `core/llm-chat-retry.ts` | 退避前后回调；现有重试判定不改 |
| `core/agent-loop.ts` / `main.ts` `ask` | 把回调从 ChatView 传到 `llm.chat` |
| `MessageList.svelte` / `map-orb-state.ts` | `retry` → connecting + 覆盖文案 |
| `ChatView.svelte` | `$state` + 倒计时 + 传给 MessageList |
| i18n zh/en/types | 三条 `chat.retry.*` |
| 设置 / AgentEvent / 持久化 / 架构文档 | 无 |
| MCP / Embedding | 无 |

## 6. 参考

- 现网包装器：`src/core/llm-chat-retry.ts`
- 打字行：`src/ui/chat/message-stream/MessageList.svelte` `.ratel-typing`
- Strip 对话中让路：`ChatView.svelte` `workBar` 在 `isRunning` 返回 `null`
- 上游 playground：[libraries.dev/orbs](https://libraries.dev/orbs) 的 Connecting（旧站 orbs.jakubantalik.com 已搬家）
