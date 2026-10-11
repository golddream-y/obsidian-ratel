# 笔记约束（AGENTS.md）

> 领域:Agent | 库内笔记的目录约束，不是一种新能力
> 产品设计:[S-NOTE-AGENTS](../../superpowers/archive/S-NOTE-AGENTS/2026-09-26-note-agents-md-design.md) · 子目录注入:[S-AGENTS-SESSION](../../superpowers/archive/S-AGENTS-SESSION/2026-10-10-agents-session-design.md)
>
> 子目录约束的加载位置、留存与去重按 Claude Code 的机制重定，以本文为准。S-AGENTS-INJECT 里「工具内各自注入、追加到系统段、只活一个回合、按目录链去重」四点已被取代。
>
> 对照:[Claude Code 记忆加载](https://code.claude.com/docs/en/memory) · [Claude Code 目录分层](https://code.claude.com/docs/en/large-codebases) · [AGENTS.md](https://agents.md) · [Codex 拼接顺序](https://developers.openai.com/codex/agent-configuration/agents-md)

本文档回答:**用户写在库里的 `AGENTS.md` 何时进入上下文、放在哪、留多久、和技能/记忆如何分工、改这份文件时权限怎么拦。** 写给实现者：照本文实现，不需要再读旧 spec。

---

## 1. 它不是第四种能力

能力池仍然只有三种 `kind`：内置工具、MCP、技能。见 [capability-surface](capability-surface.md)。

`AGENTS.md` 不注册进 ToolRegistry，不出现在斜杠菜单，也不由模型「启用」。它是 Harness 按路径放进上下文的文字。库根那一份每轮都在，模型可以不调用任何新工具就读到它。

| | 技能 | 记忆 | 笔记约束 |
|---|---|---|---|
| 谁写 | 技能作者 | 对话里记住的事实 | 用户在库里写的 Markdown |
| 何时进入 | 点名或模型激活之后 | 钉住的段落每轮都在 | 库根每轮都在；子目录第一次碰到该路径时加载，之后整场会话都在 |
| 管什么 | 一件事的步骤 | 这个人的事实 | 这个目录下的笔记必须怎样 |
| 冲突 | 用户当轮明确指令优先 | 不覆盖约束 | 离笔记更近的优先；用户当轮明确指令压过全部 |

---

## 2. 文件与范围

只认当前库内、文件名恰好是 `AGENTS.md` 的笔记（大小写敏感）。不读 `CLAUDE.md`、`.claude/rules/`、家目录里的同名文件。正文为空或只有空白，视为该层不存在。

一份文件的范围是它所在目录及其下所有笔记。改 `Work/Diary/note.md` 时，要遵守库根、`Work`、`Work/Diary` 里存在的那几份。没碰到的目录不加载。

**目录写法**：库内相对路径，`/` 分隔，无首尾斜杠；库根记为 `''`。工具参数里的路径先过 `validateVaultPath`，校验失败（库外、`..`、绝对路径）就不加载，交给工具自己报错。

**目录链**：笔记 `A/B/c.md` 的链是 `['', 'A', 'A/B']`（`agentsChainDirs`）。目标路径本身就是 `AGENTS.md` 时，从它所在的目录算起：`A/B/AGENTS.md` 的链同样是 `['', 'A', 'A/B']`，不能从父目录起算，否则会漏掉这一层。下文「子目录」指链上除 `''` 以外的目录（`nestedDirs`）。

---

## 3. 机制总览

| | Claude Code | Ratel |
|---|---|---|
| 库根 | 启动时加载；`/compact` 后从磁盘重读 | 每轮从磁盘重读，放在系统段 |
| 子目录何时加载 | 读到该目录的文件时 | 任何笔记工具碰到该路径时（§5.2） |
| 子目录放在哪 | 跟在那次工具结果后，作为对话内容 | 同左，挂在那次工具结果上（§6） |
| 留多久 | 整场会话；压缩后等下次读到该目录才回来 | 同左（§5.4） |
| 去重单位 | 每个目录一次 | 同左 |
| 体积 | 不截断，建议约 200 行内 | 单文件 8KB，单块 16KB（§6.2） |
| 冲突 | 全部叠加，近的后读，不保证谁赢 | 叠加，并在每块末尾写明近的优先 |

```
回合开始 ──► 库根 AGENTS.md 重读 ──► 系统段（记忆之后、工具说明之前）

工具调用（权限与钩子已通过）
  ──► touchedNotePaths
  ──► loadNoteAgents（读盘、按目录去重）
  ──► 执行工具
  ──► addToolResult：content = 结果，noteAgents = 块，成功则加 noteAgentsStale

下一步 llm.chat
  ──► buildHistoryView（投影 / 移出 / 裁剪只改 content）
  ──► materializeNoteAgents（content 后接块，删字段）
  ──► 发给适配器
```

本文用语：

| 词 | 指 |
|---|---|
| 回合 / 本轮 | 一次用户发消息到回答结束（一次 ask） |
| 会话 | `sessionId` 对应的整场对话，跨多个回合 |
| 一步 | agent-loop 里一次 `llm.chat` 及其后那批工具调用 |
| 块 | 一次 `loadNoteAgents` 产出的 `{ dirs, text }`，挂在一条 tool 消息上 |

和 Claude Code 的两处有意差异：

- **库根每轮重读**，比 Claude Code 只在启动和压缩后读更严。用户中途改了库根，下一轮生效。库根在系统段里，一轮之内不变，不破坏前缀缓存。
- **触发不限于读**。Claude Code 实际只在原生 Read 工具上触发（[issue #90449](https://github.com/anthropics/claude-code/issues/90449)），Ratel 按它文档写的意图来：碰到该目录的笔记就加载。

---

## 4. 实现原则

1. **子目录约束是对话内容，不是系统提示。** 只追加到历史末尾，不改系统段，不改写已有消息。系统段在前缀里，每变一次，后面整段历史的前缀缓存都失效。injector 的 `noteAgents` 段只放库根；消息上的 `noteAgents` 字段只放子目录。两个同名不要混用。
2. **结果和约束分字段存。** `content` 只放工具结果，约束放 `noteAgents`。投影、移出、单条上限、截断兜底这些对 `content` 的处理一律不碰 `noteAgents`；只有组装上送包的最后一步才把两者拼起来。
3. **「已加载」从历史视图推导，不另存集合。** 历史视图 = `buildHistoryView()` 的输出：已经过投影 / 移出 / 单条上限 / 截断，但还没 `materialize`，消息上仍带 `noteAgents` 字段。不是 materialize 之后的上送包（字段已删），也不是 `session.messages` 原文（可能含已被压缩投影掉的块）。会话里没有「已见目录」这种可变状态。
4. **加载集中在循环里做，工具不感知。** 由 `agent-loop` 在执行工具前统一算路径、加载约束，块和这次 `tool_call` 绑在同一条消息上。工具函数不再接收约束相关依赖。
5. **不阻塞执行。** 加载只读文件，不改变工具参数、不拒绝调用、不改变工具返回值。没读到文件就当该层不存在。

### 4.1 实现禁令

照着做会偏的几条，写在这里以免各写各的：

| 禁止 | 正确做法 |
|---|---|
| 把子目录正文 `append` 进系统段 / injector | 只写 tool 消息的 `noteAgents` 字段 |
| 按整条目录链或按回合去重（旧 `AgentsChainSeen`） | 按单个目录，从历史视图重算 |
| 在 `for (tc of toolCalls)` 开头缓存一份已加载集合 | 每个工具调用当场调 `loadedNoteAgentsDirs()`，才能看见本步刚写入的块 |
| 看 materialize 之后的上送包判断已加载 | 字段已被删掉，会永远判未加载、每步重复注入 |
| 改写 `ChatMessage` 时 ` { role, content }` 另造对象 | 必须 `{...m, content}`，否则 `noteAgents` 丢失，压缩等于删约束 |
| 编 `AGENTS.md` 时跳过加载 | 执行前仍加载旧版，执行成功再 `stale` 所在目录（§5.6） |
| 过期时把整条祖先链都标 stale | 只标该文件所在目录，即 `nestedDirs(path).at(-1)` |
| 16KB 丢光所有层仍产出一块只有提示的文本 | `return undefined`，不挂块，下次再试 |
| `yield tool.result` 或工具卡片带上约束正文 | UI 只看 `content` |
| 给适配器、摘要、意图分类、子代理带上字段 | 出站前删字段；旁路调用不注入子目录块 |
| 未登记 reader 时抛错 | `loadNoteAgents` 直接 `return undefined`（测试与压缩重试） |

---

## 5. 加载流程

### 5.1 回合开始：库根

每次用户发消息（`main.ts` 的 ask 流程）：

1. 读库根 `AGENTS.md`。不存在、读失败、正文为空，库根段置空。
2. `ctx.setNoteAgentsRoot(text)`：经 `composeNoteAgentsRootPrompt` 加段首、按 8KB 截断，作为 injector 的 `noteAgents` 段，排在记忆之后、工具说明之前。
3. `ctx.setNoteAgentsReader(read)`：登记本轮读子目录文件的函数（按目录返回正文或 `null`，内部做存在判断、`validateVaultPath`、不跟随库外符号链接、打 `agents.file` 面包屑）。

库根不进入 §5.2 的块，也不参与「已加载」判断。回合中途用 `write_note` 等改了库根，本轮系统段不变，下一轮生效。

### 5.2 工具调用：子目录

触发工具与取路径的规则集中登记在 `note-agents.ts` 的 `NOTE_AGENTS_TOUCH`（`as const`，见 AGENTS.md「枚举与 ID 集中管理」）：

| 工具 | 碰到的路径（按此顺序） |
|---|---|
| `read_note` `write_note` `append_note` `edit_note` `delete_note` | `args.path` |
| `apply_patch` | `peekUpdateFilePath(args.patch)` |
| `move_note` | `args.from`，`args.to` |
| `copy_note` | `args.to` |

`grep`、`glob`、`list_files`、`search_vault` 等只返回路径或片段，不在表里，不触发。表里没有的工具名，`touchedNotePaths` 返回 `[]`。

`touchedNotePaths(tc)`：按上表取字符串；`apply_patch` 在 `args.patch` 不是字符串或 `peekUpdateFilePath` 得不到路径时视为没有路径。每条路径过 `validateVaultPath`，失败的丢弃（工具自己会报错）。`move_note` 两条都要，顺序 `from` 然后 `to`。

`agent-loop` 现有分支怎么接（改的是这一段，不要另起一套循环）：

| 现有分支 | 加载？ | `addToolResult` |
|---|---|---|
| `argsIssue`（参数非法） | 否 | 两参数，与现在相同 |
| 权限拒绝 / `pre-tool-use` 拒绝 | 否 | 两参数，与现在相同 |
| 取消发生在加载期间 | 丢弃块，按现有取消退出，不写 tool 消息 | — |
| 加载之后、执行期间取消 | 块未落盘，按现有取消退出；该目录下次再加载 | — |
| 执行抛错 / 超时 / 结果以 `Error:` 开头 | 是（加载在执行前已完成） | 三参数，带 `noteAgents`，不带 `noteAgentsStale` |
| 执行成功 | 是 | 三参数，带 `noteAgents` 与 `noteAgentsStale`（可能都为空则省略） |

成功路径的顺序固定为：

```
paths = touchedNotePaths(tc)
block = await ctx.loadNoteAgents(paths)     // 未登记 reader 或 paths 空 → undefined
result = await tools.execute(tc)            // 与现在相同，含超时
stale = toolFailed ? undefined : staleAgentsDirs(paths)
ctx.addToolResult(tc.id, content, {
  noteAgents: block,                        // undefined 则字段缺省
  noteAgentsStale: stale,                   // 空数组则字段缺省
})
```

`yield { type: 'tool.result' }` 仍只发工具结果，不含块。约束第一次被模型看见，是**同一用户回合里下一次** `llm.chat`（agent-loop 下一步），不是下一轮用户消息。

`ctx.loadNoteAgents(paths)`：

```
loaded = ctx.loadedNoteAgentsDirs()                  // §5.4
wanted = []                                          // 有序、去重
for p of paths:
  for d of nestedDirs(p):                            // 每条链浅的在前
    if d not in loaded and d not in wanted: wanted.push(d)
layers = []
for d of wanted:
  text = await reader(d)
  if text 非空: layers.push({ dir: d, text })
if layers 为空: return undefined
return joinAgentsBlock(layers)                       // §6.2；丢光所有层也 return undefined
```

- 没有 `AGENTS.md` 的目录不进 `dirs`，每次碰到都重新判断一次存在。会话中途新建的 `AGENTS.md` 因此能被发现；代价是每次工具调用对链上每个未加载目录做一次存在判断。
- 执行失败也照样挂块：路径已经碰到了，模型重试前就该看到约束。`content` 仍只描述磁盘上的原因。
- 一次调用两条路径（移动）时，两条链合成一块，`from` 的目录在前，已在 `wanted` 里的不重复。
- 改某个目录的 `AGENTS.md` 时同样先加载：加载到的是改之前的正文，成功后再 stale（§5.6）。不要为「目标就是约束文件」开特例。

工具参数在这次调用时已经定好，所以第一次碰到某个目录时，约束要到下一次模型请求才被看到。Claude Code 也一样：它的编辑工具要求先读过文件，读的那一步顺带加载约束；新建文件到一个没读过的目录时，同样是先写后看到。

### 5.3 组装上送包

`ctx.toMessages()` 的历史部分抽成一个私有函数 `buildHistoryView()`，`toMessages` 和 §5.4 共用，保证两边看到的是同一份历史：

```
projectView(history, markers)      // 压缩标记之前的历史换成摘要；microcompact、offloadStalePayload 只改 content
→ pruneToolContents                // 32k 码点只按 content 计、只裁 content
→ trimHistory                      // 估算 token 时 tool 消息按 content + noteAgents.text 计
                                   // 步骤 3 丢整条消息：块随之离开
                                   // 步骤 4 把 content 换成 [truncated]：块保留
= 历史视图（消息上仍带 noteAgents 字段）
```

三份数据不要用错：

| 名字 | 是什么 | 谁用 |
|---|---|---|
| 会话原文 | `session.messages`，只追加 | 界面、落盘、`getTranscript` |
| 历史视图 | `buildHistoryView()`，带字段 | `loadedNoteAgentsDirs`、`toMessages` 的输入 |
| 上送包 | `materializeNoteAgents` 之后 | 适配器、`outbound-measure`（此时 `content` 已含块，按 `content` 计量即可） |

`toMessages` 在历史视图之后做最后一步 `materializeNoteAgents`：对带 `noteAgents` 的 tool 消息，生成新对象 `{...m, content: content + '\n\n' + noteAgents.text}`，并 `delete` 掉 `noteAgents`、`noteAgentsStale`。适配器只看到拼好的 `content`，不需要改。

`session.messages` 不改写。界面（`getTranscript`、工具卡片、`hydrate-session-messages`）只用 `content`，不显示约束块。`compact-session.ts` 生成摘要时也只拼 `content`，约束块不进摘要输入，压缩后由 §5.4 自然触发重新加载。

`trimHistory` 发生在 materialize 之前，估算 token 时 tool 消息按 `content + (noteAgents?.text ?? '')` 计。`outbound-measure` 量的是 materialize 之后的上送包，继续只看 `content`。

### 5.4 「已加载」判定

`ctx.loadedNoteAgentsDirs()`：调用 `buildHistoryView()`，按消息顺序折叠：

```
loaded = 空集合
for m of 历史视图:
  if m.role != 'tool': continue
  for d of m.noteAgents?.dirs ?? []: loaded.add(d)
  for d of m.noteAgentsStale ?? []: loaded.delete(d)  // 同一条消息里先加后删
return loaded
```

先加后删的原因：编辑 `A/AGENTS.md` 那次调用，步骤 3 加载的是改之前的 `A`，步骤 5 又标记 `A` 已过期。同一条消息里必须让过期生效。

刚写进 `session.messages` 的消息会出现在下一次重算的历史视图里，所以同一步里后一个工具碰到同目录时不会重复加载。每一次 `loadNoteAgents` 都当场重算，禁止在 `for (tc)` 外缓存。`buildHistoryView` 本来每次请求都要跑，多算几次可以接受。

由此得到的生命周期：

| 情况 | 结果 |
|---|---|
| 同一会话后续轮次再碰到该目录 | 块还在历史视图里，不重复加载 |
| 全量摘要或手动 `/compact` 覆盖了那条 tool 消息 | 块离开历史视图；下次碰到该目录时重新加载 |
| `trimHistory` 步骤 3 丢掉了那条 tool 消息 | 同上 |
| microcompact、offload、单条上限、`trimHistory` 步骤 4 | 只改 `content`，块还在 |
| 切换会话 | 历史不同，自然不同 |
| 重载插件、重开会话 | 字段随会话落盘，重算后仍是已加载 |
| 改了 `AGENTS.md`（经工具） | §5.6 |

### 5.5 先后顺序与冲突

块内按 `nestedDirs` 浅的在前。不同块之间按加载先后，出现在历史里的先后。

一般情况下祖先目录先于子目录加载，因为碰到子目录的路径时，未加载的祖先会一起进同一块。例外：压缩覆盖了祖先所在的那条消息，子目录那条还在；再碰到时祖先单独加载，排到子目录块之后。因此每块末尾都写明「同一件事冲突时，离笔记更近的优先」，远近关系不靠先后顺序表达。

### 5.6 约束文件自身被改

「成功」= 未抛错、结果字符串不以 `Error:` 开头（与 agent-loop 现有 `toolFailed` 相同）。

`staleAgentsDirs(paths)`：对 `paths` 里每一条，最后一段恰好是 `AGENTS.md` 时，取**该文件所在目录** `nestedDirs(path).at(-1)`。没有 `.at(-1)`（库根那份）则跳过。结果去重。不要把祖先目录一并列入。

```
Work/AGENTS.md            → ['Work']
A/B/AGENTS.md             → ['A/B']          // 不是 ['A','A/B']
AGENTS.md（库根）          → []
move A/AGENTS.md → B/C.md  → ['A']            // 源过期；目标不是 AGENTS.md
move A/AGENTS.md → B/AGENTS.md → ['A','B']
copy X.md → B/AGENTS.md    → ['B']            // copy 的 paths 只有 to
delete Work/AGENTS.md      → ['Work']
```

该列表写入本条 tool 消息的 `noteAgentsStale`。§5.4 折叠到这里时把它移出已加载集合，下次碰到该目录时加载新版本（删除后文件不存在，不加载）。旧块留在历史里不改写，新块排在后面，以新块为准。

确认卡（§7）与过期是两件事：`copy_note` 的确认仍看 `from`，过期看 `to`。不要为了对齐去改确认卡。

用户在 Obsidian 里直接改这些文件不做检测，直到块离开历史视图、重新加载时才拿到新版。

---

## 6. 数据与格式

### 6.1 字段

`ChatMessage`（`src/ports/llm.ts`）新增两个可选字段，只在 `role: 'tool'` 上设置，随会话落盘，旧会话缺省：

```ts
/** 本次工具调用新加载的子目录 AGENTS.md;dirs 是实际放进 text 的目录 */
noteAgents?: { dirs: string[]; text: string };
/** 本次工具调用成功改写了哪些子目录的 AGENTS.md;这些目录此前加载的版本作废 */
noteAgentsStale?: string[];
```

`ctx.addToolResult(toolCallId, result, extra?)` 增加第三个可选参数接收这两个字段；未传时与现在完全相同。

### 6.2 块的文字与体积

`joinAgentsBlock(layers)` 返回 `{ dirs, text }`，`text` 形如：

```
[目录约束 AGENTS.md] 下面是本次路径所在目录的约束，本会话内持续有效；同一目录之后再出现新版本时以新版本为准。

## Work
（Work/AGENTS.md 正文）

## Work/Diary
（Work/Diary/AGENTS.md 正文）

同一件事冲突时，离笔记更近的优先。用户这一轮的明确指令优先于这些文件。

较远的约束已截断。
```

- 首行和优先级一句是给模型看的固定文本，作为常量放在 `note-agents.ts`，不走 i18n（AGENTS.md i18n 例外：LLM 收到的 prompt 正文）。截断提示沿用现有 `noteAgents.truncated`。
- 每层标题是 `## <目录>`，与库根段区分；块里不会出现库根。
- 先单文件截到 8KB（UTF-8，不切断多字节字符），被截短的那层仍算已加载，进 `dirs`。
- 整块（含首行、标题、优先级一句、截断提示）超过 16KB 时，从块首那层开始整层丢弃，直到不超；有丢弃或截短就加截断提示。被丢弃的层不进 `dirs`，下次碰到时再试；那时更深的层已加载，块会小很多。
- `dirs` 只含最终留在 `text` 里的层，不是 `wanted` 全表。
- 丢到一层都不剩：`return undefined`，不挂块。
- 拼接时前面固定加 `\n\n`（§5.3），不另加分隔线。
- 落盘：字段是 `ChatMessage` 的一部分，随现有 session JSON 走。不要在 persistence 里剥掉未知字段。旧会话缺省这两个字段，视为从未加载子目录。

---

## 7. 改约束文件

`write_note`、`edit_note`、`append_note`、`delete_note` 的 `path`，`apply_patch` 补丁里的 Update File 路径，以及 `move_note`、`copy_note` 的 `from`，最后一段是 `AGENTS.md` 时，必须走现有确认卡。

现有 `resolveToolPermission` 在「允许」、危险档、本会话不再询问、目标授权处会直接返回，到不了确认。因此这道判断放在「拒绝」之后、其余短路之前。拒绝仍然拒绝，不弹卡。

模型可以先用文字提议修改。用户点头之后，工具侧仍弹确认卡。整理别的笔记时不许把 `AGENTS.md` 算进改动。

---

## 8. 不做什么

- 不执行约束正文里的命令或脚本。Codex 会跑文件里列出的检查；笔记库的步骤仍走技能。
- 不做 `AGENTS.override.md`。冲突只靠「近的优先」。
- 不做 Claude Code 的 `@path` 导入、`.claude/rules/` 按路径匹配的规则、`claudeMdExcludes`、HTML 注释剥离。
- 不检测用户在库里直接改了子目录 `AGENTS.md`（§5.6）。
- 不把约束注入技能沙箱、子代理、意图分类、压缩摘要这些旁路模型调用，也不让 `update_app_config` 改这些文件。
- 技能和约束可以同时在上下文里。提示写明：技能是步骤，`AGENTS.md` 是笔记约束。

---

## 9. 模块改动

| 模块 | 职责 |
|---|---|
| `src/tools/note-agents.ts` | 目录链、`NOTE_AGENTS_TOUCH`、`touchedNotePaths`、`staleAgentsDirs`、UTF-8 截断、`joinAgentsBlock` |
| `src/core/agent-loop.ts` | §5.2 的步骤：权限与钩子通过后加载，执行后算过期，交给 `addToolResult` |
| `src/core/context-manager.ts` | `setNoteAgentsRoot`、`setNoteAgentsReader`、`loadNoteAgents`、`loadedNoteAgentsDirs`、`buildHistoryView`、`materializeNoteAgents`；`trimHistory` 计入块的 token；`addToolResult` 第三参 |
| `src/core/compact-project.ts` 等 | 改写消息必须 `{...m, content}`，保留 `noteAgents` / `noteAgentsStale` |
| `src/ports/llm.ts` | `ChatMessage.noteAgents`、`noteAgentsStale` |
| `src/main.ts` | 每轮读库根、登记 reader；不再持有 `noteAgentsTurn` |
| `src/core/tool-permissions.ts` | `mustConfirmAgentsMd`，不变 |
| 笔记工具 | 不再接收约束依赖，只做本职操作 |

新增或改签名（名称以能对上本文为准，不要另发明一套）：

```ts
touchedNotePaths(tc: ToolCall): string[]
staleAgentsDirs(paths: string[]): string[]
joinAgentsBlock(layers: { dir: string; text: string }[]): { dirs: string[]; text: string } | undefined

class ContextManager {
  setNoteAgentsRoot(rootContent: string): void
  setNoteAgentsReader(read: ((dir: string) => Promise<string | null>) | undefined): void
  loadNoteAgents(paths: string[]): Promise<{ dirs: string[]; text: string } | undefined>
  loadedNoteAgentsDirs(): Set<string>
  addToolResult(
    toolCallId: string,
    result: string,
    extra?: { noteAgents?: { dirs: string[]; text: string }; noteAgentsStale?: string[] },
  ): void
}
```

`loadedNoteAgentsDirs` / `buildHistoryView` / `materializeNoteAgents` 可以是 private，只要 `loadNoteAgents` 与 `toMessages` 共用同一份历史视图。

需要删掉的旧实现：

| 删除 | 原因 |
|---|---|
| `AgentsChainSeen`、`collectUnseenAgentsChain`、`injectAgentsForPaths` | 按回合新建、按整条链去重，被 §5.2、§5.4 取代 |
| `applyNoteAgentsGate` | 旧闸门，已无调用方 |
| `NoteAgentsToolDeps` 与各笔记工具的 `getAgents` 参数 | 加载移到 `agent-loop` |
| `ContextManager.appendNoteAgentsChain` | 不再写系统段 |
| `main.ts` 的 `noteAgentsTurn` | 同上 |

---

## 10. 验收用例

以下每条都要有测试。路径均为库内相对路径。

| 场景 | 操作 | 期望 |
|---|---|---|
| 首次加载 | `read_note Work/a.md`，`Work/AGENTS.md` 存在 | 这条 tool 消息 `noteAgents.dirs = ['Work']`；上送包里该消息 `content` 以结果开头、后接块；系统段不变 |
| 跨轮不重复 | 下一轮 `write_note Work/b.md` | 不再加载，`noteAgents` 缺省 |
| 按目录去重 | 已加载 `Work`，再 `edit_note Work/Diary/c.md` | 只加载 `Work/Diary` |
| 同批去重 | 一次回复里两个工具都碰 `Work/Diary` | 只有第一条带块 |
| 没有文件的目录 | `Work/Notes/` 下无 `AGENTS.md` | 不进 `dirs`；之后新建该文件，下次碰到时加载 |
| 执行前被拒 | 权限拒绝或钩子拒绝 | 不加载 |
| 执行失败 | `move_note` 原路径不存在 | 照样挂块，`content` 只有错误原因 |
| 移动两条链 | `move_note A/x.md → B/y.md` | 一块，`A` 在前 `B` 在后 |
| 压缩后 | 全量摘要覆盖了带 `Work` 块的消息，再碰 `Work/a.md` | 重新加载 `Work` |
| 移出不丢块 | 带块的 `read_note` 结果被 offload | 上送包里占位后仍接着块 |
| 截断丢消息 | `trimHistory` 步骤 3 丢掉带块的消息 | 下次碰到时重新加载 |
| 改约束文件 | 确认后 `edit_note Work/AGENTS.md` 成功 | 该消息可同时有旧版 `noteAgents` 与 `noteAgentsStale = ['Work']`；下次碰 `Work` 下任何笔记，加载新版 |
| 过期粒度 | 改 `A/B/AGENTS.md` | stale 只有 `['A/B']`，不是 `['A','A/B']` |
| 改库根 | 回合中途改库根 `AGENTS.md` | 本轮系统段不变，下一轮是新版；不记过期 |
| 体积 | 三层各 7KB | 最浅那层被丢弃，不进 `dirs`，有截断提示 |
| 丢光 | 单层远超 16KB | 不挂块，该目录仍未加载 |
| 重载 | 加载后保存会话、重新 `load` | 仍判为已加载 |
| 适配器隔离 | 任意带块消息 | 发给适配器的消息没有 `noteAgents`、`noteAgentsStale` 字段 |
| 界面隔离 | 任意带块消息 | `tool.result` 事件、工具卡片、摘要输入里没有块文字 |
| 无 reader | 测试里不登记 reader | `loadNoteAgents` 返回 `undefined`，工具照常执行 |
