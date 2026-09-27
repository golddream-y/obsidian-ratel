# S-NOTE-AGENTS 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 库内 `AGENTS.md` 按目录叠加成笔记约束：库根每轮在，子目录碰到再叠，没看过不能写，改约束文件必须确认。

**Architecture:** 纯函数负责链的目录顺序、截断和拼接。权限函数在现有短路之前强制确认。笔记工具和系统提示只调用这两处，不复制规则。

**Tech Stack:** TypeScript strict、vitest、Obsidian 插件。

**Spec:** [2026-09-26-note-agents-md-design.md](2026-09-26-note-agents-md-design.md)

## Global Constraints

- 只认文件名恰好为 `AGENTS.md`。不读 `CLAUDE.md`。
- 单文件注入最多 8192 字节（UTF-8）。沿途合计最多 16384 字节。超出从最远的一层开始截断。
- 拼接顺序：库根在前，离笔记近的在后。
- 改 `AGENTS.md` 的写与删：拒绝仍拒绝；允许、危险档、会话不再询问、目标授权都不跳过确认。
- 新用户可见字符串走 `src/i18n/zh.ts`、`en.ts`、`types.ts`，代码里 `tNow`。
- 注释中文。`it` 描述中文，格式「行为 - 条件 - 期望」。
- 测试路径用 `Work/Diary/note.md` 这类相对路径，不写本机绝对路径。
- 不执行约束正文里的命令。
- TDD：先失败测试，再实现，再提交。

## 并行

Task 1 与 Task 2 不改同一批文件，可同时做。Task 3 等两者都进同一分支后再做。

---

### Task 1: 链的纯逻辑

**Files:**
- Create: `src/tools/note-agents.ts`
- Test: `tests/tools/note-agents.test.ts`

**Interfaces:**
- Produces:
  - `AGENTS_FILE_NAME = 'AGENTS.md'`
  - `AGENTS_FILE_MAX_BYTES = 8192`
  - `AGENTS_CHAIN_MAX_BYTES = 16384`
  - `agentsChainDirs(notePath: string): string[]` — 从库根到笔记所在目录，含库根本身 `''` 表示根。`Work/Diary/note.md` → `['', 'Work', 'Work/Diary']`。`Work/AGENTS.md` → `['', 'Work']`。
  - `truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean }`
  - `joinAgentsChain(layers: { dir: string; text: string }[]): { text: string; truncated: boolean }` — 先按单文件截断，再按合计从最远（数组前面）截成空并记 truncated。正文含固定优先句。
  - `nestedDirs(notePath: string): string[]` — `agentsChainDirs` 去掉库根 `''`。
  - `export class AgentsChainSeen` — `has(notePath)`, `mark(notePath)`，按 `nestedDirs` 排序后的 key。空 nested 视为已见。

- [ ] **Step 1: 写失败测试**

`tests/tools/note-agents.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import {
	agentsChainDirs,
	joinAgentsChain,
	nestedDirs,
	AgentsChainSeen,
	truncateUtf8,
} from '../../src/tools/note-agents';

describe('agentsChainDirs', () => {
	it('agentsChainDirs - 嵌套笔记 - 根在前近的在后', () => {
		expect(agentsChainDirs('Work/Diary/note.md')).toEqual(['', 'Work', 'Work/Diary']);
	});
	it('agentsChainDirs - 目标就是 AGENTS.md - 包含其所在目录', () => {
		expect(agentsChainDirs('Work/AGENTS.md')).toEqual(['', 'Work']);
	});
	it('agentsChainDirs - 库根笔记 - 只有根', () => {
		expect(agentsChainDirs('note.md')).toEqual(['']);
	});
});

describe('joinAgentsChain', () => {
	it('joinAgentsChain - 两层 - 根在前且含优先句', () => {
		const joined = joinAgentsChain([
			{ dir: '', text: '根规则' },
			{ dir: 'Work', text: '工作规则' },
		]);
		expect(joined.truncated).toBe(false);
		expect(joined.text.indexOf('根规则')).toBeLessThan(joined.text.indexOf('工作规则'));
		expect(joined.text).toContain('离笔记更近的优先');
	});
	it('joinAgentsChain - 合计超限 - 从最远截断', () => {
		const far = '远'.repeat(6000);
		const near = '近'.repeat(100);
		const joined = joinAgentsChain([
			{ dir: '', text: far },
			{ dir: 'Work', text: near },
		]);
		expect(joined.truncated).toBe(true);
		expect(joined.text).toContain('近');
		expect(joined.text).toContain('已截断');
	});
});

describe('truncateUtf8', () => {
	it('truncateUtf8 - 未超限 - 不截断', () => {
		expect(truncateUtf8('你好', 80)).toEqual({ text: '你好', truncated: false });
	});
});

describe('AgentsChainSeen', () => {
	it('AgentsChainSeen - 只有库根 - 视为已见', () => {
		const seen = new AgentsChainSeen();
		expect(seen.has('note.md')).toBe(true);
	});
	it('AgentsChainSeen - 有更近目录且未 mark - 未见', () => {
		const seen = new AgentsChainSeen();
		expect(seen.has('Work/note.md')).toBe(false);
		expect(nestedDirs('Work/note.md')).toEqual(['Work']);
	});
	it('AgentsChainSeen - mark 之后 - 已见', () => {
		const seen = new AgentsChainSeen();
		seen.mark('Work/note.md');
		expect(seen.has('Work/note.md')).toBe(true);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/note-agents.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

新建 `src/tools/note-agents.ts`，导出上面的常量与函数。`agentsChainDirs` 用 `/` 切分，去掉空段和 `.`，文件名是 `AGENTS.md` 时不把它当成下一级目录。`joinAgentsChain` 对每层 `truncateUtf8(..., 8192)`，再从下标 0 起丢层直到 UTF-8 合计 ≤ 16384，丢过则 `truncated`。固定句用中文常量写在函数内（这是给模型的提示，不是界面文案）：`同一件事冲突时，离笔记更近的优先。用户这一轮的明确指令优先于这些文件。` 截断说明同样写进这段正文：`较远的约束已截断。`

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/tools/note-agents.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/note-agents.ts tests/tools/note-agents.test.ts
git commit -m "feat: 笔记约束链的目录顺序、截断与本轮已见记录"
```

---

### Task 2: 改 AGENTS.md 强制确认

**Files:**
- Modify: `src/core/tool-permissions.ts`
- Test: `tests/core/tool-permissions.test.ts`

**Interfaces:**
- Produces: `mustConfirmAgentsMd(toolCall: ToolCall): boolean`
- Consumes: 现有 `resolveToolPermission`、`extractToolPath`

- [ ] **Step 1: 写失败测试**

在 `tests/core/tool-permissions.test.ts` 增加：

```typescript
it('resolveToolPermission - 允许档写 AGENTS.md - 仍确认', async () => {
	let confirmed = false;
	await resolveToolPermission(
		{ id: '1', name: 'write_note', args: { path: 'Work/AGENTS.md' } },
		{ toolPermissionLevel: 'safe', toolPermissions: { write_note: 'allow' } },
		new ToolPermissionSessionGrants(),
		async () => {
			confirmed = true;
			return 'allow';
		},
	);
	expect(confirmed).toBe(true);
});

it('resolveToolPermission - 危险档写 AGENTS.md - 仍确认', async () => {
	let confirmed = false;
	await resolveToolPermission(
		{ id: '1', name: 'delete_note', args: { path: 'AGENTS.md' } },
		{ toolPermissionLevel: 'danger', toolPermissions: { delete_note: 'allow' } },
		new ToolPermissionSessionGrants(),
		async () => {
			confirmed = true;
			return 'allow';
		},
	);
	expect(confirmed).toBe(true);
});

it('resolveToolPermission - 拒绝档写 AGENTS.md - 不弹确认', async () => {
	let confirmed = false;
	await expect(
		resolveToolPermission(
			{ id: '1', name: 'write_note', args: { path: 'AGENTS.md' } },
			{ toolPermissionLevel: 'safe', toolPermissions: { write_note: 'deny' } },
			new ToolPermissionSessionGrants(),
			async () => {
				confirmed = true;
				return 'allow';
			},
		),
	).rejects.toThrow();
	expect(confirmed).toBe(false);
});

it('resolveToolPermission - 允许档写普通笔记 - 不确认', async () => {
	let confirmed = false;
	await resolveToolPermission(
		{ id: '1', name: 'write_note', args: { path: 'Work/note.md' } },
		{ toolPermissionLevel: 'safe', toolPermissions: { write_note: 'allow' } },
		new ToolPermissionSessionGrants(),
		async () => {
			confirmed = true;
			return 'allow';
		},
	);
	expect(confirmed).toBe(false);
});
```

先核对测试文件里 `ToolPermissionSessionGrants` 与 settings 形状的现有 import，按该文件已有写法补齐，不要另造类型。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/tool-permissions.test.ts -t AGENTS`
Expected: FAIL，允许档不会进入 confirm

- [ ] **Step 3: 实现**

在 `resolveToolPermission` 中，`perm === 'deny'` 抛错之后、goal grant 之前：

```typescript
if (mustConfirmAgentsMd(toolCall)) {
	const decision = await confirm(toolCall);
	if (decision === 'deny') throw new Error(tNow('error.tool.rejected'));
	return;
}
```

`mustConfirmAgentsMd`：工具名是 `write_note`、`edit_note`、`append_note`、`delete_note` 之一，且 `extractToolPath` 最后一段（按 `/` 或 `\`）恰好是 `AGENTS.md`。会话授权不记录、不读取。不要把这四个工具整体放进 `DESTRUCTIVE_TOOLS`。

确认卡标题沿用 `summarizeToolCall`。若路径存在，现有分支已能显示路径。不必新文案，除非现有摘要看不出是约束文件。能看出来就不要加 i18n。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/tool-permissions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tool-permissions.ts tests/core/tool-permissions.test.ts
git commit -m "fix: 改 AGENTS.md 时允许档和危险档也要确认"
```

---

### Task 3: 接到读、写和系统提示

**等 Task 1、Task 2 都在当前分支后再做。**

**Files:**
- Modify: `src/tools/read-note.ts`、`src/tools/write-note.ts`、`src/tools/edit-note.ts`、`src/tools/append-note.ts`、`src/tools/delete-note.ts`
- Modify: `src/main.ts`（构造各笔记工具时传入 `AgentsChainSeen` 与读文件函数）
- Modify: `src/prompts/composer.ts`（或现有系统提示组装处）插入库根约束段
- Modify: `src/i18n/zh.ts`、`en.ts`、`types.ts`
- Test: `tests/tools/note-agents-gate.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `agentsChainDirs`、`joinAgentsChain`、`nestedDirs`、`AgentsChainSeen`；Task 2 的 `mustConfirmAgentsMd`（本任务不改权限文件）
- 读文件由调用方注入：`readAgentsFile(dir: string): Promise<string | null>`，`dir === ''` 表示库根 `AGENTS.md`

- [ ] **Step 1: 写失败测试**

`tests/tools/note-agents-gate.test.ts` 用内存 map 模拟文件：

- 库根与 `Work/AGENTS.md` 都有正文时，`read_note('Work/a.md')` 的返回含 `Work` 的正文，且含优先句；不含把库根全文再贴一次（根可以只出现目录标题若实现选择省略根正文）。
- `write_note('Work/a.md')` 第一次不调用真正的写入，返回里有 `Work` 的约束。
- 同一 `AgentsChainSeen` 上第二次 `write_note('Work/a.md')` 调用真正的写入。
- `write_note('a.md')` 只有库根时第一次就写入。
- 目录里只有 `CLAUDE.md` 时，链里没有它的正文。

测试直接调用一个导出的 `applyNoteAgentsGate`，不要拉起 Obsidian。签名在实现时固定为：

```typescript
export async function applyNoteAgentsGate(input: {
	op: 'read' | 'write';
	notePath: string;
	seen: AgentsChainSeen;
	readAgentsFile: (dir: string) => Promise<string | null>;
}): Promise<{ proceed: boolean; attachment: string }>
```

`proceed === false` 表示调用方把 `attachment` 当工具结果返回、不写盘。`op === 'read'` 时 `proceed` 恒为 true，`attachment` 是要附在读结果后的文字（可为空）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/note-agents-gate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现闸门并接到工具**

`applyNoteAgentsGate` 放在 `src/tools/note-agents.ts`。写操作且 `nestedDirs` 非空且 `seen.has` 为 false：读这些目录的 `AGENTS.md`，`joinAgentsChain`，`seen.mark`，返回 `{ proceed: false, attachment }`。否则 `{ proceed: true, attachment }`。读操作：附上 nested 层，并 `seen.mark`。

四个写工具和 `read_note` 增加可选依赖 `agents?: { seen: AgentsChainSeen; readAgentsFile: ... }`。未传入时行为与现在相同（测试旧用例不破）。`main.ts` 用 vault 读 `dir ? dir + '/AGENTS.md' : 'AGENTS.md'`，读失败当 null。每个 agent loop 回合 new 一个 `AgentsChainSeen` 传下去；不要做成插件单例，否则跨回合会把「已见」一直记住。

库根正文：在系统提示组装处，若能同步读到根 `AGENTS.md`，截断到 8192 字节后放进记忆段之后。读根失败则省略。这层用 i18n 标题 `promptLabel` 或直接中文段首 `笔记约束（库根）`。段首若给用户看见，走 i18n；只给模型的正文保持中文，与现有默认提示一致。截断句走 `tNow('noteAgents.truncated')`。

- [ ] **Step 4: 跑测试并构建**

Run: `npx vitest run tests/tools/note-agents.test.ts tests/tools/note-agents-gate.test.ts tests/core/tool-permissions.test.ts src/i18n/strings.test.ts && node esbuild.config.mjs production`
Expected: 测试 PASS，构建成功。已知 `skill-script-sandbox` 心跳 flake 可忽略。

- [ ] **Step 5: Commit**

```bash
git add src/tools/note-agents.ts src/tools/read-note.ts src/tools/write-note.ts src/tools/edit-note.ts src/tools/append-note.ts src/tools/delete-note.ts src/main.ts src/prompts/composer.ts src/i18n tests/tools/note-agents-gate.test.ts
git commit -m "feat: 读笔记时附上目录约束，没看过约束不能写"
```

## 自审

- NA-01、NA-04、NA-05、NA-08 → Task 1 与 Task 3 的 `CLAUDE.md` 用例。
- NA-02、NA-03、NA-06、NA-09 → Task 3。不执行命令是因为闸门只返回文字。
- NA-07 → Task 2，并且写明危险档和会话授权也不跳过。
- Task 1 与 Task 2 文件不重叠。
