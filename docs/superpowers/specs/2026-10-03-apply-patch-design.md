# S-APPLY-PATCH — 用补丁局部修改已有笔记，改正文工具的成功返回同一形状

> **ID:** S-APPLY-PATCH
> **状态:** Active
> **日期:** 2026-10-03
> **关联:** [工具系统](../../architecture/agent/tools.md) §4.6–4.8（正文统计）

---

## 1. 背景

已有章节要加一场、改一段时，模型走 `write_note` 把整篇再输出一遍。长章节会在路径之后就把调用收尾，`content` 缺失，工具报「content 必须是字符串」，然后下一次才带上全文。整篇重写也会改到没打算动的段落。

`edit_note` 已能做一次精确替换，但一次只能换一段，而且要把被替换的原文完整放进参数。扩写一章里的几处时，模型仍选整篇覆盖。

Codex 对已有文件只给模型一个 `apply_patch`。补丁用原文里的几行做上下文，用 `+` / `-` 表示增删，一次可以有多处。不把整篇放进参数。

本仓库改正文的三个工具成功时都带 `text`（落盘全文的长度和拉丁词），但旁边的标志不一致：`write_note` / `append_note` 是 `created`，`edit_note` 是 `replaced`。新工具不能再发明第三套。

---

## 2. 目标

1. 模型用一次 `apply_patch` 修改一篇已有笔记的若干处。参数里只有补丁，没有整篇正文。
2. 补丁语法采用 Codex 的 `*** Update File` 子集。对不上原文则整次不落盘。
3. `write_note`、`append_note`、`edit_note`、`apply_patch` 成功时返回同一个形状：`{ path, text }`。`text` 的结构与现在的 `NoteTextStats` 相同。

---

## 3. 非目标

- 不实现 Codex 补丁里的 `*** Add File`、`*** Delete File`、`*** Move to`。新建仍用 `write_note`，删除仍用 `delete_note`，改路径仍用 `move_note`。
- 不提供 shell，不把补丁交给外部进程。
- 不按标题定位，不做模糊匹配，不把 `edit_note` 改成一次多段。
- 一次补丁不改多个文件。
- 不改 `delete_note`、`move_note`、`copy_note` 的返回。它们不改正文统计。
- 不把 `text` 展示到聊天里的工具条。工具条今天会跳过嵌套对象，仍只给模型看这份 JSON。

---

## 4. 详细设计

### 4.1 工具

| 项 | 约定 |
|---|---|
| 名称 | `apply_patch` |
| 参数 | `patch: string`，必填。路径写在补丁里，不另设 `path` |
| 对象 | 一篇已存在的笔记 |
| 权限 | 与 `edit_note` 相同，不是只读 |
| 目录约束 | 与 `edit_note` 相同：执行前按补丁中的路径注入 `AGENTS.md`；路径是 `AGENTS.md` 时仍要确认 |
| 成功返回 | `{ path, text }`，见 §4.4 |
| 失败 | 不写文件。错误是面向模型的中文说明，用户可见字符串走 i18n |

面向模型的说明写在工具 description 里，不走 i18n。说明里给出一份最短补丁样例，并写明：

- 已有笔记的局部修改用本工具。
- 新建，或这一轮大部分正文都要换掉，用 `write_note`。
- `*** Add File` 改用 `write_note`，`*** Delete File` 改用 `delete_note`，`*** Move to` 改用 `move_note`。
- 报告中文字数用 `text.length.han`，拉丁词数用 `text.words.latin`。不要用 `text.length.codePoints` 当字数，不要自己估算。

`write_note` 的说明补上一句：已有笔记只改其中几处时用 `apply_patch`，不要把整篇放进 `content`。

### 4.2 补丁语法

只接受下面这一支。标记行以 `***` 开头，与 Codex `apply-patch` 的文法一致。

```
*** Begin Patch
*** Update File: <vault 相对路径>
@@ 可选的上下文标题
 上下文行
-删除行
+插入行
*** End Patch
```

约定：

- 一次调用里有且仅有一个 `*** Update File`。出现第二个、或出现 Add / Delete / Move，整次拒绝。
- `@@` 开始一处修改。`@@` 同一行后面可以写一段不参与匹配的标记（例如章节名），匹配只看后续以空格、`-`、`+` 开头的行。一处里可以有多行上下文、删除和插入。同一个文件里可以有多处，按补丁中的顺序应用到内存里的全文，全部成功后一次落盘。
- 行首一个空格是上下文，必须与文件中的该行完全一致（含缩进）。`-` 是删除，`+` 是插入。空格、`-`、`+` 之后的文本按原文比较，不 trim。
- 找不到上下文或删除行、上下文能对上多处、或一处里没有任何 `+` / `-`，整次拒绝，磁盘上的文件保持原样。
- 路径必须通过现有的库内路径校验。文件不存在则拒绝，不创建。
- `*** End of File` 若出现，表示该处修改必须落到文件末尾；对不上末尾则拒绝。

解析和套用放在独立模块，工具只负责校验、注入目录约束、读写文件。不引入补丁库。

### 4.3 和 `edit_note` 的分工

`edit_note` 保留：一段 `old_string` 换成 `new_string`，且这段在文件中只出现一次。

模型说明里，局部修改优先 `apply_patch`。`edit_note` 不删除，避免已经会用它的调用突然失效。

### 4.4 返回形状

`write_note`、`append_note`、`edit_note`、`apply_patch` 成功时都返回：

```json
{
  "path": "笔记的库内相对路径",
  "text": {
    "length": {
      "chars": 0,
      "codePoints": 0,
      "han": 0,
      "latinLetters": 0,
      "other": 0
    },
    "words": { "latin": 0 }
  }
}
```

`text` 由落盘后重新读出的全文计算，文首属性算在内。字段含义与现在的 `NoteTextStats` 相同：

- `length.chars`：UTF-16 长度。
- `length.codePoints`：码点个数。不要当字数。
- `length.han`：`Script=Han` 的码点个数。报告中文字数用这个。
- `length.latinLetters`：拉丁字母码点个数。
- `length.other`：其余码点。
- `words.latin`：连续拉丁字母的段数。撇号会断开。汉语拼音记在这里。

`han + latinLetters + other = codePoints`。`words.latin` 不参加这个等式。

不再返回 `created` 或 `replaced`。四个工具的成功 JSON 只有 `path` 和 `text` 两个键。

四个工具的 description 用同一句说明这两个报数字段，避免一个工具讲统计、另一个不讲。

---

## 5. 影响面

| 区域 | 变化 |
|---|---|
| 新模块 | 解析 `*** Update File` 补丁并套到字符串上；失败不产生新正文 |
| `src/tools/apply-patch.ts` | 新工具 |
| `src/tools/write-note.ts`、`append-note.ts`、`edit-note.ts` | 成功返回去掉 `created` / `replaced`，只留 `path` 和 `text` |
| `src/prompts/tool-schemas.ts`、`defaults/zh.ts`、`sections.ts` | 登记 `apply_patch`；四个改正文工具的说明对齐 |
| 权限、工具展示名、`AGENTS.md` 注入 | 与 `edit_note` 同一路径 |
| `src/i18n/zh.ts`、`en.ts`、`types.ts` | 解析失败、多文件、禁止的补丁操作、对不上原文、文件不存在 |
| 测试 | 多处增删一次落盘；对不上则文件不变；Add/Delete/Move 被拒绝并指向现有工具；四个工具的成功 JSON 键集合都是 `path`、`text` |
| `docs/architecture/agent/tools.md` | 补上 `apply_patch`，并把三个旧工具的返回改成 `{ path, text }` |
| CHANGELOG `[Unreleased]` | 一条：已有笔记可以按补丁改几处，不必整篇重写 |

---

## 6. 参考

- OpenAI Codex `apply-patch` 文法：`*** Begin Patch` / `*** Update File` / `*** End Patch`（仓库 `codex-rs` 中的 apply-patch 文法；本 spec 只取 Update File）
- 本仓库 `src/tools/note-text-stats.ts` 的 `NoteTextStats`
- 本仓库 `src/tools/edit-note.ts` 的唯一匹配与「失败则不写」
- 本仓库 `docs/architecture/agent/tools.md` §4.6–4.8
