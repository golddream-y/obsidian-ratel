# S-COMPACT-V3 — 上下文压缩重设计：先量准、分级移出、增量任务状态

> **ID:** S-COMPACT-V3
> **状态:** Active
> **日期:** 2026-10-01
> **取代:** [S-COMPACT-V2](../archive/S-COMPACT-V2/2026-08-13-compact-v2-design.md) 的触发规则与摘要格式（投影、不改聊天记录、断路器、撑爆重试保留）
> **关联:** [S-CTX-TRIM](../archive/S-CTX-TRIM/2026-08-16-context-trim-vs-compact-design.md)、[S-READ-PRESERVE](../archive/S-READ-PRESERVE/2026-09-05-preserve-read-note-microcompact.md)、[上下文压缩架构](../../architecture/agent/context-compaction.md)

---

## 1. 背景

### 1.1 现象

一场写长篇小说的会话（约 1100 条消息、9 章正文），窗口设为 1M（1,048,576），连续两次「继续」，每一轮结束都触发自动压缩。用户的感受是「几次就压」，而且压完之后模型只记得一段摘要。

### 1.2 实测拆分

对该会话按上送字段拆分（字符数）：

| 部分 | 字符 | 是否计入占用估算 | 是否被压缩/折叠 |
|---|---|---|---|
| 消息正文 `content` | 约 56 万 | 是 | 发现类工具结果会折 |
| 思考过程 `reasoning` | 约 23 万 | 否 | 否，每次请求全部回传 |
| 工具参数 `toolArgs`（主要是 `write_note` 的整章正文） | 约 74 万 | 否 | 否，每次请求全部回传 |

合计约 150 万字符。按项目估算器（中文约 1.5 字/token）重算约 78 万 token，约为 1M 的 74%；再加系统段与工具定义，接近 85% 线（约 89 万）。两项数据缺失：当时接口返回的 `prompt_tokens` 没有记录；压缩发生时窗口是否已是 1M 无法从日志确认。

### 1.3 根因

1. **量的和发的不一致。** `estimateTokens` 只数 `content`；适配器还会发 `tool_calls.arguments` 与 `reasoning_content`。估算偏低，`trimHistory` 的 Layer 1 预算（1M 时 992,576）按估算判断，永远不触发；只有轮后拿到 API 真值才发现已超。
2. **最大的两块从不移出。** 写笔记的整章参数、历史轮次的思考过程，都没有任何折叠层，在第一次压缩之前一直随每次请求增长，既不计数也不折叠。单轮内也会堆满：该会话 103 个用户轮次中有 41 轮写入不止一次，最多一轮 32 次、约 9.4 万字符参数。
3. **压完立刻又满。** 触发只看「≥85%」，不看压完能降到多少；压完若仍高，下一轮结束再压，形成每轮一压。
4. **压缩请求本身可能超窗。** 摘要输入是把整段投影拼成一条消息一次发出；历史越长越容易失败。失败只计断路器，breadcrumb 不记结果。实测两次压缩只留下一个 marker，原因无法从日志确认。
5. **压完不留近期原文。** `afterIndex = transcript.length - 1`，tail 为空。模型只看到摘要和 5 个路径，正在写的章节、刚做的修改、用户最新纠正都只剩摘要里的一句话。
6. **摘要是摘要的摘要。** 第二次压缩把上一条摘要文本连同新历史再总结一次，没有结构化状态可增量更新，多次压缩后细节逐步丢失。
7. **恢复只有路径。** `restoredNotePaths` 让模型再 `read_note`，但不知道哪些已在上下文中、文件是否改过。

### 1.4 外部做法（只取可借鉴的结构，不引入依赖）

| 来源 | 借鉴点 |
|---|---|
| Anthropic（Claude Code 工程文章、Context editing） | 先清旧工具结果再摘要；压缩后补回最近访问的文件 |
| Google ADK compaction | 旧历史摘要 + 近期原文；按 token 或轮次触发 |
| Microsoft Agent Framework compaction pipeline | 分级：缩工具结果 → 摘要旧轮 → 滑窗 → 紧急截断；工具调用与结果成组不拆 |
| AWS Strands conversation manager | 调用前主动压缩，留余量；可固定关键消息 |
| AgentScope | 结构化摘要字段（任务、状态、发现、下一步）；压缩后清理不再可见的读取缓存 |
| LangChain Deep Agents | 大工具结果和旧写入参数先移出上下文，空间仍不足再摘要；被移出内容可再取回 |

结论：没有可直接嵌入 Ratel 循环的压缩库。Deep Agents 有 JavaScript 包，但外置和摘要是它自己 Agent 循环里的中间件，被移出的内容写进它的文件系统，再靠它的读文件工具取回。Claude Agent SDK 是整套工具循环。OpenAI 的 compaction 只在 Responses API 里有效，结果是服务端加密块。这三家都不能接到现在的 `chat/completions` 循环上。

对照 [Deep Agents 上下文管理说明](https://www.langchain.com/blog/context-management-for-deepagents) 后的取舍：

| 官方做法 | 本方案 |
|---|---|
| 大工具结果一出现就外置，占位里留前若干行和存放位置 | 笔记正文的存放位置就是库内路径，不另写文件。R4 占位带路径和标题行，不带正文 |
| 超阈值后外置旧的写入参数 | 采用，即 R2。正文已由写工具落库 |
| 没有还能外置的内容时才摘要 | 采用。R2、R4 仍有可移出内容时不做全量摘要 |
| 用读文件工具取回外置内容 | 笔记用 `read_note` 取回。思考过程、检索结果不在库里，仍留在 `session.messages`，用 `read_history` 按位置取回 |
| 压缩后要测能否继续任务，以及能否找回被摘要掉的具体事实 | 写入成功标准 |

不照搬：不把移出内容写成库内笔记（会污染用户的库）；不把「已读过就拒绝再读」交给 SDK（官方说明也说严格的读取去重要自己做，见 4.6）。

---

## 2. 目标

1. **量准**：占用估算与适配器实际序列化的字段一致，并用最近一次 API 真值校准。
2. **先移出、后摘要**：可从库里或会话里取回的大块内容（旧写入参数、旧思考过程、旧检索结果、工作集外的旧笔记全文）在每次组装时移出，不调 LLM。
3. **不再每轮一压**：软阈值触发、压到目标线以下；压完未降到目标线时不在下一轮重复全量摘要（滞回）。
4. **连续性**：压缩后保留近期原文轮次、用户纠正原文、结构化任务状态与工作集；多次压缩增量更新状态而不是重写摘要。
5. **可恢复**：被移出的内容都有可定位的占位（笔记路径或会话消息位置），模型可按需取回。
6. **可诊断**：每次压缩决策与结果写入 breadcrumb（占用、来源、前后 token、覆盖区间、成功/跳过/失败原因）。

### 成功标准

- 1.2 节那场会话：1M 窗口下，连续 10 次「继续」不触发全量摘要（只靠第 4.3 节的移出层），或触发后不在下一轮再次触发。
- 压缩后上送包里：最近 2 个用户轮次原文完整（含工具调用组），用户纠正原文在，工作集笔记有全文或明确的「未在上下文」状态。
- 连续 3 次全量摘要后，结构化状态的 `constraints` / `decisions` / `failedAttempts` 条目不丢（单测用固定 mock 摘要器验证合并逻辑）。
- `session.messages` 条数与正文在任何压缩前后不变。
- 压缩后的下一轮能接着原目标做，不向用户重问目标、不把未完成的任务说成已完成。
- 被 R2 移出的某次写入，压缩后通过 `read_note` 能取回该路径的当前正文。
- `npm test` / `npm run build` 通过。

---

## 3. 非目标

- 不引入 LangChain / Deep Agents / Claude Agent SDK 等运行时。
- 不接 OpenAI Responses 加密 compaction（以后若新增 Responses 适配器再评估）。
- 不另建一份事件日志：`session.messages` 已是完整、只追加的事实源。
- 不对旧历史做向量检索（第 5 阶段的 `read_history` 按位置取回即可）。
- 不改斜杠命令名、不改自动压缩开关语义。
- 不在流式生成中途插入全量摘要（保持 S-COMPACT-V2 约定）。
- 不把移出的工具结果或参数写成库内文件。

---

## 4. 详细设计

### 4.1 三份数据，各管各的

| 数据 | 内容 | 存放 | 更新方式 |
|---|---|---|---|
| 会话原文 | user / assistant / tool / 工具参数 / 思考过程 | `session.messages` | 只追加，压缩不改 |
| 任务状态 | 目标、约束、用户纠正、已完成、决策、失败尝试、未决、下一步、工作集 | `CompactMarker.state`（最近一条为准） | 每次全量摘要增量合并 |
| 本次上送 | 系统段 + 旁路注入 + 状态 + 工作集原文 + 近期原文 | 每次 `toMessages()` 现算 | 按预算组装，不落盘 |

### 4.2 统一计量 `measureOutbound`

新增纯函数，口径与 `buildRequestBody` 一致：

```ts
interface OutboundMeasure {
  content: number;      // 各消息 content
  toolArgs: number;     // assistant tool_calls.arguments(JSON 字符串)
  reasoning: number;    // 实际会回传的 reasoning_content
  attachments: number;  // 图片估算
  toolSchemas: number;  // 本轮工具定义
  total: number;
}

function measureOutbound(messages: ChatMessage[], tools: ToolDefinition[]): OutboundMeasure;
```

- `getContextUsage` / `tokenCount` / `trimHistory` / 自动压缩判断全部改用它。
- **校准**：每轮 `message.end` 拿到最后一步 `promptTokens` 时，记 `ratio = promptTokens / 该步上送的 measure.total`（会话内存，夹在 0.5–2.0）。之后的估算乘以 `ratio`。无真值时 `ratio = 1`。
- 适配器内部的 `countTokens(length / 4)` 不再用于任何判断。

### 4.3 分级移出（每次组装都跑，不调 LLM）

在 `projectView` 之后、`trimHistory` 之前依次执行。全部只作用于本次上送副本。

| 级 | 对象 | 规则 | 占位（面向模型，不走 i18n） |
|---|---|---|---|
| R1 思考过程 | 最后一条 user 之前的 assistant `reasoning` | 不再回传 | 无（字段直接不带） |
| R2 写入参数 | 成功的 `write_note` / `append_note` / `edit_note` 等参数中的正文字段，除本轮最近一次写入外 | 删掉正文字段，只留 path 等短字段。工具结果注明正文在笔记里。不把占位符放进 content，写工具会拒绝以 `[written]` 开头的正文 | 无（不生成可照抄的 content） |
| R3 发现类结果 | `search_vault` / `grep` / `glob` / `list_files` / `search_memory` | 维持现有 microcompact（保留最近 5 条） | `[compacted] …`（不变） |
| R4 工作集外旧笔记 | 最后一条 user 之前、且不在工作集内的 `read_note` 全文 | 仅在 R1–R3 后仍超软阈值时执行 | `[offloaded] read_note path=… chars=… title=… 需要时可再读` |

要点：

- **R1 的供应商约束**：DeepSeek thinking 模式要求同一用户轮内、含 tool_calls 的 assistant 回传 `reasoning_content`；R1 只去掉更早轮次的。实施前对 DeepSeek 与火山方舟各做一次真实请求验证；若某供应商要求全部回传，按供应商关闭 R1。
- **R2 的依据**：写入结果已在库里，需要时 `read_note` 取最新版本；占位不含正文，避免旧版本误导。参数里哪些字段是「正文」由工具定义登记（集中声明，见 AGENTS.md「枚举与 ID 集中管理」），不在调用点硬编码。
- **R4 与 S-READ-PRESERVE 的关系**：S-READ-PRESERVE 不折 `read_note` 是为了防循环再读。R4 只在超预算时折工作集之外的旧全文，并配合 4.6 的可见性账本：模型再读时，工具知道它确实不在上下文里，不再判为重复。
- 工具调用组不拆：占位只换正文，`tool_call` 与 `tool` 配对保持。
- **前缀缓存**：移出边界只前进；R4 的移出水位记在 `Session.offloadedThrough`，占用回落也不恢复；R4 单次可移出量低于 `0.05 × B` 时不执行；同一内容占位文本固定。

### 4.4 触发与目标线

设 `W` = 窗口，预算 `B = W − outputReserve(W)`，`u` = 校准后的上送占用。下表比例均相对 `B`。不另设工作上限：写长文的占用由移出层降下来，用户看到的窗口保持为模型窗口。

| 线 | 默认 | 作用 |
|---|---|---|
| 软阈值 `soft` | `0.70 × B` | 轮后检查：`u ≥ soft` 先执行 R4。R2、R4 仍有可移出内容时不做全量摘要；没有了仍超，才摘要 |
| 硬阈值 `hard` | `0.90 × B` | 发送前检查：`u ≥ hard` 必须先压；压缩失败则截断兜底后照常发出，并记 `compact.result` 失败 |
| 目标线 `target` | `0.40 × B` | 全量摘要选择覆盖区间时，使压后占用 ≤ target |

滞回：全量摘要后记录 `tokensAfter`。若下一轮结束时 `u < tokensAfter + 0.15 × B`，不再做全量摘要（只跑移出层）。避免「压完仍高 → 下一轮再压」。

百分比显示（状态条）仍按 `u / W`，与用户看到的窗口一致；判断用 `B` 是为了给输出留空间，并允许用户收紧。

断路器、撑爆重试（`CONTEXT_OVERFLOW` 压后重试 1 次）、手动 `/compact`、开关语义沿用 S-COMPACT-V2。

### 4.5 全量摘要：近期原文 + 增量状态

**覆盖区间。** 新 marker 记录 `coveredTo`（含）与 `keepFrom`：

- 从末尾往前保留最近 `KEEP_RECENT_USER_TURNS = 2` 个用户轮次（每轮 = 该 user 及其后全部 assistant / tool 直到下一个 user），且保留部分 ≤ `0.25 × B`；超出时只保留最后 1 轮，仍超则保留最后 1 轮并对其应用 R2–R4。
- `coveredTo = keepFrom − 1`，`keepFrom` 必须落在 user 消息上，保证工具组不被切开。
- 上送包 = 状态 head + 工作集 + `messages.slice(keepFrom)`（再过 4.3 移出层）。

**摘要输入。** 上一条 marker 的 `state`（结构化 JSON）+ 区间 `(上一个 coveredTo, coveredTo]` 的原文（已过 R1–R4）。不再把上一条摘要文本当历史重新总结。

**分段。** 区间投影超过 `0.5 × B` 时按用户轮次切块，逐块调用「状态更新」，每块输入 = 当前状态 + 该块原文，输出新状态。避免压缩请求自身超窗。

**状态格式**（`internal.compact` 改为要求输出 JSON，解析失败则视为失败、不写 marker）：

```ts
interface CompactState {
  goal: string;                     // 当前总目标;Goal 模式下引用目标 id
  constraints: StateItem[];
  userCorrections: StateItem[];     // 原话,经程序核对
  completed: Array<{ item: string; evidence: string[] }>; // evidence: 笔记路径或 msg:<index>
  decisions: Array<StateItem & { reason: string }>;
  failedAttempts: Array<{ approach: string; reason: string }>;
  openItems: string[];
  nextStep: string;
  workingSet: Array<{ path: string; role: 'editing' | 'reference' | 'outline' }>;
}

interface StateItem {
  text: string;
  source?: string;                  // msg:<index>
  supersededBy?: string;
}```

合并规则（代码执行，不靠模型自觉）：

- `userCorrections`：模型挑出候选；程序核对候选是某条 user 消息的原文片段，核对不过的丢弃。
- `constraints` / `decisions` / `failedAttempts`：模型漏写的旧条目由程序补回并记日志警告；条目只能通过 `supersededBy` 显式取代，取代后不再渲染给模型。
- `completed.evidence` 中的写入事实由程序从区间内成功的写工具结果生成（路径 + 消息位置），模型只写描述。
- 状态渲染为 head 文本时有上限（默认 `0.08 × B`）；超出时最早的 `completed` 先合并成一句。

### 4.6 工作集与可见性账本

**工作集来源**（去重，按优先级取前 `MAX_WORKING_SET = 6`）：状态里的 `workingSet`；保留区间内写过的笔记；保留区间内读过的笔记；被覆盖区间里最后写过的笔记。

**压后恢复。** 对工作集按优先级读取当前全文注入 head（每篇仍受 32k 码点单条上限），总量 ≤ `0.15 × B`；超出的只列路径与「未在上下文」。读取走 `ObsidianVault` 外观，记录 `mtime`。

**可见性账本**（会话内存，每次 `toMessages()` 重算，不落盘）：

```ts
interface VisibleNote {
  path: string;
  mtime: number;
  source: 'tool-result' | 'restored';  // 上送包里出现全文的位置
}
```

`read_note` 执行时查账本：

| 情况 | 返回 |
|---|---|
| 全文在本次上送包里，且 `mtime` 未变 | 短提示：「该笔记全文已在上下文中（未修改）」，并附标题行；参数 `force: true` 时仍返回全文 |
| 不在上送包里（被 R4 移出或被摘要覆盖） | 全文 |
| `mtime` 已变 | 最新全文，并提示「已更新」 |

这让 R4 可以安全折旧全文：模型再读时得到正文，而不是被「已读过」挡住。

### 4.7 取回原文 `read_history`（第 5 阶段）

只读工具，参数 `{ from: number; to: number }`（消息位置，来自 `evidence` 中的 `msg:<index>`），返回该区间原文（过 R1–R2，单次上限 32k 码点）。用于状态里只有结论、需要核对原话的场景。权限等级同 `read_note`。

### 4.8 数据模型

```ts
interface CompactMarker {
  afterIndex: number;          // V2 字段,V3 写入时等于 coveredTo
  keepFrom?: number;           // V3:上送原文起点;缺省 = afterIndex + 1(V2 语义)
  summary: string;             // V3 为 state 的渲染文本,供 UI 与旧代码读取
  state?: CompactState;        // V3
  restoredNotePaths: string[]; // V2;V3 写 workingSet 的路径
  tokensBefore?: number;       // V3:校准后占用
  tokensAfter?: number;        // V3
  version?: 2 | 3;
  at: number;
}

interface Session {
  // ...
  offloadedThrough?: number;   // V3:R4 移出水位,只前进
}
```

- 旧会话：无 `state` 的 marker 按 V2 投影；下一次 V3 摘要把旧 `summary` 作为唯一历史输入生成首个 `state`。
- UI 分隔条位置用 `afterIndex`，不变。

### 4.9 诊断

| breadcrumb phase | detail |
|---|---|
| `compact.decide` | `pct=..;used=..;input=..;source=api|estimate;ratio=..;action=none|offload|summary` |
| `compact.result` | `ok|skip|fail;before=..;after=..;covered=a-b;keepFrom=..;chunks=..;reason=..` |

开发者日志记录 4.2 的分项（content / toolArgs / reasoning / attachments / toolSchemas），中文。

---

## 5. 分阶段

| 阶段 | 内容 | 解决 | 状态 |
|---|---|---|---|
| P1 量准 + 可诊断 | 4.2、4.9；R1、R2 | 「几次就压」的主要来源（参数与思考过程） | 未开始 |
| P2 触发 | 4.4 预算、软/硬/目标线、滞回、硬阈值失败兜底 | 每轮一压 | 未开始 |
| P3 连续性 | 4.5 近期原文、增量状态、分段摘要；4.8 | 压完只剩摘要、摘要的摘要 | 未开始 |
| P4 工作集 | 4.6 恢复与可见性账本；R4 与移出水位 | 压后重读与循环查看 | 未开始 |
| P5 取回 | 4.7 `read_history` | 证据核对 | 未开始 |

每阶段单独成 plan，按 TDD 实施；P1 完成后用 1.2 节同规模的合成会话复测，再决定 P2 的默认比例。

---

## 6. 影响面

| 区域 | 变化 |
|---|---|
| `src/core/compact-project.ts` | 移出层 R1–R4、覆盖区间选择、状态合并（纯函数） |
| 新模块 `src/core/outbound-measure.ts` | `measureOutbound`、校准 |
| 新模块 `src/core/visible-notes.ts` | 可见性账本 |
| `src/core/context-manager.ts` | `toMessages` 接入移出层与工作集 head；`getContextUsage` 改口径 |
| `src/core/context-budget.ts` | 软/硬/目标线 |
| `src/ui/chat/compact-session.ts` | 区间、分段、JSON 状态、`compact.result` |
| `src/ui/chat/compact-auto.ts`、`ChatView.svelte` | 新触发判断、滞回、`compact.decide` |
| `src/tools/` read_note | 查账本；`force` 参数 |
| 写笔记类工具定义 | 登记「正文字段」 |
| `src/ports/persistence.ts` | `CompactMarker` 扩展字段 |
| `src/prompts/defaults/zh.ts` | `internal.compact` 改为状态更新、JSON 输出 |
| 测试 | 计量口径、移出层、滞回、区间不拆组、状态合并不丢条目、旧 marker 兼容 |
| 文档 | 架构文档 `docs/architecture/agent/context-compaction.md` 只写设计，实施中设计有变时同步修改；进度只记在本 spec §5；user-guide `/compact` 说明；CHANGELOG |

不改：Worker、Embedding、权限模型、斜杠命令名、`session.messages` 持久化格式（只扩 marker）。

---

## 7. 参考

- [Anthropic：Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic：Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [Google ADK：Context compaction](https://adk.dev/context/compaction/)
- [Microsoft Agent Framework：Compaction pipeline 示例](https://github.com/microsoft/agent-framework/blob/main/dotnet/samples/02-agents/Agents/Agent_Step18_CompactionPipeline/README.md)
- [AWS Strands：Conversation management](https://strandsagents.com/docs/user-guide/sdk/agents/conversation-management/)
- [AgentScope：Memory compression](https://doc.agentscope.io/tutorial/task_agent.html)
- [LangChain：Context management for Deep Agents](https://www.langchain.com/blog/context-management-for-deepagents)
- [OpenAI：Compaction](https://developers.openai.com/api/docs/guides/compaction)
- 本仓库：`src/core/compact-project.ts`、`src/core/context-manager.ts`、`src/ui/chat/compact-session.ts`、`src/adapters/llm-openai-compat.ts` `buildRequestBody`
