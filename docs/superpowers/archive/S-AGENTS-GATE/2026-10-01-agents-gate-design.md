# S-AGENTS-GATE — 约束闸门拦住时不得显示为写入成功

> **ID:** S-AGENTS-GATE
> **状态:** Active
> **日期:** 2026-10-01
> **关联:** 笔记目录 `AGENTS.md` 闸门（`src/tools/note-agents.ts`）

---

## 1. 背景

第一次往某个目录写入、追加、替换、删除、移动或复制时，插件先把该目录到库根的 `AGENTS.md` 交回，并且不改文件。末尾才有一句「请立刻用相同参数再次调用刚才的工具，这次会真正执行」。

这次调用不抛错。`write_note` 等把这段正文原样 `return`。界面按普通成功结果打勾。模型读到的是三千多字的约束，于是对用户说已经落盘。

这场写长篇的会话里，这种「拦住且不改文件」的返回有 14 次，没有一次以 `Error:` 开头。另外 18 次是读笔记时附带了同一段约束，正文仍在结果里，那些读取是真的。

闸门本身要留：未见过该目录约束时，第一次不写盘。有问题的是返回形态。

---

## 2. 目标

1. 闸门拦住时，模型和界面都能看出这次没有改文件。
2. 第一句就写明要再用相同参数调用一次才会执行。约束正文留在这句后面。
3. 第二次用相同参数调用时，行为与现在相同，真正执行。

---

## 3. 非目标

- 不取消闸门，不改成第一次就写盘。
- 不改 `read_note`。读的时候约束附在 `agentsConstraints` 里，正文仍在 `content`。
- 不改「同一轮里相同参数再调一次才执行」的规则。
- 不改 `AGENTS.md` 的查找顺序和截断长度。

---

## 4. 详细设计

`applyNoteAgentsGate` 在 `proceed === false` 时，返回文本改为：

```text
Error: 未改动文件。请立刻用相同参数再次调用刚才的工具，这次才会执行。

以下是该路径上的 AGENTS.md，读完再调用：
<现有约束正文>
```

- 以 `Error:` 开头。现有界面把这样的工具结果标成失败，不再打成功勾。模型也按失败处理，不会说已经落盘。
- `GATE_RETRY_NOTE` 放在第一句，不再放在全文末尾。
- 约束正文仍附在后面，避免模型不看规则就重试。
- `write_note`、`append_note`、`edit_note`、`delete_note`、`move_note`、`copy_note` 继续在 `proceed === false` 时直接返回这段文本，不写盘、不移动、不复制。

`proceed === true` 的路径不变，包括读笔记，以及本轮已经见过该目录约束之后的写。

---

## 5. 影响面

| 区域 | 变化 |
|---|---|
| `src/tools/note-agents.ts` | 拦住时的返回文本 |
| 写、删、移动、复制工具 | 不改调用方式，只是拿到的附件以 `Error:` 开头 |
| 测试 | 拦住时文本以 `Error:` 开头且含「未改动文件」；再次调用才执行 |
| CHANGELOG `[Unreleased]` | 一条：第一次改某个目录时会标明没写上，不会显示成成功 |

---

## 6. 参考

- `src/tools/note-agents.ts` 的 `applyNoteAgentsGate`、`GATE_RETRY_NOTE`
- `src/tools/write-note.ts`：`proceed === false` 时 `return gate.attachment`
- `src/ui/chat/message-stream/hydrate-session-messages.ts`：工具结果以 `Error:` 开头则标为失败
