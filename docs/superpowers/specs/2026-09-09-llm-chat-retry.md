# S-LLM-RETRY — 对话模型网络重试

> 日期: 2026-09-09
> 状态: Active
> Spec ID: **S-LLM-RETRY**
> 关联: [ADR-014](../../adr/2026-08-03-mcp-host-platform.md)(MCP 出站与模型 API 不是同一条线)、[S-COMPACT-V2](../archive/S-COMPACT-V2/2026-08-13-compact-v2-design.md)(上下文溢出压完重试,正交)

---

## 1. 背景

主对话、意图分类、查询改写、压缩摘要、会话标题、诊断页模型测试,全部走同一个 `plugin.llm`(`LLMClient.chat` → 现网 `OpenAICompatLLM`)。Skill 只把说明写进上下文,不会另开模型通道;Skill 脚本沙箱禁止联网。

现网 `chat()` **没有**对超时 / 断连 / 429 / 5xx 做退避重试。偶发网络抖动会直接废掉本轮,用户只能再发一条。上下文过长的 compact 重试已经有了,那是另一类失败,不能拿来当网络重试。

Skill 若写「去 curl / 请求某 URL」,Ratel **没有内置 HTTP 工具**。模型只能调用户配置的 MCP;真正打到目标站的是 MCP(`requestUrl` 或 stdio),不是 `llm.chat`。那一跳失败不会被本 spec 修好。

## 2. 目标

1. 所有 `LLMClient.chat` 调用共享一套可测的重试策略:可恢复的网络/网关错误自动再试,用户无感(停止钮仍立即生效)。
2. 已开始往 UI 吐 token 的流 **禁止**重试,避免气泡里出现重复半句。
3. 与 compact 溢出重试、`requestUrl` 流式失败降级并存且职责不混。

## 3. 非目标

- **MCP 工具出站**(含 Skill 教模型去 curl 的那一跳)、Embedding API、精排、ORT/模型下载
- 新增设置项(次数、间隔不进设置页;改策略改代码常量)
- 重试按钮 / 独立「重试中」气泡(v1 保持 `isRunning`,失败仍走现有错误块)
- 在适配器里为 401/403/400/视觉不支持/prompt too long 做重试
- 重试已执行过的工具(只重试**这一次** `chat()` HTTP,agent-loop 的工具结果已在 transcript 里)

后续若要给 MCP curl 做重试,另开 spec,挂 MCP client / tool bridge,不塞进本文件。

## 4. 详细设计

### 4.1 落点

在 `LLMClient` 外包一层装饰器(建议 `src/core/llm-chat-retry.ts` 的纯函数策略 + `src/adapters/llm-chat-retry.ts` 或 `core` 里 `wrapLlmChatRetry(inner: LLMClient): LLMClient`)。

- `rebuildLLM()` 构造 `OpenAICompatLLM` 后包一层;诊断页、`ask`、compact、标题、分类器全部自动吃到。
- 适配器继续只负责流式 HTTP / `requestUrl` 降级,不把退避写进 `llm-openai-compat.ts`(单测不必打真 socket)。

### 4.2 何时重试

一次 `chat()` 视为一次「尝试」。仅当 **尚未 `yield` 过任何 ChatDelta**(含空 text 的 toolCall 也不算已开始;以「对调用方产生过至少一个 yield」为界)且错误可恢复时,才进入下一次尝试。

**可恢复(重试):**

| 类别 | 判定 |
|---|---|
| HTTP | 状态码 `429` / `502` / `503` / `504`(从抛错文案 `error.api.llmFailed` 的 status、或适配器将来结构化的 `status` 读取) |
| 网络 | `AbortError` **除外**;`ECONNRESET` / `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` / `EAI_AGAIN` / `socket hang up` / `fetch failed` / 无状态码的连接失败 |
| 429 头 | 若能读到 `Retry-After`(秒或 HTTP-date),等待 `min(解析值, 30s)`;读不到则走指数退避 |

**不可恢复(立即失败):**

- `signal.aborted` / 用户停止(文案含「请求已取消」)
- HTTP `401` `403` `400` 及其他 4xx(除 429)
- 视觉不支持、上下文过长(`prompt too long` / `CONTEXT_OVERFLOW`)— 后者仍只走 compact 管线
- 已经 yield 过 delta 之后的中途断流(把已有文本留给 UI,按现网 LLM_ERROR 收尾,不重开一枪)

### 4.3 次数与退避

- 最多 **3 次尝试**(首次 + 最多 2 次重试)
- 默认间隔:500ms → 1500ms(第 2、第 3 次尝试前);可被 429 的 Retry-After 覆盖
- 等待期间若 `signal` abort,立刻停,不再发下一次请求
- 三次仍失败:把**最后一次**错误原样抛给 agent-loop / compact / 标题,UI 行为与今天失败相同

### 4.4 与现有两条旁路的关系

**流式失败 → `chatViaRequestUrl`:** 仍是适配器内部的「换传输」,不算本 spec 的一次重试次数。装饰器看到的是整个 `inner.chat()`。若 inner 在流式失败后已经成功用 requestUrl 吐完 delta,装饰器不应再包一层重试。若 inner 在**第一次 yield 前**就抛可恢复错,装饰器重试整个 `inner.chat()`(内含其自身的 requestUrl 降级)。

**CONTEXT_OVERFLOW compact 再进 agentLoop:** 保持 `shouldRetryAfterOverflow`。网络重试发生在单次 `llm.chat` 内部,compact 发生在整轮 ask;先耗尽网络重试,仍 overflow 再走 compact。不要用网络重试去「再撞一次过长 prompt」。

### 4.5 用户可见

- v1 **不**新增 StatusStrip 文案、不发 Notice。停止钮继续 abort 当前 HTTP。
- 最终失败仍用现有 `formatChatError`;429 已有「请稍等后重试」建议,保持。

### 4.6 测试

纯函数(不连网):

- `isRetryableLlmFailure(err, { yielded: boolean, aborted: boolean })` 矩阵:429/503/ECONNRESET 且未 yield → true;401、已 yield、aborted → false
- 包装器:假 LLM 前两次抛 503、第三次成功 → 调用方只看到成功流;假 LLM 第一次 yield 后抛 → 不再调用第二次
- fake timer:退避间隔;abort 在等待中取消后续尝试

不在本 spec 要求对真实 DeepSeek 打 3 次。

## 5. 影响面

| 区域 | 变化 |
|---|---|
| `rebuildLLM` / 所有 `llm.chat` | 自动带重试 |
| `OpenAICompatLLM` | 尽量不改;若抛错缺少 status,允许给 Error 挂 `status` 以便判定(小改) |
| 设置 / i18n | v1 无新 key(除非给 Error 结构化时已有 `error.api.llmFailed`) |
| MCP / Embedding / Skill 脚本 | 无 |
| 架构文档 / ADR | 不改;本 spec 不新增出站通道 |

## 6. 参考

- 现网入口:`src/adapters/llm-openai-compat.ts` `chat()` / `requestStream` / `chatViaRequestUrl`
- 调用方:`src/core/agent-loop.ts`、`intent-classifier.ts`、`query-rewriter.ts`、`ui/chat/compact-session.ts`、`ui/chat/session/session-title.ts`、`ui/diagnostics/llm-test.ts`
- 溢出重试:`src/core/compact-overflow-retry.ts`
- MCP 工具桥:`src/core/mcp-tool-bridge.ts`(明确不在范围内)
