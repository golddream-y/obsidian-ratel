# S-NOTE-AGENTS — 笔记约束 AGENTS.md

> 日期: 2026-09-26
> 状态: Active
> Spec ID: **S-NOTE-AGENTS**
> 关联: [Claude Code memory](https://code.claude.com/docs/en/memory)、[Claude Code large codebases](https://code.claude.com/docs/en/large-codebases)、[AGENTS.md](https://agents.md)、[Codex AGENTS.md](https://developers.openai.com/codex/agent-configuration/agents-md)

---

## 1. 背景

技能是一件事怎么做完，用的时候才读。记忆是关于用户的事实。提示词覆盖改的是插件自己的系统段。库里还没有一份用户自己写的、Ratel 改笔记时必须遵守的约束。

Claude Code 用 `CLAUDE.md`、Codex 用 `AGENTS.md` 做这件事：目录里的 Markdown，代理动手前要遵守，不用点名启用。本 spec 把同一套规则用在笔记库上，文件名用 `AGENTS.md`，和 Claude、Codex 共用。

## 2. 与 Claude / Codex 的对照

官方行为（2026-09 文档）：

- **叠加，不是只留最近一份。** Claude：从工作目录往上的 `CLAUDE.md` 会话开始就加载；子目录的在读到那里的文件时再加载。各层同时进入上下文。冲突时更近的通常优先，远的仍然在。Codex：从根往下拼接，空行隔开，更近的排在后面，因此覆盖前面的说法。
- **一份文件管它下面的整棵子树。** Codex：某份 `AGENTS.md` 的范围是包含它的那个目录及其下所有文件。碰到范围内的文件就必须遵守。
- **用户当轮的明确指令压过文件。** agents.md 与 Codex 都如此。
- **体积。** Claude 建议单文件不超过约 200 行，长参考放进技能，按需再读。
- **Claude 的文件名是 `CLAUDE.md`。** `AGENTS.md` 需要 `@AGENTS.md` 或符号链接成 `CLAUDE.md` 才会被 Claude Code 读。Codex 直接读 `AGENTS.md`。

Ratel 与此对齐，并多一道 Claude 没有的闸：模型要写入某路径、而这一轮还没把该路径的约束给它看过时，这次写入不执行，先把约束退回，让它再写。避免规则还没进上下文，笔记已经改了。

## 3. 目标

1. 库内任意目录可放 `AGENTS.md`。库根那一份每轮对话都带上。子目录的在本轮工具碰到该子树里的笔记时再叠上。
2. 从笔记所在目录走到库根，沿途每一份都拼上。同一件事冲突时，离笔记更近的优先，更远的仍然生效。拼接顺序是根在前、近的在后。
3. 用户这一轮的明确指令压过 `AGENTS.md`。技能仍负责步骤；约束负责笔记必须怎样。
4. Ratel 可以提议修改 `AGENTS.md`，但不能不经确认就写。确认走现有工具确认卡。整理别的笔记时不许顺手改它。
5. 注入有体积上限。近的留全文，超限从最远的开始截断，并说明截断了。

## 4. 非目标

- 不读 `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/`、家目录里的 `AGENTS.md`。只认当前库内的 `AGENTS.md`。
- 不执行 `AGENTS.md` 里写出的命令、测试或脚本。那是 Codex 对代码库的要求。笔记库里的步骤仍走技能。
- 不做 `AGENTS.override.md`（Codex 用来整文件替换父级）。冲突靠「近的优先」，不另做一个替换文件。
- 不把约束做成技能，也不进斜杠菜单。
- 不在会话开始时扫描并注入库内每一份 `AGENTS.md`。
- 不让 `update_app_config` 或技能脚本改这些文件。技能沙箱仍然不能写配置目录；`AGENTS.md` 在库内笔记路径上，走笔记工具，不走沙箱。

## 5. 需求

| ID | 需求 | 验收口径 |
|---|---|---|
| NA-01 | 只认库内 `AGENTS.md` | 同目录的 `CLAUDE.md` 不注入 |
| NA-02 | 库根每轮都在 | 根上有文件时，每轮系统上下文含其正文（未超限时全文） |
| NA-03 | 子目录按需叠加 | 未碰到该子树时，其 `AGENTS.md` 不出现在本轮上下文 |
| NA-04 | 从笔记走到库根 | 改 `A/B/note.md` 时，注入顺序为根、`A`、`A/B` 中存在的文件，近的在后 |
| NA-05 | 近的优先 | 提示中写明：同一件事冲突时，离笔记更近的那份优先；用户当轮明确指令压过全部 |
| NA-06 | 没见过就不能写 | 本轮尚未注入该路径的链时，写入/追加/改写不执行，工具结果改为约束正文，模型据此再调一次 |
| NA-07 | 改约束文件必须确认 | 目标路径最后一段是 `AGENTS.md` 时，`write_note` / `edit_note` / `append_note` / `delete_note` 必须弹确认卡。允许、危险档、本会话不再询问、目标授权都不能跳过。拒绝仍然拒绝 |
| NA-08 | 体积上限 | 单文件注入不超过 8KB（UTF-8）。沿途合计不超过 16KB。超出从最远的文件开始截断，并附一句已截断 |
| NA-09 | 不执行文件里的命令 | 约束正文只作为文字进入上下文，不因此启动宿主命令或技能脚本 |

## 6. 详细设计

### 6.1 发现

路径必须先过 `validateVaultPath`。从目标路径所在目录起（目标本身是 `AGENTS.md` 时，包含它所在的这一层），逐级向库根收集名为 `AGENTS.md` 的文件。库根文件单独缓存，供每轮系统上下文使用。不跟随库外符号链接。文件不存在则跳过该层。

### 6.2 注入

两处：

1. **每轮：** 若库根存在 `AGENTS.md`，放进系统上下文的固定段，位于记忆之后、工具说明之前。超 8KB 则截断并注明。
2. **碰到路径时：** `read_note` 的返回里附上该路径的链（不含已经在系统段里的库根全文，避免重复）。`write_note` / `edit_note` / `append_note` / `delete_note` 在执行前检查：本轮是否已向模型展示过这条链里除库根以外的文件。只有库根、没有更近的文件时，视为已经展示过，直接写。有更近的文件且本轮还没展示过，则不写盘，返回这些更近文件的正文，并说明按此再调用。已经展示过（本轮读过，或本次返回过）则正常执行。

链的正文格式：每层一个小标题，写相对库的目录，然后是该文件正文。顺序根 → 近。末尾固定一句：同一件事冲突时，离笔记更近的优先；用户这一轮的明确指令优先于这些文件。

### 6.3 改 `AGENTS.md`

`write_note`、`edit_note`、`append_note`、`delete_note` 的目标路径最后一段为 `AGENTS.md` 时，在 `resolveToolPermission` 里于拒绝判断之后、其余短路之前强制 `confirm`。允许、危险档、会话授权、目标授权都不跳过。确认文案写明这是在改笔记约束。模型可以先用文字提议；工具侧仍弹确认卡。

### 6.4 与技能、记忆

技能正文和 `AGENTS.md` 同时存在时，都进入上下文，不互相关闭。提示中写明：技能是步骤，`AGENTS.md` 是笔记约束；用户当轮明确指令压过两者。记忆仍是关于用户的事实，不因为有了 `AGENTS.md` 而改变注入规则。

## 7. 影响面

| 区域 | 变化 |
|---|---|
| `src/tools/` 或 `src/core/` | 发现链、体积截断、写入前未注入则退回 |
| `src/core/tool-permissions.ts` | 文件名为 `AGENTS.md` 的写与删强制确认 |
| 笔记工具 `read_note` / `write_note` / `edit_note` / `append_note` / `delete_note` | 读附带链；写前检查链 |
| 系统提示组装 | 库根 `AGENTS.md` 每轮一段 |
| `src/i18n` | 截断说明、退回说明、确认卡文案 zh/en |
| 测试 | 链顺序、未碰到不注入、超限从远截断、未注入不写盘、`AGENTS.md` 强制确认、`CLAUDE.md` 不读 |

## 8. 参考

- [How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Layer CLAUDE.md files by directory](https://code.claude.com/docs/en/large-codebases)
- [Extend Claude Code — CLAUDE.md 叠加与冲突](https://code.claude.com/docs/en/features-overview)
- [AGENTS.md — 嵌套与冲突](https://agents.md)
- [Codex：根到近拼接，近的在后](https://developers.openai.com/codex/agent-configuration/agents-md)
