# 补丁局部修改笔记 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 已有笔记用一次 `apply_patch`（只接受 `*** Update File`）改几处；对不上则不落盘。`write_note`、`append_note`、`edit_note`、`apply_patch` 成功都只返回 `{ path, text }`。

**Architecture:** `src/tools/apply-patch-text.ts` 只做字符串解析和套用，不碰 Vault。工具层校验路径、注入 `AGENTS.md`、用 `processFile` 落盘，失败时回调里抛错所以不写。`extractToolPath` 从补丁里取出唯一的 Update File 路径，现有 pre-tool-use 路径校验和 `AGENTS.md` 确认不用新开通道。

**Tech Stack:** TypeScript、vitest、现有 `VaultPort.processFile`、`measureNoteText`、i18n。不引入补丁库。

**所属 spec：** [S-APPLY-PATCH](../specs/2026-10-03-apply-patch-design.md)

## Global Constraints

- 只接受一个 `*** Update File`。`*** Add File` 指向 `write_note`，`*** Delete File` 指向 `delete_note`，`*** Move to` 指向 `move_note`。
- 上下文行和删除行必须与文件该行完全一致，不 trim，不做模糊匹配。对不上、对上多处、或一处没有任何 `+` / `-`，整次不落盘。
- `@@` 同一行后面的文字不参与匹配。`*** End of File` 要求该处匹配落在文件末尾。
- 参数只有 `patch`。文件不存在不创建。一次不改多个文件。
- 成功 JSON 只有 `path` 和 `text`。`text` 用 `measureNoteText` 对落盘后的全文计算。去掉 `created` 和 `replaced`。
- 用户可见错误走 i18n。工具 description 不走 i18n。注释和测试描述用中文。测试名：`行为 - 条件 - 期望结果`。
- 不改 `delete_note`、`move_note`、`copy_note` 的返回。不把 `text` 画进工具条。不压缩 `patch` 参数。

## 文件

| 文件 | 职责 |
|---|---|
| `src/tools/apply-patch-text.ts` | 解析补丁、在字符串上套用 |
| `src/tools/apply-patch.ts` | 工具：校验、注入、落盘、返回 `{ path, text }` |
| `src/core/tool-permissions.ts` | 从补丁取路径；`AGENTS.md` 确认 |
| `src/tools/write-note.ts`、`append-note.ts`、`edit-note.ts` | 成功返回只留 `path`、`text` |
| schema、sections、i18n、`main.ts`、权限默认值、展示名、架构文档、CHANGELOG | 接线 |

四个工具 description 末尾用同一句：`报告中文字数用 text.length.han，拉丁词数用 text.words.latin。不要用 text.length.codePoints 当字数，不要自己估算。`

---

### Task 1: 补丁解析与套用

**Files:**
- Create: `src/tools/apply-patch-text.ts`
- Test: `tests/tools/apply-patch-text.test.ts`

**Interfaces:**
- Produces:
  - `export type PatchOp = { kind: 'context' | 'delete' | 'insert'; text: string }`
  - `export type PatchHunk = { ops: PatchOp[]; eof: boolean }`
  - `export type PatchReason = 'parse' | 'multi' | 'add' | 'delete' | 'move' | 'empty' | 'mismatch' | 'ambiguous' | 'eof'`
  - `export function peekUpdateFilePath(patch: string): string | undefined`
  - `export function parseUpdatePatch(patch: string): { ok: true; path: string; hunks: PatchHunk[] } | { ok: false; reason: PatchReason }`
  - `export function applyUpdateHunks(content: string, hunks: PatchHunk[]): { ok: true; content: string } | { ok: false; reason: PatchReason }`

- [x] **Step 1: 写失败测试**

`tests/tools/apply-patch-text.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { applyUpdateHunks, parseUpdatePatch, peekUpdateFilePath } from '../../src/tools/apply-patch-text';

const FILE = '甲\n乙\n丙\n丁\n';

function patch(body: string): string {
	return `*** Begin Patch\n*** Update File: 章/第004章.md\n${body}\n*** End Patch\n`;
}

describe('apply-patch-text', () => {
	it('peekUpdateFilePath - 恰好一个 Update File - 返回路径', () => {
		expect(peekUpdateFilePath(patch('@@\n 乙\n-丙\n+丙二'))).toBe('章/第004章.md');
	});

	it('parseUpdatePatch - 两处增删 - 解析出两个 hunk', () => {
		const parsed = parseUpdatePatch(patch('@@ 标题不参与匹配\n 甲\n-乙\n+乙二\n@@\n 丁\n+戊'));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.hunks).toHaveLength(2);
		expect(parsed.hunks[0]!.ops.map((op) => op.kind)).toEqual(['context', 'delete', 'insert']);
	});

	it('applyUpdateHunks - 两处按顺序套用 - 得到新全文', () => {
		const parsed = parseUpdatePatch(patch('@@\n 甲\n-乙\n+乙二\n@@\n 丁\n+戊'));
		if (!parsed.ok) throw new Error('parse');
		const applied = applyUpdateHunks(FILE, parsed.hunks);
		expect(applied).toEqual({ ok: true, content: '甲\n乙二\n丙\n丁\n戊\n' });
	});

	it('applyUpdateHunks - 上下文对不上 - mismatch 且不返回新正文', () => {
		const parsed = parseUpdatePatch(patch('@@\n 不存在\n-乙\n+乙二'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks(FILE, parsed.hunks)).toEqual({ ok: false, reason: 'mismatch' });
	});

	it('applyUpdateHunks - 上下文出现两次 - ambiguous', () => {
		const parsed = parseUpdatePatch(patch('@@\n 甲\n+插'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks('甲\n乙\n甲\n', parsed.hunks).ok).toBe(false);
		const again = applyUpdateHunks('甲\n乙\n甲\n', parsed.hunks);
		expect(again).toEqual({ ok: false, reason: 'ambiguous' });
	});

	it('parseUpdatePatch - 只有上下文没有增删 - empty', () => {
		expect(parseUpdatePatch(patch('@@\n 甲')).ok).toBe(false);
		const parsed = parseUpdatePatch(patch('@@\n 甲'));
		expect(parsed).toEqual({ ok: false, reason: 'empty' });
	});

	it('parseUpdatePatch - Add File - add', () => {
		const text = '*** Begin Patch\n*** Add File: a.md\n+hello\n*** End Patch\n';
		expect(parseUpdatePatch(text)).toEqual({ ok: false, reason: 'add' });
	});

	it('parseUpdatePatch - Delete File - delete', () => {
		const text = '*** Begin Patch\n*** Delete File: a.md\n*** End Patch\n';
		expect(parseUpdatePatch(text)).toEqual({ ok: false, reason: 'delete' });
	});

	it('parseUpdatePatch - Move to - move', () => {
		const text = '*** Begin Patch\n*** Update File: a.md\n*** Move to: b.md\n@@\n 甲\n+乙\n*** End Patch\n';
		expect(parseUpdatePatch(text)).toEqual({ ok: false, reason: 'move' });
	});

	it('parseUpdatePatch - 两个 Update File - multi', () => {
		const text = '*** Begin Patch\n*** Update File: a.md\n@@\n 甲\n+乙\n*** Update File: b.md\n@@\n 甲\n+乙\n*** End Patch\n';
		expect(parseUpdatePatch(text)).toEqual({ ok: false, reason: 'multi' });
	});

	it('applyUpdateHunks - End of File 不在末尾 - eof', () => {
		const parsed = parseUpdatePatch(patch('@@\n 甲\n+插\n*** End of File'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks(FILE, parsed.hunks)).toEqual({ ok: false, reason: 'eof' });
	});

	it('applyUpdateHunks - End of File 在末尾 - 插入成功', () => {
		const parsed = parseUpdatePatch(patch('@@\n 丁\n+戊\n*** End of File'));
		if (!parsed.ok) throw new Error('parse');
		expect(applyUpdateHunks(FILE, parsed.hunks)).toEqual({ ok: true, content: '甲\n乙\n丙\n丁\n戊\n' });
	});

	it('parseUpdatePatch - 缺少 End Patch - parse', () => {
		expect(parseUpdatePatch('*** Begin Patch\n*** Update File: a.md\n@@\n 甲\n+乙\n')).toEqual({
			ok: false,
			reason: 'parse',
		});
	});
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/apply-patch-text.test.ts`

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现解析与套用**

`src/tools/apply-patch-text.ts` 按上面的类型导出。规则：

- 先把补丁里的 `\r\n` 换成 `\n`。按 `\n` 切行。
- 第一行非空必须是 `*** Begin Patch`（整行 trim 后相等）。最后必须遇到 trim 后等于 `*** End Patch` 的行。其后只允许空行。
- trim 后以 `*** Add File` 开头 → `add`。`*** Delete File` → `delete`。`*** Move to` → `move`。这些优先于「第二个 Update File」。
- trim 后以 `*** Update File:` 开头：路径是冒号后的 trim。空路径 → `parse`。第二个 → `multi`。
- `@@` 开头的行开始一个 hunk，该行其余文字丢弃。hunk 内行：首字符空格是 context，`-` 是 delete，`+` 是 insert，前缀之后的文本原样保留。`*** End of File` 把当前 hunk 的 `eof` 设为 true。其他行 → `parse`。
- 没有 Update File、没有 hunk、hunk 出现在 Update File 之前、或 End Patch 之前还有未结束的非法状态 → `parse`。
- 每个 hunk 若没有任何 insert 或 delete → `empty`。`empty` 在 parse 阶段就返回，不进入套用。
- `peekUpdateFilePath`：补丁里恰好一条非空 Update File 路径时返回它，否则 `undefined`。不要求其余语法合法。
- 套用：文件按 `\n` 切。若原文以 `\n` 结尾，去掉切分产生的最后一个空元素，并在结果末尾加回 `\n`。空字符串的行列表是 `[]`。
- 每个 hunk 的匹配行是 context 和 delete，按顺序。在当前行列表里找唯一起点。0 处 → `mismatch`，多于 1 处 → `ambiguous`。`eof` 时起点加匹配长度必须等于行数，否则 `eof`。
- 重放：先拷贝起点之前的行；遇到 insert 就追加；遇到 context 就追加原行并前进；遇到 delete 只前进。然后接上匹配段之后的行。后一个 hunk 用前一个的结果。任一 hunk 失败则整次失败。

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/apply-patch-text.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/tools/apply-patch-text.ts tests/tools/apply-patch-text.test.ts
git commit -m "$(cat <<'EOF'
feat: 解析并套用 Update File 补丁

EOF
)"
```

---

### Task 2: apply_patch 工具与接线

**Files:**
- Create: `src/tools/apply-patch.ts`
- Modify: `src/main.ts`（import 与 `createEditNoteTool` 旁边 register）
- Modify: `src/prompts/tool-schemas.ts`（`edit_note` 后加骨架；`ALL_TOOL_NAMES` 在 `edit_note` 后加 `'apply_patch'`）
- Modify: `src/prompts/defaults/zh.ts`
- Modify: `src/prompts/sections.ts`（`edit_note` 参数段落后加 description 与 `param.patch`）
- Modify: `src/i18n/types.ts`、`zh.ts`、`en.ts`
- Modify: `src/core/tool-permissions.ts`
- Modify: `src/settings.ts`（`toolPermissions.edit_note` 后加 `apply_patch: 'allow'`）
- Modify: `src/ui/settings/tool-permissions-setting-page.ts`（label 与 `allTools`）
- Modify: `src/ui/chat/format-tool-display.ts`
- Test: `tests/tools/apply-patch.test.ts`
- Test: `tests/core/tool-permissions.test.ts`（补一条 AGENTS.md）

**Interfaces:**
- Consumes: Task 1 的 `parseUpdatePatch`、`applyUpdateHunks`、`peekUpdateFilePath`
- Produces: `export function createApplyPatchTool(vault, definition, getAgents?): Tool`，成功返回 `{ path: string; text: NoteTextStats }`

- [x] **Step 1: 写失败测试**

`tests/tools/apply-patch.test.ts` 用 `createMockVaultPort` 与 `makeToolDef('apply_patch')`。

```typescript
import { describe, it, expect } from 'vitest';
import { createApplyPatchTool } from '../../src/tools/apply-patch';
import { createMockVaultPort } from '../helpers/mock-vault-port';
import { makeToolDef } from '../helpers/make-tool-def';

function patch(fileBody: string): string {
	return `*** Begin Patch\n*** Update File: 章/第004章.md\n${fileBody}\n*** End Patch\n`;
}

describe('apply_patch', () => {
	it('两处修改 - 一次落盘且只返回 path 和 text', async () => {
		const vault = createMockVaultPort({ files: { '章/第004章.md': '甲\n乙\n丙\n丁\n' } });
		const tool = createApplyPatchTool(vault, makeToolDef('apply_patch'));
		const res = await tool.execute({
			patch: patch('@@\n 甲\n-乙\n+乙二\n@@\n 丁\n+戊'),
		}) as { path: string; text: { length: { han: number } } };
		expect(Object.keys(res).sort()).toEqual(['path', 'text']);
		expect(res.path).toBe('章/第004章.md');
		expect(res.text.length.han).toBe(6);
		expect(await vault.readFile('章/第004章.md')).toBe('甲\n乙二\n丙\n丁\n戊\n');
	});

	it('对不上 - 文件保持原样', async () => {
		const vault = createMockVaultPort({ files: { '章/第004章.md': '甲\n乙\n' } });
		const tool = createApplyPatchTool(vault, makeToolDef('apply_patch'));
		await expect(tool.execute({ patch: patch('@@\n 不存在\n-乙\n+乙二') })).rejects.toThrow('对不上');
		expect(await vault.readFile('章/第004章.md')).toBe('甲\n乙\n');
	});

	it('Add File - 拒绝并指向 write_note', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createApplyPatchTool(vault, makeToolDef('apply_patch'));
		await expect(tool.execute({
			patch: '*** Begin Patch\n*** Add File: a.md\n+hi\n*** End Patch\n',
		})).rejects.toThrow('write_note');
	});

	it('文件不存在 - 不创建', async () => {
		const vault = createMockVaultPort({ files: {} });
		const tool = createApplyPatchTool(vault, makeToolDef('apply_patch'));
		await expect(tool.execute({ patch: patch('@@\n 甲\n+乙') })).rejects.toThrow('文件不存在');
		expect(await vault.fileExists('章/第004章.md')).toBe(false);
	});
});
```


权限测试追加：

```typescript
it('mustConfirmAgentsMd - apply_patch 的 Update File 指向 AGENTS.md - 要确认', () => {
	expect(mustConfirmAgentsMd({
		id: '1',
		name: 'apply_patch',
		args: { patch: '*** Begin Patch\n*** Update File: Work/AGENTS.md\n@@\n 甲\n+乙\n*** End Patch\n' },
	})).toBe(true);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/apply-patch.test.ts`

Expected: FAIL，`makeToolDef('apply_patch')` 抛 `Unknown tool schema`。

- [x] **Step 3: 实现工具并接线**

`createApplyPatchTool`：

1. `patch` 不是字符串则 `throw new Error(tNow('error.tool.invalidArg', { label: 'patch', type: typeof args.patch }))`。
2. `parseUpdatePatch`。失败则 `throw new Error(tNow(reasonKey))`。
3. `validateVaultPath(parsed.path)`。
4. `injectAgentsForPaths(getAgents?.(), [path])`。
5. `fileExists` 为 false 则 `tNow('error.tool.fileNotFound', { path })`。
6. `processFile`：回调里 `applyUpdateHunks`，失败则 throw，成功返回新全文。
7. `measureNoteText(await vault.readFile(path))`，返回 `{ path, text }`。

i18n 中文：

| key | zh |
|---|---|
| `error.tool.patchParse` | 补丁格式无法解析 |
| `error.tool.patchMulti` | 一次补丁只能修改一个文件 |
| `error.tool.patchAdd` | *** Add File 不能用。新建笔记用 write_note |
| `error.tool.patchDelete` | *** Delete File 不能用。删除用 delete_note |
| `error.tool.patchMove` | *** Move to 不能用。改路径用 move_note |
| `error.tool.patchEmpty` | 这一处没有要增删的行 |
| `error.tool.patchMismatch` | 上下文或要删除的行在文件里对不上，未改文件 |
| `error.tool.patchAmbiguous` | 上下文在文件里出现了多次，未改文件 |
| `error.tool.patchEof` | 这一处没有落在文件末尾，未改文件 |
| `tool.name.apply_patch` | 补丁 {path} |
| `settings.toolPermissions.apply_patch` | 按补丁修改笔记 |
| `toolPerm.applyPatch` | 按补丁修改 {path} |
| `promptLabel.tool.apply_patch.description` | apply_patch 描述 |
| `promptLabel.tool.apply_patch.description.desc` | 局部修改已有笔记 |
| `promptLabel.tool.apply_patch.param.patch` | apply_patch.patch |
| `promptLabel.tool.apply_patch.param.patch.desc` | Update File 补丁 |

en 用对应英文短句，禁止操作的错误里保留 `write_note`、`delete_note`、`move_note`。`types.ts` 同步这些 key。

`tool.apply_patch.description`：

```
局部修改一篇已有笔记。参数 patch 是补丁，不要把整篇正文放进来。一次只能有一个 *** Update File。@@ 后面用空格行表示必须逐字匹配的上下文，- 删除，+ 插入，可以有多处。新建或大部分正文都要换掉时用 write_note。*** Add File 改用 write_note，*** Delete File 改用 delete_note，*** Move to 改用 move_note。成功时返回 text。报告中文字数用 text.length.han，拉丁词数用 text.words.latin。不要用 text.length.codePoints 当字数，不要自己估算。
```

`tool.apply_patch.param.patch`：`以 *** Begin Patch 开头、*** End Patch 结尾的补丁文本。`

`tool.write_note.description` 第一句后加：`已有笔记只改其中几处时用 apply_patch，不要把整篇放进 content。`

schema：

```typescript
apply_patch: {
	name: 'apply_patch',
	parameters: {
		type: 'object',
		properties: { patch: { type: 'string' } },
		required: ['patch'],
	},
},
```

`extractToolPath`：`name === 'apply_patch'` 且 `args.patch` 为字符串时返回 `peekUpdateFilePath`。`AGENTS_MD_NOTE_TOOLS` 加入 `apply_patch`。`summarizeToolCall` 增加 `apply_patch` 分支，有路径用 `toolPerm.applyPatch`，否则用设置项名字。

`formatToolDisplayName` 的 path 类分支加入 `apply_patch`。路径用 `peekUpdateFilePath(typeof obj.patch === 'string' ? obj.patch : '')`。没有路径时退回工具原名。

`main.ts` 在 `createEditNoteTool` 注册之后注册 `createApplyPatchTool`。

默认权限 `apply_patch: 'allow'`。缺 key 的旧库已由 `DEFAULT_SETTINGS.toolPermissions` 先行合并，不必提高 `toolPermissionDefaultsVersion`。

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/apply-patch.test.ts tests/core/tool-permissions.test.ts tests/prompts/composer.test.ts`

Expected: PASS。composer 能组出 `apply_patch`，description 含 `text.length.han`。

- [x] **Step 5: Commit**

```bash
git add src/tools/apply-patch.ts src/main.ts src/prompts/tool-schemas.ts src/prompts/defaults/zh.ts src/prompts/sections.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts src/core/tool-permissions.ts src/settings.ts src/ui/settings/tool-permissions-setting-page.ts src/ui/chat/format-tool-display.ts tests/tools/apply-patch.test.ts tests/core/tool-permissions.test.ts
git commit -m "$(cat <<'EOF'
feat: 用 apply_patch 局部修改已有笔记

EOF
)"
```

---

### Task 3: 改正文工具的返回收成同一形状

**Files:**
- Modify: `src/tools/write-note.ts`、`append-note.ts`、`edit-note.ts`（返回值去掉 `created` / `replaced`）
- Modify: `tests/tools/write-append-delete.test.ts`、`tests/tools/edit-note.test.ts`
- Modify: `docs/architecture/agent/tools.md` §4.6–4.8，并在 §4.8 后增加 §4.8a `apply_patch`
- Modify: `CHANGELOG.md` `[Unreleased]`「笔记」

**Interfaces:**
- Consumes: 现有 `measureNoteText`
- Produces: 三个工具的成功对象键集合与 `apply_patch` 相同，只有 `path` 和 `text`

- [x] **Step 1: 改测试使旧断言失败**

`write-append-delete.test.ts` 去掉 `created`。成功用例改为：

```typescript
expect(Object.keys(res).sort()).toEqual(['path', 'text']);
expect(res.text.length.han).toBe(0);
```

`edit-note.test.ts` 去掉 `replaced`，同样断言键集合是 `path` 和 `text`，并保留现有的 `chars` / `words.latin` 断言。

- [x] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/write-append-delete.test.ts tests/tools/edit-note.test.ts`

Expected: FAIL，结果里仍有 `created` 或 `replaced`。

- [x] **Step 3: 改返回并写文档**

三个 `return` 改为 `return { path, text }`。

`docs/architecture/agent/tools.md`：§4.6、§4.7 的返回改成 `{ path, text }`。§4.8 的返回改成 `{ path, text }`，删掉 `replaced`。统计表的主语从「三个工具」改成「四个改正文工具」。新增：

```markdown
### 4.8a apply_patch

| 属性 | 值 |
|---|---|
| name | `apply_patch` |
| description | 用 `*** Update File` 补丁局部修改一篇已有笔记 |
| readOnly | false |
| 参数 | `patch: string` |
| 返回 | `{ path, text }` |

一次只有一个 Update File。Add File、Delete File、Move to 拒绝并指向 `write_note`、`delete_note`、`move_note`。上下文对不上则不落盘。
```

CHANGELOG `[Unreleased]`「笔记」加一条：

```markdown
- **Added：内置工具 apply_patch** — 已有笔记可以按补丁改几处，不必整篇重写。写入、追加、替换和补丁成功时都只返回路径和字数。
```

- [x] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/write-append-delete.test.ts tests/tools/edit-note.test.ts tests/tools/apply-patch.test.ts tests/tools/apply-patch-text.test.ts tests/core/tool-permissions.test.ts`

Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/tools/write-note.ts src/tools/append-note.ts src/tools/edit-note.ts tests/tools/write-append-delete.test.ts tests/tools/edit-note.test.ts docs/architecture/agent/tools.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
fix: 改正文工具成功时统一返回路径和字数

EOF
)"
```

---

## 自审

| spec | 任务 |
|---|---|
| 4.1 工具名、只收 `patch`、权限同 edit、AGENTS.md、成功 `{ path, text }` | Task 2 |
| 4.1 说明：局部修改、整篇用 write、三种禁止操作、字数字段 | Task 2 description |
| 4.1 write 说明补 apply_patch | Task 2 |
| 4.2 语法、一文件、精确匹配、多处顺序套用、失败不落盘、End of File | Task 1–2 |
| 4.3 edit_note 保留且不改成多段 | 不改 `edit_note` 的参数；Task 3 只改返回 |
| 4.4 四个工具只有 `path` 和 `text` | Task 2–3 |
| 非目标：不实现 Add/Delete/Move、不模糊、不改删除/移动/复制的返回、工具条不展示 text | Task 1 拒绝；Task 3 不碰那三个工具和展示嵌套对象 |
| 影响面架构文档与 CHANGELOG | Task 3 |
