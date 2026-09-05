# S-READ-PRESERVE — microcompact 保留 read_note 全文

> 日期: 2026-09-05
> 状态: Active
> Spec ID: **S-READ-PRESERVE**
> 关联: [S-COMPACT-V2](../archive/S-COMPACT-V2/2026-08-13-compact-v2-design.md)(microcompact / 投影)、[S-CTX-TRIM](../archive/S-CTX-TRIM/2026-08-16-context-trim-vs-compact-design.md)(单条 32k 码点裁)

---

## 1. 背景

知识库长任务(例如「研究日记机制 + 模板 + 插件」)会在同一回合并行 `read_note` 多篇。下一拍 `toMessages()` 走 `projectView` → `microcompactMessages`:除最近 `KEEP_RECENT_TOOL_RESULTS`(5)条外,可折叠工具正文换成 `[compacted] read_note path=… chars=N`。

一批 6 篇就会折掉最早那篇;再夹杂 `grep` / `glob` / `list_files`,上一整批笔记正文都会消失。模型(尤其 GLM 一类工具环较弱的)看到「读过但没有全文」,会把同一组路径再调一遍,侧栏表现为循环「查看」。

这不是 `read_note` 实现死循环,也不是 UI 重复绘制。对照:

| 产品 | 做法 | 对 Ratel 的启示 |
|---|---|---|
| Claude Code 教学复刻 | `PRESERVE_RESULT_TOOLS = {read_file}`;折掉读文件会循环(issue #62) | **不要折笔记全文** |
| Claude Code 官方 | 旧 tool_result 换成 cleared 占位,磁盘可再读 | 编码 Agent 可再 `cat`;库 Agent 再读贵且内容未变 |
| Codex | 整段摘要丢掉工具输出,默认再读文件 | 不适合「读完再综合」 |
| Cursor | 大输出落盘,摘要后给历史文件让模型搜 | 过重,本 spec 不做 |
| LangGraph RAG | 检索一次再合成,少用开放 ReAct 瞎转 | prompt 禁止「已有全文再读」 |

S-COMPACT-V2 把 `read_note` 放进 `FOLDABLE_TOOL_NAMES`,并在全量摘要后写「最近读过的笔记(**按需 read_note**)」,等于邀请再读。对编码仓库合理,对 Obsidian 笔记同一回合不合理。

## 2. 目标

1. 同一会话、尚未做**全量** compact 时,已成功的 `read_note` 全文继续出现在上送包里(仍受单条 32k 码点裁)。
2. 模型收到明确指令:上下文里已有某篇全文则禁止再 `read_note`;只有占位、截断或全量摘要后的路径清单才允许再读。
3. `grep` / `glob` / `list_files` / `search_vault` / `search_memory` 仍按条数 microcompact,窗口不被旧检索刷爆。

## 3. 非目标

- 不做按路径的 read-once 工具层拦截(GLM 仍乱调时另开 spec)。
- 不把大工具输出落到 vault 文件(Cursor 式动态发现)。
- 不改 `KEEP_RECENT_TOOL_RESULTS` 数值、不改 85% 自动摘要阈值。
- 不改 `search_vault` 不返回 chunk 正文的契约。
- 不合并并行 `tool_calls` 为单条 assistant(DeepSeek thinking 拆条保留)。
- 不把本问题写进 PRD 支柱。

---

## 4. 详细设计

### 4.1 microcompact: `read_note` 不可折叠

`src/core/compact-project.ts` 的 `FOLDABLE_TOOL_NAMES` **删除** `read_note`。

保留:

- `search_vault`
- `grep`
- `glob`
- `list_files`
- `search_memory`

`microcompactMessages` 逻辑不变:只对集合内且非 `Error:` 开头的旧 tool 换占位。`read_note` 因不在集合而不折。`remember` 等本就不在集合。

`KEEP_RECENT_TOOL_RESULTS = 5` 仍按 **可折叠** tool 下标计:六次 `read_note` 不算进 foldCount。六次 `grep` 仍折掉最早一条。

### 4.2 单条上限仍作用于 read_note

`pruneToolContents`(S-CTX-TRIM)继续对所有 `role=tool` 且非 `Error:` 做 32k 码点头尾裁。超长单篇变成带 `[truncated N chars]` 的头尾,不是 `[compacted] read_note`。

prompt(§4.4)把 `[truncated` 视为「可以再读或缩小范围」,与「完整 JSON 正文已在上下文」区分。

### 4.3 全量摘要后的路径清单(文案)

`projectView` 在存在 `compactMarkers` 且 `restoredNotePaths.length > 0` 时注入的 system 行,现文案为:

`最近读过的笔记（按需 read_note）:`

改为(硬编码,面向模型,不走 i18n,与 `[compacted]` 同类):

`最近读过的笔记（仅当上下文中没有该篇 read_note 全文时再读）:`

`extractRestoredNotePaths` / `MAX_RESTORED_NOTE_PATHS` 不变。全量摘要之后 tail 里通常已无被盖住区间的全文,再读合法。

`formatCompactedPlaceholder` 格式不变(`[compacted] {name} path=… chars=…`),不再用于 `read_note`。

### 4.4 RAG 工作流 prompt

改 `src/prompts/defaults/zh.ts` 的 `agent.rag.workflow`(Composer 唯一默认源)。在现有第 2 步后插入禁止重读,后续步骤顺延编号:

落地后默认正文为(编号固定):

1. 调用 `search_vault` 查找相关笔记(结果带 index 编号)。
2. 对有价值的结果调用 `read_note` 读全文。
3. 禁止对「上一拍 tool 结果里已有该 path 全文」的笔记再次 `read_note`。仅当该篇只剩 `[compacted]`、`[truncated`、或全量摘要后的路径清单时,才允许再读。
4. 凡依据检索结论的句子,句末必须写 `[n]`(与 `search_vault` 返回的 index 一致);禁止只用文件名或表格代替 `[n]` 作为唯一引用方式。
5. 同一回合若多次调用 `search_vault`,只用最后一次返回的 index。
6. 若无结果,如实告知。

原第 3–5 条内容不变,仅整体后移一条。`agent.rag.toolGuide` 里「已知路径或需全文:用 read_note」保持;不在 toolGuide 重复长文。用户若覆盖了 `agent.rag.workflow` section,以其覆盖为准(与现网 Composer 行为一致);默认覆盖为空。

### 4.5 测试

改 `tests/core/compact-project.test.ts`:

- 原「旧 read_note 超保留条数 - 正文变占位」改为用 `grep`(或 `list_files`)造 6 条,断言最早一条 `[compacted] grep`,最近一条仍是全文。
- 新增:6 条 `read_note` 且 `keepRecent=5` — **全部 6 条 tool 正文仍是全文**,无一 `[compacted]`。
- `Error:` / `remember` 用例可继续用 `read_note` 或不改。
- `projectView` 有标记用例:断言 head 含新文案关键字「没有该篇」,且仍含路径;断言 **不含**「按需 read_note」。

prompt 无强制单测;若已有 Composer 快照测 `agent.rag.workflow` 原文,同步改期望。

### 4.6 用户可见文档

- **CHANGELOG `[Unreleased]`**: Fixed — 同一对话里不会因为上下文瘦身而反复「查看」同一篇笔记(场景语言,不写模块名)。
- **不改** README / PRD / user-guide(无新开关、无新斜杠命令)。
- **不改** ADR(未推翻 S-COMPACT-V2 投影架构,只收窄可折叠集合)。

---

## 5. 影响面

| 路径 | 变更 |
|---|---|
| `src/core/compact-project.ts` | `FOLDABLE_TOOL_NAMES`; `projectView` 恢复路径 system 文案 |
| `tests/core/compact-project.test.ts` | 见 4.5 |
| `src/prompts/defaults/zh.ts` | `agent.rag.workflow` |
| `CHANGELOG.md` | `[Unreleased]` Fixed |

长对话里多篇全文会更快逼近 85% 自动摘要。这是预期:该走 S-COMPACT-V2 全量摘要时再走,而不是每拍折掉笔记再读。

## 6. 参考

- S-COMPACT-V2 design § microcompact / restoredNotePaths
- [learn-claude-code PR #247](https://github.com/shareAI-lab/learn-claude-code/pull/247)(microcompact 清 `read_file` 导致循环)
- [Claude Code microCompact.ts](https://github.com/claude-code-best/claude-code/blob/632f3e19/src/services/compact/microCompact.ts)(keepRecent + cleared 占位)
- [Cursor Dynamic Context Discovery](https://cursor.com/blog/dynamic-context-discovery)(本 spec 明确不采用落盘)
