# S-COMPACT-V2 — 上下文压缩分层（投影，不改聊天记录）

> **ID:** S-COMPACT-V2  
> **状态:** Active  
> **日期:** 2026-08-13  
> **前置:** 现有 `/compact`（`compact-session.ts` / `resetSession`）、S-TOOL-HISTORY-400、S-CONTEXT-WINDOW  
> **灵感:** Claude Code compact 管线（microcompact → 全量摘要 → 状态恢复 → auto / PTL 重试）；知乎专栏 [Context 工程：一次 /compact](https://zhuanlan.zhihu.com/p/2004602569171935364)

---

## 1. 背景

现有 `/compact` 是 Claude Code 的简化版：fork 一次 LLM，四段结构化摘要，**`resetSession` 删除会话**，只留摘要 + 最后 3 条原文。确认文案写明「不可撤销」。

问题：

- 用户可见历史被毁掉；自动压缩若沿用此语义不可接受。
- 摘要输入把 `read_note` / `search_vault` 全文原样拼进去，贵且糊。
- 压完模型不知道刚读过哪篇笔记，续活靠「最后 3 条」太脆。
- 只有手动触发；窗口撑爆（API 上下文过长）会直接废掉本轮，没有重试。

约束（已拍板）：

- 界面上的对话 **一条不删、不改字**。压缩只影响发给模型的上下文。
- 自动压缩 **默认开**，设置可关；到阈值 **静默压**（不弹现在这种毁灭性确认框）。
- 按 **整轮** 边界做全量摘要；轮内只做不调 LLM 的工具结果瘦身。
- 撑爆时 **compact 后重试本轮最多 1 次**，会话不因一次超长作废。

---

## 2. 目标

1. **投影压缩**：`session.messages` 仍是 UI 事实源；LLM 看到的是 `projectView()` 产物。  
2. **分层**：上送前 microcompact → 阈值/手动时全量摘要打标记 → 注入最近读过的笔记路径。  
3. **自动压**：占用率超阈值时静默执行；对话流出现系统分隔（压缩中 → 已压缩）。  
4. **撑爆保护**：估算超限先压再发；API 仍报太长则压完重试 1 次；连续失败断路。  
5. **手动 `/compact`**：不再 `delete` 会话；去掉「清空历史」确认框。

成功标准：

- 压缩前后 `session.messages` 条数与正文不变（只多 `compactMarkers`）。  
- 发给 LLM 的 tool 正文：标记点之前的可重取工具只剩占位；摘要输入不含那些全文。  
- 自动压后对话流有一条系统分隔，刷新会话仍在。  
- 设置关闭自动压后，只剩手动 `/compact`。  
- mock LLM 返回 prompt-too-long 时：走 compact + 重试 1 次，不把 session 清空。  
- `npm test` / `npm run build` 通过。

---

## 3. 非目标

- 不抄 Claude Prompt Cache / cache editing / Snip / Context Collapse 读时折叠区间。  
- 不把 Session Memory / `remember` 当摘要替代品（可后续 spec）。  
- 不在生成中途插入全量 LLM 摘要。  
- 不裁剪会话 JSON、不做历史归档。  
- 不恢复笔记全文（最多路径 + 一句「按需 `read_note`」）。  
- 不改四段摘要 prompt 的段落结构（可小改「不要抄工具原文」一条约束）。

---

## 4. 详细设计

### 4.1 数据模型

`Session` 增加可选字段（缺省 = 从未压过，投影 = 全量历史 + microcompact）：

```ts
interface CompactMarker {
  /** messages[0..=afterIndex] 已被本标记摘要覆盖；上送原文从 afterIndex+1 起 */
  afterIndex: number;
  summary: string;
  /** 从被摘要区间抽出的最近读笔记路径，去重保序，最多 5 条 */
  restoredNotePaths: string[];
  at: number;
}

interface Session {
  // ...现有字段
  compactMarkers?: CompactMarker[];
}
```

- UI 按 `messages` 全量渲染；每个 marker 在 `afterIndex` 后插一条 **系统分隔**（不是 `ChatMessage`，避免进 LLM）。  
- 发给模型 **只注入最近一条** marker 的摘要 + `messages.slice(afterIndex + 1)`。更早的 marker 仅作 UI 锚点。  
- 第二次压缩：摘要输入 = 当前投影（已含上一条摘要 + 其后原文），写出新 marker，旧 marker 保留给 UI。

兼容：无 `compactMarkers` 的旧会话文件原样加载。

### 4.2 投影 `projectView(messages, markers, opts)`

纯函数，单测覆盖。顺序：

1. 取最近 marker（若有）：`head = [system: [compact 摘要]\n${summary}]` + 可选 `system: 最近读过的笔记: ...`（`restoredNotePaths`）。  
2. `tail = messages.slice(afterIndex + 1)`；无 marker 则 `tail = messages`。  
3. 对 **tail 里、且不是最近 `KEEP_RECENT_TOOL_RESULTS`（默认 5）条 tool 消息** 做 microcompact。  
4. `sanitizeToolMessageOrder`，避免孤立 `role:tool`。  
5. 返回 `ProjectedTranscript`；`toMessages()` = Composer system / 记忆 / skill / 检索块 + `head` + `trimHistory(tail)`。**`trimHistory` 只裁 tail，不得裁掉 compact 摘要 head。**

```ts
export interface ProjectedTranscript {
  head: ChatMessage[]; // compact 摘要 + 笔记路径 system
  tail: ChatMessage[]; // microcompact 后的原文窗口
}

export function projectView(
  messages: ChatMessage[],
  markers: CompactMarker[] | undefined,
): ProjectedTranscript;
```

`getContextUsage` / `tokenCount` 基于投影后文本，状态条百分比与真实上送一致。

`ContextManager` 新增：
- `getTranscript(): ChatMessage[]` — 返回 `session.messages` 浅拷贝（摘要输入用，不含 Composer 主 system）
- `appendCompactMarker(marker: CompactMarker): Promise<void>` — 写入 `session.compactMarkers` 并 `save`
- 可选 `skipAddUserMessage` 由 `agentLoop` 参数传入（见 §4.6）

**废除 compact 路径上的 `resetSession`。** 方法可留着但 `/compact` 不再调用。

落盘：`session-file-store` 整对象 `JSON.stringify`，只要 `Session` 带上 `compactMarkers` 即可 roundtrip；`hydrateFromRaw` 旧内嵌迁移路径若仍构造 Session 字面量，**必须抄上 compactMarkers**。

### 4.3 Microcompact（不调 LLM）

可折叠工具名：`read_note`、`search_vault`、`grep`、`glob`、`list_files`、`search_memory`。

**关键路径：** 持久化里 `role:tool` **没有** `toolName`（只有 `toolCallId` + `content`）。microcompact 必须向前找带同一 `toolCallId` 的 `assistant`，用其 `toolName` / `toolArgs`。找不到则不折叠。

占位（面向模型，不走 i18n）：

`[compacted] read_note path=notes/x.md chars=12345`

`path=` 取 `toolArgs.path`（字符串才写入，否则省略）；`chars=` 为折叠前 `content.length`。

不可折叠：`remember`、写笔记类（`write_note` / `append_note` / `edit_note` / `delete_note`）、`content` 以 `Error:` 开头的失败结果、用户/助手正文、skill 系统消息。

**何时跑：** 每次 `toMessages` / 摘要输入组装时。轮内不另开 LLM。

### 4.4 全量摘要

沿用 `internal.compact` 四段结构，增加一条：工具结果已被占位，不要臆造笔记原文。

输入：当前投影里「将被新 marker 盖住」的那一段（即现 LLM 历史，不含 Composer 主 system 亦可，避免把人格提示写进摘要）。  
输出空摘要 → 抛错，不写 marker。

新 marker 的 `afterIndex` = 压缩开始时 `messages.length - 1`（压的是「此刻已有的全部历史」；正在输入的下一条 user 还没 push）。  
若在 **发送前** 触发：先压（afterIndex = 最后一条已有消息），再 `addUserMessage`。  
若在 **一轮结束后** 触发：afterIndex = 本轮已写入的最后一条。

`restoredNotePaths`：从被盖住的区间里扫 **assistant** `toolName === 'read_note'` 且 `toolArgs.path` 为非空字符串的调用（近者优先、去重），最多 5 条。不依赖 tool 正文。

### 4.5 自动压缩

- 设置 `autoCompactEnabled: boolean`，默认 `true`，Chat 相关设置组一枚开关。  
- 阈值：`getContextUsage().percentage >= 85`。发送前用估算；一轮结束若有 API `usage` 则用真值校准后再判。  
- 时机：  
  - 用户发送前、agent 未在跑：超阈值 → 先 compact 再进入 loop。  
  - `message.end` 之后：超阈值 → compact（不打断已完成的气泡）。  
  - **生成中途不插队。**  
- 静默：不弹 `showCompactConfirm`。  
- 断路器：本会话连续 3 次 compact 失败（空摘要 / LLM 抛错）→ 本会话不再自动压；手动 `/compact` 仍可；失败计数在一次成功后清零。设置开关切换不重置会话标记。

手动 `/compact`：立刻走全量摘要；无确认框（不再毁历史）。历史不足（投影 tail 过短，如 ≤3 条非 system）则 no-op，Notice 说明。

### 4.6 撑爆重试（整轮保护）

1. 发送前估算已 ≥85%：先全量 compact。  
2. **仅当本轮第一次 `llm.chat` 就判定上下文过长**（且本轮尚未执行任何工具）时：不把半截 assistant / `Error:` 文本写入 session；`error.code = 'CONTEXT_OVERFLOW'`；`plugin.ask()` compact 后以 `skipAddUserMessage: true` 再进 `agentLoop`，最多再 1 次。  
3. 识别：`isPromptTooLong(err)` — 状态 413，或 message / 文案匹配 `/prompt too long|context length|maximum context|上下文过长|too many tokens/i`。  
4. 若本轮已经跑过工具再 overflow：不自动重试（避免重复执行写工具），只 yield 错误；下一次发送前的自动压会接手。  
5. 仍失败：yield `LLM_ERROR`，session 保留用户那一句，不 `resetSession`。

`agentLoop` 增加可选参数 `skipAddUserMessage?: boolean`（默认 false）。

轮内：只靠 microcompact 瘦旧工具结果；不在工具循环中间 fork 摘要 LLM。

断路器：进程内 `Map<sessionId, consecutiveFailures>`，不落盘；插件重载清零。

### 4.7 UI

`Message.role` 扩展为 `'user' | 'assistant' | 'compact'`。`compact` 无 segments（或空数组）；`compactPhase?: 'running' | 'done' | 'failed'`。

- `hydrateSessionMessages(messages, { markers })`：在 `afterIndex` 对应的 **下一条 UI 可见消息之前** 插入 `role:'compact', compactPhase:'done'`（`afterIndex` 落在被跳过的 system/tool 上时，插到该下标之后第一条 user/assistant UI 气泡前；若已是末尾则 append）。  
- 压缩中：在列表末尾临时 push `compactPhase:'running'`，**不写入** `session.messages`。底栏 workbar 仍可显示压缩中。  
- 压完：去掉 running，依赖 hydrate/markers 出现 done 分隔；Notice `chat.compacted` **2.5s**。  
- 失败：running 改为 `failed`，数秒后移除；不写 marker；Notice 现有 `chat.error.compactFailed`。  
- `MessageList`：`role==='compact'` 走居中 muted 一行，不走 `MessageBubble`。  
- 手动 `/compact` 不再调用 `showCompactConfirm`；成功后 **不要** `preservedChatMessagesToUi` 替换列表（历史必须保留），改为按 markers 重新 hydrate 全量 `session.messages`。  
- `compact-confirm.ts` 可删（无引用后）。

### 4.8 错误与并发

- compact 进行中禁止第二次 compact（手动点了显示「正在压缩」）。  
- 切换会话：中止 UI 临时态，不写半截 marker；进行中的 LLM 摘要丢弃结果。  
- compact LLM 调用应传 AbortSignal（与停止钮同一套则更好，非必须接停止钮）。

---

## 5. 影响面

| 区域 | 变化 |
|---|---|
| `src/ports/persistence.ts` | `Session.compactMarkers` |
| `src/core/context-manager.ts` | `toMessages` 走投影；compact API 改为 append marker |
| 新模块 `src/core/compact-project.ts`（名可调） | `projectView` / microcompact / 抽路径，纯函数 |
| `src/ui/chat/compact-session.ts` | 不再 reset；写 marker |
| `src/ui/chat/ChatView.svelte` | 发送前/轮后自动压；系统分隔；拆确认框 |
| `src/core/agent-loop.ts` 或 `main.ts ask()` | PTL → compact → 重试 1 次 |
| `src/settings.ts` + i18n | `autoCompactEnabled` |
| `src/prompts/defaults/zh.ts` | compact 段加「勿抄工具原文」 |
| 测试 | 投影 / 标记 / 历史不变 / 自动阈值 / PTL 重试 / 断路器 |
| user-guide `/compact` | 改为「压缩模型上下文，聊天记录保留」 |

不改：Embedding Worker、vectra、权限模型、斜杠命令名字。

---

## 6. 参考

- `src/ui/chat/compact-session.ts`、`src/core/context-manager.ts` `resetSession` / `trimHistory`  
- `src/core/tool-message-align.ts`  
- `docs/superpowers/archive/S-CLEANUP-1/` A1 compact  
- `docs/superpowers/archive/S-TOOL-HISTORY-400/`  
- Claude Code compact：microcompact 白名单、压后恢复最近文件、auto 阈值、PTL 砍头重试（本 spec 用「压完重试整轮」替代砍头）
