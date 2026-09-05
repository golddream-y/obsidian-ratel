# S-READ-PRESERVE — microcompact 保留 read_note 全文

> 日期: 2026-09-05
> 修订: 2026-09-05 **图工具审查** — 明确图切片不进 microcompact;prompt 卡住沿边遍历 + 因邻居清单再读全文
> 状态: Active
> Spec ID: **S-READ-PRESERVE**
> 关联: [S-COMPACT-V2](../archive/S-COMPACT-V2/2026-08-13-compact-v2-design.md)、[S-CTX-TRIM](../archive/S-CTX-TRIM/2026-08-16-context-trim-vs-compact-design.md)、[ADR-013](../../adr/2026-08-03-graph-retrieval-minimize-human-curation.md)(图是增益通道,默认 1 跳、hub 降权)

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
3. 发现类工具(`grep` / `glob` / `list_files` / `search_vault` / `search_memory`)仍按条数 microcompact,窗口不被旧检索刷爆。
4. **图切片工具保持可复用、不被折成占位**,且 prompt 禁止沿边无限 hop、禁止把枢纽邻居整表 `read_note`(ADR-013:图是增益,不是爬全库)。

## 3. 非目标

- 不做按路径的 read-once 工具层拦截(GLM 仍乱调时另开 spec)。
- 不把大工具输出落到 vault 文件(Cursor 式动态发现)。
- 不改 `KEEP_RECENT_TOOL_RESULTS` 数值、不改 85% 自动摘要阈值。
- 不改 `search_vault` 不返回 chunk 正文的契约,也不在本 spec 落地 ADR-013 §3.1 的检索内 1 跳扩邻(那是检索管线,不是 compact)。
- 不把 `get_links` / `search_by_tag` / `search_by_property` / `get_vault_structure` **加入** `FOLDABLE_TOOL_NAMES`(折掉切片会逼模型再调图工具,再连带 `read_note`,比留 JSON 更糟)。
- 不合并并行 `tool_calls` 为单条 assistant(DeepSeek thinking 拆条保留)。
- 不把本问题写进 PRD 支柱。

---

## 4. 详细设计

### 4.1 哪些折、哪些留(含图)

`microcompactMessages` 先按 **全部** `role=tool` 下标算出「最早的 N-5 条」为折叠候选,再对候选检查 `FOLDABLE_TOOL_NAMES`;不在集合内的**跳过**(正文原样)。因此:把某工具移出集合 = 即使排在很早也不折;把图工具加进集合 = 旧切片变 `[compacted]`,模型会再 `get_links` / 再读邻居。

| 类别 | 工具 | microcompact | 理由 |
|---|---|---|---|
| 笔记全文 | `read_note` | **本 spec:移出集合,不折** | 折掉会循环「查看」 |
| 图切片 | `get_links`、`search_by_tag`、`search_by_property`、`get_vault_structure` | **保持不在集合** | 返回路径/出链/反链/未解析,体量远小于全文;折掉会丢结构又逼再查,再诱发 `read_note` |
| 小元数据 | `get_note_outline`、`list_recent_notes`、`get_daily_note`、`get_active_note`、`get_datetime` 等 | 保持不在集合 | 短 JSON,折无收益 |
| 发现/可重跑 | `search_vault`、`grep`、`glob`、`list_files`、`search_memory` | **仍折** | 结果可再查;citation index 以「最后一次 search_vault」为准(工作流原句) |

`FOLDABLE_TOOL_NAMES` 落地后仅为:

- `search_vault`
- `grep`
- `glob`
- `list_files`
- `search_memory`

`KEEP_RECENT_TOOL_RESULTS = 5` 仍按全部 tool 条数切候选窗口,但候选里的 `read_note` / `get_links` 等会 `continue` 不改正文。六次 `grep` 仍折最早一条。六次 `read_note` 或六次 `get_links` 全部保留全文/切片。

### 4.1a 图循环(与检索正交)

ADR-013:默认检索主路径是向量(+BM25);`get_links` 是**显式**图切片,不是自动爬图。日记/MOC 出链扇出大,沿边 `read_note` 等于把「今天点开过的一切」灌进上下文。

本 spec **不改** `search_vault` / Worker hybrid 实现,只约束 Agent 行为:

1. **同一参数的图工具不要重跑**:上一拍已有该 `path` 的 `get_links` 结果(且不是 `[compacted]`),禁止再调。`search_by_tag` / `search_by_property` / `get_vault_structure` 相同。
2. **默认最多 1 跳**:看完一篇的出链/反链后,不要对每个邻居再 `get_links`(禁止 BFS/DFS 巡库)。
3. **枢纽不要整表读正文**:出链或反链明显很多时(日记、MOC、模板),只对与用户问题相关的少数邻居 `read_note`,不要清单里每一篇都读。
4. **邻居清单不能覆盖「已有全文」**:某 path 已有 `read_note` 全文,即使它出现在另一篇的 `get_links` 里也不要再读。
5. **引用通道不变**:`[n]` 只来自 `search_vault` 的 index;`get_links` 不产生 citation index。禁止为了凑引用而对图邻居再跑一遍相同 query 的 `search_vault`。

不把图工具折进 `[compacted]`,才能让 1、4 成立(模型还能看见切片和全文)。

### 4.2 单条上限仍作用于 read_note(及图 JSON)

`pruneToolContents`(S-CTX-TRIM)继续对所有 `role=tool` 且非 `Error:` 做 32k 码点头尾裁。超长单篇变成带 `[truncated N chars]` 的头尾,不是 `[compacted] read_note`。

prompt(§4.4)把 `[truncated` 视为「可以再读或缩小范围」,与「完整 JSON 正文已在上下文」区分。

### 4.3 全量摘要后的路径清单(文案)

`projectView` 在存在 `compactMarkers` 且 `restoredNotePaths.length > 0` 时注入的 system 行,现文案为:

`最近读过的笔记（按需 read_note）:`

改为(硬编码,面向模型,不走 i18n,与 `[compacted]` 同类):

`最近读过的笔记（仅当上下文中没有该篇 read_note 全文时再读）:`

`extractRestoredNotePaths` / `MAX_RESTORED_NOTE_PATHS` 不变。全量摘要之后 tail 里通常已无被盖住区间的全文,再读合法。

`formatCompactedPlaceholder` 格式不变(`[compacted] {name} path=… chars=…`),不再用于 `read_note`。

### 4.4 RAG 工作流 + 图工具指引

只改 `src/prompts/defaults/zh.ts`。**不要**把「凡知识库问题必须先 `search_vault`」写得更硬:关系/反链问题仍走 `toolGuide` 的 `get_links`,否则会伤图检索(用语义检索顶掉结构切片)。

`agent.rag.workflow` 落地正文:

1. 语义主题用 `search_vault` 查找相关笔记(结果带 index 编号)。链接/标签/属性/目录结构问题先按 `toolGuide` 选图或过滤工具,需要语义补召时再 `search_vault`。
2. 对有价值、且上下文中尚无该 path **全文** 的笔记调用 `read_note`。
3. 禁止对「上一拍 tool 结果里已有该 path 全文」的笔记再次 `read_note`。仅当该篇只剩 `[compacted]`、`[truncated`、或全量摘要后的路径清单时,才允许再读。
4. 凡依据 **search_vault** 检索结论的句子,句末必须写 `[n]`(与最后一次 `search_vault` 返回的 index 一致);禁止只用文件名或表格代替 `[n]` 作为唯一引用方式。仅依据 `get_links` 等图切片的句子不编造 `[n]`。
5. 同一回合若多次调用 `search_vault`,只用最后一次返回的 index;禁止为给图邻居凑引用而用相同 query 再搜一遍。
6. 若无结果,如实告知。

`agent.rag.toolGuide` 在现有 `get_links` / tag / property / structure 四条之后追加(短句,不另开 section):

- 图工具结果若已在上下文中且参数相同,不要重跑。
- 不要沿出链/反链逐个再 `get_links`(默认最多 1 跳)。日记、MOC、出链或反链特别多的篇,不要把邻居全部 `read_note`。
- 已有 `read_note` 全文的 path,不因出现在别人的链接清单里再读。

用户覆盖了对应 section 时以其覆盖为准。

### 4.5 测试

改 `tests/core/compact-project.test.ts`:

- 原「旧 read_note 超保留条数 - 正文变占位」改为用 `grep`(或 `list_files`)造 6 条,断言最早一条 `[compacted] grep`,最近一条仍是全文。
- 新增:6 条 `read_note` 且 `keepRecent=5` — **全部 6 条 tool 正文仍是全文**,无一 `[compacted]`。
- 新增:**回归** 6 条 `get_links` 且 `keepRecent=5` — 全部切片正文保留,无一 `[compacted]`(防止以后有人把图工具塞进 FOLDABLE)。
- 新增:先 6 条 `grep` 再 1 条 `get_links` — 最早 `grep` 可折,`get_links` 正文仍在。
- `Error:` / `remember` 用例可继续用 `read_note` 或不改。
- `projectView` 有标记用例:断言 head 含新文案关键字「没有该篇」,且仍含路径;断言 **不含**「按需 read_note」。

prompt 无强制单测;若已有 Composer 快照测 `agent.rag.workflow` / `toolGuide` 原文,同步改期望。

### 4.6 用户可见文档

- **CHANGELOG `[Unreleased]`**: Fixed — 同一对话里不会因为上下文瘦身而反复「查看」同一篇笔记(场景语言,不写模块名)。不单独吹图工具(无用户可见行为开关)。
- **不改** README / PRD / user-guide。
- **不改** ADR-013 正文(本 spec 遵守其 1 跳 / hub 降权,不升级检索管线)。

---

## 5. 影响面

| 路径 | 变更 |
|---|---|
| `src/core/compact-project.ts` | `FOLDABLE_TOOL_NAMES` 去掉 `read_note`;`projectView` 恢复路径 system 文案 |
| `tests/core/compact-project.test.ts` | 见 4.5 |
| `src/prompts/defaults/zh.ts` | `agent.rag.workflow` + `agent.rag.toolGuide` 图复用/1 跳 |
| `CHANGELOG.md` | `[Unreleased]` Fixed |

长对话里多篇全文 + 多份图切片会更快逼近 85% 自动摘要。这是预期:该走全量摘要时再走,而不是折掉笔记/链接再爬一遍。图切片体积通常远小于 `read_note` JSON,不单独为图做条数上限。

## 6. 参考

- S-COMPACT-V2 design § microcompact / restoredNotePaths
- ADR-013:向量保底、图机会性 1 跳、Daily/hub 不当金边
- [learn-claude-code PR #247](https://github.com/shareAI-lab/learn-claude-code/pull/247)(microcompact 清 `read_file` 导致循环)
- [Claude Code microCompact.ts](https://github.com/claude-code-best/claude-code/blob/632f3e19/src/services/compact/microCompact.ts)(keepRecent + cleared 占位)
- [Cursor Dynamic Context Discovery](https://cursor.com/blog/dynamic-context-discovery)(本 spec 明确不采用落盘)
