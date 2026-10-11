# S-NOTE-MOVE — 移动与复制笔记，并拒绝执行残缺的工具调用

> **ID:** S-NOTE-MOVE
> **状态:** Active
> **日期:** 2026-10-01
> **关联:** [上下文压缩](../../architecture/agent/context-compaction.md)（写入参数不再重发全文之后，搬文件必须走移动）

---

## 1. 背景

库里已经有一篇完整章节。要放进另一个文件夹时，模型没有移动工具，只能 `read_note` 再 `write_note`，把约 4500 字放进工具参数。输出碰到 `max_tokens`，`finish_reason` 为 `length`，参数 JSON 被截断。适配器把残缺 JSON 收成 `{ raw: "..." }`，循环仍执行这次调用。`write_note` 报 `path 必须是非空字符串,收到: undefined`。文件没写成，模型却以为是「内容太长被截断」。

Obsidian 已有对应接口，不必自己搬文件字节。

| 接口 | 行为 |
|---|---|
| `FileManager.renameFile(file, newPath)` | 移动或改名，并按用户的链接设置更新指向旧路径的链接。自 0.11.0。文件列表里拖动笔记走的就是它 |
| `Vault.rename` / `DataAdapter.rename` | 只改路径，不更新链接。官方注释要求改链接时用 `FileManager.renameFile` |
| `Vault.createFolder` | 目标目录不存在时先建。`writeFile` 已这样做 |
| `DataAdapter.copy` | 按字节复制文件或文件夹。自 1.7.2。不改其他笔记里的链接；复制本来就不该改 |

笔记的读写改删已经有了：`read_note`、`write_note`、`append_note`、`edit_note`、`delete_note`。缺移动和复制。没有「复制并改写链接」的官方接口，不自己做。

---

## 2. 目标

1. 模型用一次工具调用把已有笔记或文件夹移到新路径，或复制到新路径。正文不进入模型输出。
2. 移动时的链接更新交给 `FileManager.renameFile`。复制用 `adapter.copy`，其他笔记里的链接仍指向原文件。
3. 工具参数不是完整 JSON 时不执行，并告诉模型这次是输出被截断；文件已在库里应移动或复制，不要把正文再写入 `write_note`。

---

## 3. 非目标

- 不另做「建文件夹」工具。移动或复制到尚不存在的目录时，由该工具自己 `createFolder`。
- 复制不改写其他笔记里的链接，也不改副本内部的链接文本。
- 不改 `write_note` 的覆盖语义，不提高输出 token 上限来容纳整章正文。
- 不在截断后自动把半截参数拼到下一次请求里再执行。

---

## 4. 详细设计

### 4.1 `move_note`

| 项 | 约定 |
|---|---|
| 参数 | `from`、`to`，均为库内相对路径，必填 |
| 对象 | 文件或文件夹 |
| 实现 | 路径校验后取 `TAbstractFile`。`to` 的父目录不存在则 `vault.createFolder`。然后 `app.fileManager.renameFile(file, to)` |
| 目标已存在 | 不覆盖，返回错误 |
| 源不存在 | 返回错误 |
| 权限 | 与 `delete_note` 相同，不是只读 |
| 成功返回 | `{ from, to }` |

面向模型的说明写明：文件已在库里、只是换路径时用本工具，不要 `read_note` 再 `write_note`。说明不走 i18n。用户可见错误走 i18n。

`VaultPort` 增加 `renameFile(from, to)`，适配器里调用 `fileManager.renameFile`。工具不直接碰 Obsidian API。

### 4.2 `copy_note`

| 项 | 约定 |
|---|---|
| 参数 | `from`、`to`，均为库内相对路径，必填 |
| 对象 | 文件或文件夹 |
| 实现 | 路径校验后，父目录不存在则 `createFolder`，然后 `vault.adapter.copy(from, to)` |
| 目标已存在 | 不覆盖，返回错误 |
| 源不存在 | 返回错误 |
| 权限 | 与 `write_note` 相同 |
| 成功返回 | `{ from, to }` |
| 链接 | 其他笔记仍指向原文件。副本里的链接文本与原文件相同 |

面向模型的说明写明：要留下原文件、另存一份时用本工具。换路径并去掉原文件用 `move_note`。

`VaultPort` 增加 `copyFile(from, to)`。

### 4.3 残缺工具调用不执行

适配器在参数 JSON 解析失败时得到 `{ raw: string }`（`llm-openai-compat.ts`）。`agent-loop` 在 `finishReason === 'length'` 时今天仍会执行这些调用。

改为：某个工具调用的参数是 `{ raw }`，或 `finishReason === 'length'` 且该调用的 JSON 没有解析成功时，不调用工具。向模型交回一条工具错误：

`参数因输出长度被截断，未执行。若文件已在库中，换路径用 move_note，另存一份用 copy_note，不要把正文再写入 write_note。`

同一轮里 JSON 已完整的其他调用仍执行。只有残缺的那一次跳过。

`path` 缺失但 JSON 本身完整（模型没填 path）仍走现有的参数校验，不属于本条。

---

## 5. 影响面

| 区域 | 变化 |
|---|---|
| `src/ports/vault.ts`、`src/adapters/obsidian-vault.ts` | `renameFile`、`copyFile` |
| `src/tools/move-note.ts`、`src/tools/copy-note.ts` | 新工具 |
| `src/prompts/tool-schemas.ts`、工具注册处 | 登记 `move_note`、`copy_note` |
| `src/core/agent-loop.ts` | 残缺参数不执行 |
| `src/i18n/zh.ts`、`en.ts`、`types.ts` | 用户可见错误 |
| 测试 | 移动成功且走 `fileManager.renameFile`；复制成功且走 `adapter.copy`；目标已存在不覆盖；父目录会创建；`{ raw }` 不执行且错误文案含 `move_note` 与 `copy_note` |
| CHANGELOG `[Unreleased]` | 一条：已有笔记可以移动或复制，不必把正文再写一遍 |

---

## 6. 参考

- Obsidian `FileManager.renameFile`（`obsidian.d.ts`，since 0.11.0）
- Obsidian `Vault.rename` 的注释：更新链接要用 `FileManager.renameFile`
- Obsidian `DataAdapter.copy`（since 1.7.2）
- 本仓库 `src/adapters/obsidian-vault.ts` 的 `trashFile`（已走 `fileManager`）与 `writeFile`（父目录 `createFolder`）
- 本仓库 `src/adapters/llm-openai-compat.ts` 残缺 JSON 落入 `raw`
- 本仓库 `src/core/agent-loop.ts` 中 `finishReason === 'length'` 仍执行工具调用的分支
