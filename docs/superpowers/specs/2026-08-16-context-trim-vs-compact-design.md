# S-CTX-TRIM — 上送截断对齐模型窗口（先裁工具，再压摘要）

> **ID:** S-CTX-TRIM  
> **状态:** Active  
> **日期:** 2026-08-16  
> **前置:** [S-COMPACT-V2](../archive/S-COMPACT-V2/2026-08-13-compact-v2-design.md)（投影压缩，侧栏不删）、[S-CONTEXT-WINDOW](../archive/S-CONTEXT-WINDOW/2026-06-28-model-context-window-registry-design.md)（128k/256k/1M 预设）  
> **动机:** 用户窗口已是 128k–1M（默认 256k），Layer 1 仍按 32K 时代写死 **8000 token** 从最旧砍历史。占用显示 1% 时一轮 `glob` 就能把**当前用户问题**挤出请求包，模型回「你还没提问」。这是**截断尺子错了**，不是压缩没触发。

---

## 1. 背景

### 1.1 现网两把尺子

| 机制 | 尺子 | 触发 | 改不改侧栏 |
|---|---|---|---|
| 底栏占用 / 自动压缩 | `chatModelMaxTokens`（默认 256k，预设含 1M） | 约 **85% 窗口** | 不删正文，只加 `compactMarkers` |
| Layer 1 `trimHistory` | 构造参数写死 **8000** | 历史池一满就从最旧 `shift` | 不删正文，只影响 `toMessages()` |

8000 / 256k ≈ 3%；8000 / 1M < 1%。所以会出现：**底栏很空，请求里已经没有用户问题。**

同一轮 agent-loop 里更明显：先 `addUserMessage`，模型调 `glob`，工具全文进 transcript，下一跳 `toMessages()` 超 8000，从最旧砍——问题在前、glob 在后，**先砍问题**。注释写「至少留最后一条 user」，实现按「最后一条消息」来，末尾若是 tool / `Error: 429`，问题照样没了。

### 1.2 压缩不是这次的锅

[S-COMPACT-V2](../archive/S-COMPACT-V2/2026-08-13-compact-v2-design.md) 的 85% 自动压、microcompact、投影、侧栏不删，方向仍对。1% 占用时压缩**根本不会跑**。本次修的是 Layer 1 和「单条工具结果」这两刀。

---

## 2. 调研：别人截断什么、不截断什么

调研对象：DeepSeek Harness（2026-08 开源）、Claude Code、OpenAI Codex、Cursor。文档里「compaction」篇幅最大，因为那是**接近满窗**时的主路径。问「窗口截断」时要分开看：**工具正文截断** vs **丢掉对话轮次**。

### 2.1 共识

人人都限长；**没有人**用「与窗口脱钩的 8k 历史池 + FIFO 可以丢掉当前 user」。

| | 工具结果 | 对话轮次（user/assistant） | 摘要压缩 |
|---|---|---|---|
| 会不会动 | **会，而且最先动** | 尽量不动；真顶窗才丢最旧轮 | 约 **83–90% 窗口** 才上 |
| 当前这句 user | — | **必留**；Codex 压完还会把 pending user 重放 | 摘要覆盖旧轮，不覆盖本轮任务 |

### 2.2 DeepSeek Harness

- Session 只追加日志；模型只看 **surface**（投影）。和我们「侧栏全文 / 上送投影」同类。
- 压缩是可选插件，不在 agent-loop 脊柱上。触发：`pressure`（发请求前）或 `context-overflow`（API 报超长后再救）。
- **先** `toolResultPruner`：按 Unicode 码点对工具结果做头/中/尾裁剪；剪完可能不必再摘要。
- 文档写明：单条过大、剪不掉的工具结果，**靠切历史修不好**。
- 摘要替换一段 surface 时必须 **tool_call / tool_result 成对**，留 retained tail。
- 为 KV cache，能不改前缀就不改；社区 1M 实现甚至给自动压缩加了很高的 token 地板——窗还空时**故意不压**。

没有「固定 8000 从最旧 shift」层。

### 2.3 Claude Code

- 自动压缩约 **窗口的 83.5%**（先留约 16% 给输出缓冲）。
- **Microcompact**（不调模型）：过长或过旧的工具结果换成占位。
- **Snip**：接近满窗时丢掉低优先级中间消息，是应急，不是 8k 常驻 FIFO。
- 文件读取自带 offset/limit；社区整理还有单条工具字符上限量级（数万字符）。
- 1M 窗口下很多会话根本压不到。

### 2.4 Codex

- 自动压缩 **≤ 窗口 90%**（硬顶，防 API 溢）。
- `tool_output_token_limit`（常见默认约 **16k token/条**）限制单条工具进上下文的量。
- 工具链中间也能压，但 **pending 用户请求保留再塞回**。
- 压的时候单条仍太大就**改写截短**，不是把 user 整句删掉。

### 2.5 Cursor

- 明确反对「长 shell/MCP 结果直接截断丢数据」作为唯一手段：大输出**写成文件**，模型用 `tail` / `grep` 再取。
- 窗口满了再摘要；全文历史另存，摘要丢细节时还能搜回来。
- 第一方工具自己控制体积；第三方才走落盘。

### 2.6 对 Ratel 的结论

| 该对齐 | 不该对齐 |
|---|---|
| 尺子 = `chatModelMaxTokens` | 历史池写死 8000 |
| 先裁/折叠**工具正文** | 先砍当前 user |
| 压缩仍约 85% 窗口 | 1% 占用就 FIFO 对话 |
| 应急裁轮次时 user 必留、tool 对成对 | Cursor 落盘再读（v1 不做，见非目标） |

---

## 3. 目标

1. **一把尺子：** Layer 1 历史上限由 `getEffectiveChatModelMaxTokens()` 推导，随 128k / 256k / 1M / custom 变。  
2. **先裁工具：** 每条 `role=tool` 进上送包前有硬上限；超了留头尾、中间标省略（不调模型）。  
3. **当前 user 必留：** Layer 1 不得删掉最后一条 `role=user`；超预算时先截工具正文、再丢该 user **之前**的更旧轮。不得拆 tool_call / tool 配对。  
4. **压缩位次不变：** S-COMPACT-V2 的 85% 自动压、microcompact、PTL 重试保留；本 spec 不把压缩阈值改成 60% 历史池。  
5. **侧栏仍全文：** 与 compact-v2 相同，截断只改 `toMessages()`。

成功标准：

- 默认 256k 下，仅一轮用户问题 + 一条超大 `glob` 结果：发给模型的包里**仍有该 user 原文**；工具结果被截到上限以内。  
- 底栏占用按窗口计，在工具截断后仍远低于 85% 时，**不**因 8000 丢掉 user。  
- `trimHistory` 单测：用户 + 超长 tool、预算小于 tool 全文时，`toMessages` 含该 user。  
- 切换 Context Length 预设后，历史上限跟着变（有单测或明显常量函数）。  
- `npm test` / `npm run build` 通过。

---

## 4. 非目标

- 不改 85% 自动压缩阈值、不改摘要 prompt、不改 `compactMarkers` 语义。  
- 不做 Cursor 式「工具全文落盘 + 模型自己 grep」（可后续 spec）。  
- 不做 DeepSeek 式 KV-cache 前缀保护 / compaction 插件化。  
- 不把 Session Memory 当摘要替代。  
- 不在生成中途插入全量 LLM 摘要（compact-v2 已禁止）。  
- 不改用户消息 Markdown、不改 Agent 工具集合。

---

## 5. 详细设计

上送顺序（`toMessages` 内）：

1. 现有 `projectView`（compact head + tail + microcompact）。旧工具多半已是短占位。  
2. **单条工具上限**（新）：只处理将上送的副本里仍超限的 `role=tool`（主要是 keep-recent 全文）。  
3. **Layer 1**（改）：只裁 `tail`（与现网一致），保护最后一条 user。  
4. 与现网相同：前面拼 Composer 系统段 + 记忆 + skill discovery + `searchResultsMessages` + compact `head`。

同轮 agent-loop 每次 `toMessages()` 都走 1–4，所以 `glob` 归来后的下一跳会先截工具再谈 FIFO。

审查修订：不可先裁再 `projectView`——microcompact 会把旧工具换成更短占位，上限应打在投影之后、真正进包的正文上。

### 5.1 历史上限（替换 8000）

现网 `trimHistory` **只接收 `projectView` 的 tail**，系统段 / 记忆 / 检索块 / compact head **另拼在前面、不经 Layer 1**。预算若写成 `窗口 − 10%`，tail 就能占满 ~230k，再加检索块会超过 256k。必须给「不经 Layer 1 的前缀」留空。

```ts
/** 输出余量：大窗 10% 夹在 8k–32k；窗 < 32k 时改为 15%，避免 custom 4k 上 reserve(8k) > 窗口 */
function outputReserve(window: number): number {
  if (window < 32_000) return Math.max(512, Math.floor(window * 0.15));
  return Math.min(32_000, Math.max(8_192, Math.floor(window * 0.10)));
}

/** 系统段+记忆+discovery+检索块+compact head 预留；小窗按 20% 缩放 */
function prefixSlack(window: number): number {
  if (window < 32_000) return Math.max(512, Math.floor(window * 0.20));
  return 24_000;
}

/** Layer 1 只拿这个数去和 tail 的 estimateTokens 比（256k → ~206k，1M → ~993k） */
function tailBudget(window: number): number {
  return Math.max(1_024, window - outputReserve(window) - prefixSlack(window));
}
```

单位：与现网 `trimHistory` 相同，用 `estimateTokens`（token），**不是**码点。5.2 的工具上限是码点，两套单位并存，实现里不要拿码点去和 `tailBudget` 比。

`ContextManager` 不得再默认 8000。所有 `new ContextManager(...)`（`ask`、`createContext`，含 compact / 占用估算那条路径）传入 `tailBudget(getEffectiveChatModelMaxTokens(settings))`。改 Context Length 后下一轮 `ask` 生效即可。

与 85% 压缩：压缩仍看**整包** / 窗口。Layer 1 是 tail 超过 `tailBudget` 的安全网；默认 256k 下约 20 万 token 才碰，**1% 占用不应触发**。

### 5.2 单条工具上限（新，常驻）

对每条上送 `role=tool` 的 `content`：

- 上限：**32_000 个 Unicode 码点**（量级对齐 Codex ~16k token、DeepSeek 按码点剪；实现用 `[...str]` 或等效，禁止按 UTF-16 拦腰切开代理对）。  
- 超出则保留头 `HEAD` + 省略标记 + 尾 `TAIL`（建议头 24_000、尾 6_000，中间一行 `[truncated N chars]`）。  
- `content.startsWith('Error:')` 的短错误不裁。  
- 只改上送副本，不改 `session.messages`。  
- 与现有 microcompact 关系：microcompact 把**更旧**可重取工具换成 `[compacted] name path=…`；本上限管投影之后仍超长的工具（主要是 keep-recent 全文），避免一条 glob 独吞 tail。  
- **检索注入** `searchResultsMessages` 不进 `trimHistory`。v1：对每条检索块 `content` 使用**同一套 32_000 码点**头尾裁，避免 RAG 块绕过 Layer 1 把窗口撑爆。

v1 不做落盘；模型若需要被裁掉的中间段，应再调 `grep` / `read_note` / 缩小 glob。

### 5.3 Layer 1 保护当前 user

`trimHistory(messages)`：

1. 未超 `historyBudget` 或长度 ≤ 1：原样返回。  
2. 找到**最后一条** `role=user` 下标 `u`。  
3. 先丢掉 `u` 之前的更旧消息（从最旧开始），直到不超预算或只剩 `u..end`。  
4. 若 `u..end` 仍超：只缩短该窗口内的 **tool.content**（先 5.2；仍超则再压成 `[truncated]` 占位）。**不得删除** user，也不得拆开 assistant tool_call 与对应 tool 的配对（可把 tool 正文抽空，消息节点留下）。  
5. 不得只留下一条 assistant / tool 而用户问题为 0。

「用户只发了「继续」」：最后一条 user 是「继续」，更早的任务句可能在步骤 3 被丢掉——这是窗口真满时的应急，与 Codex「保住 pending user」一致。产品上仍建议用户在续跑时带一句任务；本 spec 不把「所有历史 user 永远保留」当作目标。

### 5.4 429 / 工具撑爆后的续跑

本 spec 不单独做「换 key 自动重放」。更新插件后：会话 JSON 仍在；下一轮 `toMessages` 会带上最后一条 user + 被截短的工具。若最后一条 user 已是「继续」，应在 user-guide 写清：续跑请带任务原句。

### 5.5 测试

- 预算函数：256k / 1M 的 `historyBudget` 远大于 8000。  
- 用户 + 超长 tool + 小预算：含 user，tool 被截。  
- 多轮 user 超预算：保留最后一条 user。  
- `session.messages` 正文与条数不变。  
- 现有 compact 投影、85% 决策、microcompact 单测不回退。

---

## 6. 影响面

- **改：** `src/core/context-manager.ts`（构造预算、`trimHistory`、上送前裁 tool / 检索块）；`src/main.ts` 所有 `new ContextManager`；可能抽出 `src/core/tool-result-prune.ts` 与 `src/core/context-budget.ts`。  
- **测：** `tests/core/context-manager.test.ts`、预算函数（含 custom 4k / 256k / 1M）、prune 单测。  
- **文档：** user-guide 补一句「工具/检索过长会截断进模型的正文，侧栏仍全文；续跑请带任务原句」。CHANGELOG 发版时写用户语言。  
- **不改：** ports、Worker、压缩阈值、侧栏 hydrate。

---

## 7. 参考

- 现网事故：256k/1M 窗口 + 8000 FIFO + 同轮 glob → 模型称未提问。  
- [S-COMPACT-V2](../archive/S-COMPACT-V2/2026-08-13-compact-v2-design.md)  
- [S-CONTEXT-WINDOW](../archive/S-CONTEXT-WINDOW/2026-06-28-model-context-window-registry-design.md)  
- DeepSeek Harness compaction / `toolResultPruner`：<https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/compaction>  
- Claude Code context window：<https://code.claude.com/docs/en/context-window>  
- Codex auto-compact ≤ 90% 窗口 + `tool_output_token_limit`  
- Cursor Dynamic Context Discovery（大工具落盘，v1 不抄）
