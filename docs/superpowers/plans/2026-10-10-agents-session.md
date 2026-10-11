# S-AGENTS-SESSION 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 子目录 `AGENTS.md` 按目录去重，挂在触发它的工具结果上，整场会话保留；压缩丢掉那条消息后下次再加载。

**Architecture:** 纯函数负责路径、过期目录和拼块。`ContextManager` 把块写在 tool 消息字段上，组装上送包时才接到 `content` 后面，并据此重算已加载目录。`agent-loop` 在权限通过后、执行前加载。笔记工具不再注入。

**Tech Stack:** TypeScript、Vitest、现有 `ContextManager` 与 `agentLoop`。

**Spec:** [2026-10-10-agents-session-design.md](../specs/2026-10-10-agents-session-design.md)

**实施文本:** [note-agents.md](../../architecture/agent/note-agents.md) §4–§10。与本文冲突时以架构文档为准，并改本文对应步骤。

## Global Constraints

- 库根仍每轮 `setNoteAgentsRoot`。子目录不进 injector。
- 去重单位是单个目录。已加载集合每次 `loadNoteAgents` 当场重算，禁止在一批工具调用外缓存。
- 权限拒绝、参数非法、执行前钩子拒绝：不加载。执行失败仍挂块，不标 `noteAgentsStale`。
- `noteAgentsStale` 只含该 `AGENTS.md` 所在目录。`A/B/AGENTS.md` → `['A/B']`。库根不标过期。
- 单文件 8KB，单块 16KB。被丢掉的层不进 `dirs`。一层都不剩则不挂块。
- 发给适配器的消息没有 `noteAgents`、`noteAgentsStale`。`tool.result` 事件和工具卡片不含块正文。
- 压缩改写消息必须 `{...m, content}`。移出和 32k 只改 `content`。
- 未登记 reader 时 `loadNoteAgents` 返回 `undefined`，不抛错。
- 工作区可能有无关改动。提交时只暂存本任务列出的文件。
- 不改 CHANGELOG。不改确认卡。

---

### Task 1: 路径、过期目录、拼块

**Files:**
- Modify: `src/tools/note-agents.ts`
- Modify: `src/ports/llm.ts`（只为 `ToolCall` 类型；字段本身在 Task 2）
- Test: `tests/tools/note-agents.test.ts`

**Interfaces:**
- Consumes: `nestedDirs`、`truncateUtf8`、`validateVaultPath`（`src/utils/path-safety.ts`）、`peekUpdateFilePath`
- Produces:

```ts
export function touchedNotePaths(tc: ToolCall): string[]
export function staleAgentsDirs(paths: string[]): string[]
export function joinAgentsBlock(
  layers: { dir: string; text: string }[],
): { dirs: string[]; text: string } | undefined
```

本任务不删 `AgentsChainSeen`、`injectAgentsForPaths`、`joinAgentsChain`。后续任务还在用。

- [ ] **Step 1: Write the failing test**

在 `tests/tools/note-agents.test.ts` 增加导入 `touchedNotePaths`、`staleAgentsDirs`、`joinAgentsBlock`，并追加：

```typescript
describe('touchedNotePaths', () => {
	it('touchedNotePaths - read_note - 取 path', () => {
		expect(touchedNotePaths({ id: '1', name: 'read_note', args: { path: 'Work/a.md' } })).toEqual(['Work/a.md']);
	});
	it('touchedNotePaths - move_note - from 在 to 前', () => {
		expect(touchedNotePaths({
			id: '1', name: 'move_note', args: { from: 'A/x.md', to: 'B/y.md' },
		})).toEqual(['A/x.md', 'B/y.md']);
	});
	it('touchedNotePaths - copy_note - 只有 to', () => {
		expect(touchedNotePaths({
			id: '1', name: 'copy_note', args: { from: 'A/x.md', to: 'B/y.md' },
		})).toEqual(['B/y.md']);
	});
	it('touchedNotePaths - apply_patch - 取 Update File', () => {
		expect(touchedNotePaths({
			id: '1',
			name: 'apply_patch',
			args: { patch: '*** Begin Patch\n*** Update File: Work/a.md\n@@\n-a\n+b\n*** End Patch' },
		})).toEqual(['Work/a.md']);
	});
	it('touchedNotePaths - grep - 空', () => {
		expect(touchedNotePaths({ id: '1', name: 'grep', args: { path: 'Work/a.md' } })).toEqual([]);
	});
	it('touchedNotePaths - 路径含 .. - 丢弃', () => {
		expect(touchedNotePaths({ id: '1', name: 'read_note', args: { path: '../x.md' } })).toEqual([]);
	});
});

describe('staleAgentsDirs', () => {
	it('staleAgentsDirs - 子目录文件 - 只有所在目录', () => {
		expect(staleAgentsDirs(['A/B/AGENTS.md'])).toEqual(['A/B']);
	});
	it('staleAgentsDirs - 库根 - 空', () => {
		expect(staleAgentsDirs(['AGENTS.md'])).toEqual([]);
	});
	it('staleAgentsDirs - 移动到另一个 AGENTS.md - 源和目标都过期', () => {
		expect(staleAgentsDirs(['A/AGENTS.md', 'B/AGENTS.md'])).toEqual(['A', 'B']);
	});
	it('staleAgentsDirs - 普通笔记 - 空', () => {
		expect(staleAgentsDirs(['Work/a.md'])).toEqual([]);
	});
});

describe('joinAgentsBlock', () => {
	it('joinAgentsBlock - 两层 - 浅的在前且含优先句', () => {
		const block = joinAgentsBlock([
			{ dir: 'Work', text: '工作规则' },
			{ dir: 'Work/Diary', text: '日记规则' },
		]);
		expect(block!.dirs).toEqual(['Work', 'Work/Diary']);
		expect(block!.text.indexOf('工作规则')).toBeLessThan(block!.text.indexOf('日记规则'));
		expect(block!.text).toContain('离笔记更近的优先');
		expect(block!.text.startsWith('[目录约束 AGENTS.md]')).toBe(true);
	});
	it('joinAgentsBlock - 三层各 7KB - 丢掉最浅且不进 dirs', () => {
		const block = joinAgentsBlock([
			{ dir: 'A', text: '甲'.repeat(7000) },
			{ dir: 'A/B', text: '乙'.repeat(7000) },
			{ dir: 'A/B/C', text: '丙'.repeat(7000) },
		]);
		expect(block!.dirs).not.toContain('A');
		expect(block!.text).toContain('已截断');
	});
	it('joinAgentsBlock - 单层远超 16KB - 不返回块', () => {
		expect(joinAgentsBlock([{ dir: 'Work', text: '甲'.repeat(20000) }])).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/note-agents.test.ts`

Expected: FAIL，`touchedNotePaths` 未导出。

- [ ] **Step 3: Write minimal implementation**

在 `src/tools/note-agents.ts` 增加。`NOTE_AGENTS_TOUCH` 用 `as const`。路径校验失败的丢掉，不向外抛。

```typescript
import type { ToolCall } from '../ports/llm';
import { peekUpdateFilePath } from './apply-patch-text';
import { validateVaultPath } from '../utils/path-safety';

const NOTE_AGENTS_TOUCH = [
	'read_note', 'write_note', 'append_note', 'edit_note', 'delete_note',
	'apply_patch', 'move_note', 'copy_note',
] as const;

const BLOCK_HEADER =
	'[目录约束 AGENTS.md] 下面是本次路径所在目录的约束，本会话内持续有效；同一目录之后再出现新版本时以新版本为准。';

export function touchedNotePaths(tc: ToolCall): string[] {
	if (!(NOTE_AGENTS_TOUCH as readonly string[]).includes(tc.name)) return [];
	const raw: string[] = [];
	if (tc.name === 'apply_patch') {
		const path = typeof tc.args.patch === 'string' ? peekUpdateFilePath(tc.args.patch) : undefined;
		if (path) raw.push(path);
	} else if (tc.name === 'move_note') {
		if (typeof tc.args.from === 'string') raw.push(tc.args.from);
		if (typeof tc.args.to === 'string') raw.push(tc.args.to);
	} else if (tc.name === 'copy_note') {
		if (typeof tc.args.to === 'string') raw.push(tc.args.to);
	} else if (typeof tc.args.path === 'string') {
		raw.push(tc.args.path);
	}
	const out: string[] = [];
	for (const path of raw) {
		try {
			out.push(validateVaultPath(path));
		} catch {
			// 非法路径交给工具自己报错
		}
	}
	return out;
}

export function staleAgentsDirs(paths: string[]): string[] {
	const out: string[] = [];
	for (const path of paths) {
		const parts = path.split(/[/\\]/).filter((p) => p.length > 0);
		if (parts.at(-1) !== 'AGENTS.md') continue;
		const dir = nestedDirs(path).at(-1);
		if (dir && !out.includes(dir)) out.push(dir);
	}
	return out;
}

export function joinAgentsBlock(
	layers: { dir: string; text: string }[],
): { dirs: string[]; text: string } | undefined {
	let truncated = false;
	let remaining = layers.map((layer) => {
		const cut = truncateUtf8(layer.text, AGENTS_FILE_MAX_BYTES);
		if (cut.truncated) truncated = true;
		return { dir: layer.dir, text: cut.text };
	});
	const assemble = (rows: { dir: string; text: string }[], cut: boolean) => {
		const body = rows.map((l) => `## ${l.dir}\n${l.text}`).join('\n\n');
		const parts = [BLOCK_HEADER, body, PRIORITY_NOTE];
		if (cut) parts.push(tNow('noteAgents.truncated'));
		return parts.join('\n\n');
	};
	while (remaining.length > 0) {
		const text = assemble(remaining, truncated);
		if (utf8ByteLength(text) <= AGENTS_CHAIN_MAX_BYTES) {
			return { dirs: remaining.map((l) => l.dir), text };
		}
		remaining = remaining.slice(1);
		truncated = true;
	}
	return undefined;
}
```

`peekUpdateFilePath` 的现有返回值若已是校验后的路径，不要再校验第二次导致丢弃。先读该函数：它返回补丁里的原始路径字符串。再过 `validateVaultPath`。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/note-agents.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tools/note-agents.ts tests/tools/note-agents.test.ts
git commit -m "$(cat <<'EOF'
feat: 按目录收集子目录约束块

EOF
)"
```

---

### Task 2: 块落在工具消息上，已加载从历史视图重算

**Files:**
- Modify: `src/ports/llm.ts`（`ChatMessage`）
- Modify: `src/core/context-manager.ts`
- Test: `tests/core/note-agents-session.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `joinAgentsBlock`、`nestedDirs`
- Produces:

```ts
setNoteAgentsReader(read: ((dir: string) => Promise<string | null>) | undefined): void
loadNoteAgents(paths: string[]): Promise<{ dirs: string[]; text: string } | undefined>
addToolResult(
  toolCallId: string,
  result: string,
  extra?: {
    noteAgents?: { dirs: string[]; text: string };
    noteAgentsStale?: string[];
  },
): void
```

`loadedNoteAgentsDirs`、`buildHistoryView`、`materializeNoteAgents` 保持 private。`toMessages` 与 `loadNoteAgents` 必须走同一个 `buildHistoryView`。

- [ ] **Step 1: Write the failing test**

新建 `tests/core/note-agents-session.test.ts`。`emptyPersistence` 从 `tests/tools/note-agents-gate.test.ts` 抄一份到本文件，不要改那个旧文件（Task 4 再删）。

```typescript
async function boot(ctx: ContextManager) {
	await ctx.load('s1');
	ctx.addUserMessage('hi');
}

it('loadNoteAgents - 未登记 reader - 返回 undefined', async () => {
	const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
	await boot(ctx);
	expect(await ctx.loadNoteAgents(['Work/a.md'])).toBeUndefined();
});

it('addToolResult - 首次加载 Work - 字段在消息上且系统段不含子目录', async () => {
	const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
	await boot(ctx);
	ctx.setNoteAgentsRoot('库根规则');
	ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作规则' : null));
	const block = await ctx.loadNoteAgents(['Work/a.md']);
	ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
	ctx.addToolResult('c1', '{"content":"正文"}', { noteAgents: block });
	const stored = ctx.getTranscript().find((m) => m.role === 'tool')!;
	expect(stored.noteAgents?.dirs).toEqual(['Work']);
	expect(stored.content).not.toContain('工作规则');
	const outbound = ctx.toMessages().find((m) => m.role === 'tool')!;
	expect(outbound.content.startsWith('{"content":"正文"}')).toBe(true);
	expect(outbound.content).toContain('工作规则');
	expect(outbound.noteAgents).toBeUndefined();
	expect(ctx.toMessages().filter((m) => m.role === 'system').map((m) => m.content).join('\n')).toContain('库根规则');
	expect(ctx.toMessages().filter((m) => m.role === 'system').map((m) => m.content).join('\n')).not.toContain('工作规则');
});

it('loadNoteAgents - 同目录已在历史里 - 不再加载', async () => {
	const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
	await boot(ctx);
	ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作规则' : null));
	const first = await ctx.loadNoteAgents(['Work/a.md']);
	ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
	ctx.addToolResult('c1', 'ok', { noteAgents: first });
	expect(await ctx.loadNoteAgents(['Work/b.md'])).toBeUndefined();
});

it('loadNoteAgents - 已有 Work 再碰 Diary - 只返回 Diary', async () => {
	const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
	await boot(ctx);
	ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作' : dir === 'Work/Diary' ? '日记' : null));
	const first = await ctx.loadNoteAgents(['Work/a.md']);
	ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
	ctx.addToolResult('c1', 'ok', { noteAgents: first });
	const second = await ctx.loadNoteAgents(['Work/Diary/c.md']);
	expect(second!.dirs).toEqual(['Work/Diary']);
});

it('loadNoteAgents - stale 之后 - 重新加载', async () => {
	const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
	await boot(ctx);
	let text = '旧规则';
	ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? text : null));
	const first = await ctx.loadNoteAgents(['Work/a.md']);
	ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
	ctx.addToolResult('c1', 'ok', { noteAgents: first });
	text = '新规则';
	ctx.addAssistantToolCall({ id: 'c2', name: 'edit_note', args: { path: 'Work/AGENTS.md' } }, '');
	ctx.addToolResult('c2', 'ok', { noteAgentsStale: ['Work'] });
	const again = await ctx.loadNoteAgents(['Work/b.md']);
	expect(again!.text).toContain('新规则');
});

it('toMessages - 保存再 load - 仍视为已加载', async () => {
	const persistence = emptyPersistence();
	const ctx = new ContextManager(persistence, undefined, 8000);
	await boot(ctx);
	ctx.setNoteAgentsReader(async () => '工作规则');
	const block = await ctx.loadNoteAgents(['Work/a.md']);
	ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
	ctx.addToolResult('c1', 'ok', { noteAgents: block });
	await ctx.save();
	const ctx2 = new ContextManager(persistence, undefined, 8000);
	await ctx2.load('s1');
	ctx2.setNoteAgentsReader(async () => '工作规则');
	expect(await ctx2.loadNoteAgents(['Work/b.md'])).toBeUndefined();
});

it('loadNoteAgents - 压缩标记覆盖带块的消息 - 重新加载', async () => {
	const ctx = new ContextManager(emptyPersistence(), undefined, 8000);
	await boot(ctx);
	ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作规则' : null));
	const block = await ctx.loadNoteAgents(['Work/a.md']);
	ctx.addAssistantToolCall({ id: 'c1', name: 'read_note', args: { path: 'Work/a.md' } }, '');
	ctx.addToolResult('c1', 'ok', { noteAgents: block });
	const afterIndex = ctx.getTranscript().length - 1;
	await ctx.appendCompactMarker({
		afterIndex,
		summary: '已读 Work',
		restoredNotePaths: [],
		at: Date.now(),
	});
	const again = await ctx.loadNoteAgents(['Work/a.md']);
	expect(again!.dirs).toEqual(['Work']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/note-agents-session.test.ts`

Expected: FAIL，`setNoteAgentsReader` 不存在。

- [ ] **Step 3: Write minimal implementation**

`ChatMessage` 增加可选字段 `noteAgents?`、`noteAgentsStale?`，注释写明只在 `role: 'tool'` 上设置。

`ContextManager`：

- 字段 `private noteAgentsReader?: (dir: string) => Promise<string | null>`。
- `setNoteAgentsReader` 赋值。未传入或传入 `undefined` 时清空。
- 删除 `appendNoteAgentsChain`。全库调用点在 Task 4 去掉；本任务若先删方法，`main.ts` 会编不过。所以本任务保留该方法，标成只给旧测试用，Task 4 再删。不要在新测试里调用它。
- `addToolResult` 增加可选第三参。有 `noteAgents` 才写入字段；`noteAgentsStale` 非空才写入。
- 把 `toMessages` 里 `projectView` → `pruneToolContents` → `trimHistory` 抽成 private `buildHistoryView(): ChatMessage[]`，返回 `[...head, ...trimmedTail]`。
- `trimHistory` 的 `tokensPerMsg` 改为 `estimateTokens(m.content + (m.noteAgents?.text ?? ''))`。步骤 4 仍只替换 `content`，展开时用 `{...msg, content}`。
- `loadedNoteAgentsDirs`：遍历 `buildHistoryView()`，tool 消息先把 `noteAgents.dirs` 加入，再把 `noteAgentsStale` 删除。
- `loadNoteAgents`：无 reader 或 `paths` 为空返回 `undefined`。按架构文档 §5.2 的 `wanted` 循环调用 reader。`joinAgentsBlock` 的返回值原样返回。
- `materializeNoteAgents`：`{...m, content: m.content + '\n\n' + m.noteAgents.text}`，再删掉两个字段。`toMessages` 在拼完数组后对全部消息做这一步，包括历史，不包括系统段（系统段没有这个字段）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/note-agents-session.test.ts tests/tools/note-agents-gate.test.ts`

Expected: PASS。旧的 `appendNoteAgentsChain` 测试仍然通过。

- [ ] **Step 5: Commit**

```bash
git add src/ports/llm.ts src/core/context-manager.ts tests/core/note-agents-session.test.ts
git commit -m "$(cat <<'EOF'
feat: 子目录约束挂在工具结果上并按历史去重

EOF
)"
```

---

### Task 3: 主循环在执行前加载

**Files:**
- Modify: `src/core/agent-loop.ts`（约 364–504 行，工具执行段）
- Test: `tests/core/agent-loop.test.ts`

**Interfaces:**
- Consumes: `touchedNotePaths`、`staleAgentsDirs`、`ctx.loadNoteAgents`、`ctx.addToolResult` 第三参
- Produces: 无新导出。权限通过后的工具调用会把块写进对应 tool 消息。

- [ ] **Step 1: Write the failing test**

在 `tests/core/agent-loop.test.ts` 追加。沿用文件里的 `createMockPersistence`、`createMockLLM`。

```typescript
it('agentLoop - read_note 碰到新目录 - 块在下一次请求里且 tool.result 不含块', async () => {
	const persistence = createMockPersistence();
	const ctx = new ContextManager(persistence, undefined, 8000);
	ctx.setNoteAgentsReader(async (dir) => (dir === 'Work' ? '工作规则' : null));
	const toolCall = { id: 'call_1', name: 'read_note', args: { path: 'Work/a.md' } };
	let saw: string[] = [];
	const llm = {
		async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
			saw = req.messages.filter((m) => m.role === 'tool').map((m) => m.content);
			if (saw.length === 0) {
				yield { text: '', toolCall };
				return;
			}
			yield { text: 'done' };
		},
		embed: async () => [],
		countTokens: () => 10,
	};
	const tools = new ToolRegistry();
	tools.register({
		definition: { name: 'read_note', description: 'read', parameters: {} },
		execute: async () => '正文',
	});
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(
		{ sessionId: 's1', message: '读' }, ctx, llm, tools, new HookRegistry(),
	)) {
		events.push(event);
	}
	const result = events.find((e) => e.type === 'tool.result');
	expect(JSON.stringify(result)).not.toContain('工作规则');
	expect(saw.some((c) => c.includes('工作规则') && c.startsWith('"正文"') || c.includes('正文'))).toBe(true);
	const stored = ctx.getTranscript().find((m) => m.role === 'tool');
	expect(stored?.noteAgents?.dirs).toEqual(['Work']);
	expect(stored?.content).not.toContain('工作规则');
});
```

`execute` 返回字符串 `'正文'` 时，`addToolResult` 收到的是 `JSON.stringify('正文')`，即 `"正文"`。断言上送 `content` 以 `"正文"` 开头并包含 `工作规则`。把上面 `saw.some` 改成：

```typescript
expect(saw.some((c) => c.startsWith('"正文"') && c.includes('工作规则'))).toBe(true);
```

再加两则，放在同一 `describe` 里。

权限拒绝：`toolPermissionCheck` 抛 `new Error('denied')`，工具名 `read_note`，路径 `Work/a.md`，reader 返回 `'工作规则'`。结束后 `getTranscript` 里 tool 消息的 `content` 以 `Error:` 开头，且 `noteAgents` 为 `undefined`。

执行失败：`execute` 抛 `new Error('missing')`。tool 消息的 `noteAgents.dirs` 为 `['Work']`，`noteAgentsStale` 为 `undefined`，`content` 包含 `missing`。`tool.result` 事件的 JSON 不含 `工作规则`。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/agent-loop.test.ts -t "碰到新目录|拒绝时不加载"`

Expected: FAIL，存储的消息没有 `noteAgents`。

- [ ] **Step 3: Write minimal implementation**

在 `pre-tool-use` 允许之后、`tools.execute` 之前：

```typescript
const touched = touchedNotePaths(tc);
let block: { dirs: string[]; text: string } | undefined;
if (!signal?.aborted) {
	block = await ctx.loadNoteAgents(touched);
}
if (signal?.aborted) {
	yield { type: 'error', payload: { code: 'CANCELLED', message: '用户取消' } };
	loopExitedViaBreak = true;
	break;
}
```

执行结束后，现有 `addToolResult` 改为：

```typescript
const stale = toolFailed ? undefined : staleAgentsDirs(touched);
ctx.addToolResult(tc.id, JSON.stringify(result), {
	...(block ? { noteAgents: block } : {}),
	...(stale && stale.length > 0 ? { noteAgentsStale: stale } : {}),
});
```

`argsIssue`、权限拒绝、钩子拒绝三条路径保持两参数的 `addToolResult`，不要加载。`yield tool.result` 仍传原来的 `result`。

`touched` 必须在 try 外声明，失败路径也能用同一个数组算 stale（失败时不算）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/agent-loop.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-loop.ts tests/core/agent-loop.test.ts
git commit -m "$(cat <<'EOF'
feat: 主循环在执行笔记工具前加载目录约束

EOF
)"
```

---

### Task 4: 拆掉工具内注入

**Files:**
- Modify: `src/tools/read-note.ts`、`write-note.ts`、`append-note.ts`、`edit-note.ts`、`apply-patch.ts`、`delete-note.ts`、`move-note.ts`、`copy-note.ts`
- Modify: `src/tools/note-agents.ts`（删除旧导出）
- Modify: `src/main.ts`（约 246、527–589、1834–1848 行）
- Modify: `src/core/context-manager.ts`（删除 `appendNoteAgentsChain`）
- Delete tests that only cover the old gate: `tests/tools/note-agents-gate.test.ts` 中 `applyNoteAgentsGate` 与 `appendNoteAgentsChain` 两段
- Modify: `tests/tools/note-agents.test.ts`（删除 `AgentsChainSeen` 三则）
- Modify: `tests/tools/move-copy-note.test.ts`（删除第三参和「目录有约束」那则里对 `appendChain` 的断言；移动成功、结果不含约束正文的断言留下）

**Interfaces:**
- Consumes: Task 3 已在循环里加载
- Produces: 笔记工具工厂不再接收 `getAgents`。`main.ts` 在 `setNoteAgentsRoot` 之后调用 `ctx.setNoteAgentsReader`，函数体用现在 `readAgentsFile` 的实现（库根目录不读，读失败返回 `null`）。

- [ ] **Step 1: Write the failing test**

把 `tests/tools/move-copy-note.test.ts` 里「目录有约束」改成不再传入第三参，并删掉 `appended`。期望仍是第一次移动成功且结果不含「第一幕规则」。

在 `tests/core/note-agents-session.test.ts` 追加：无 reader 时 `loadNoteAgents` 已覆盖。再追加一则压缩投影：

```typescript
it('microcompactMessages - 折叠正文 - 保留 noteAgents', () => {
	const folded = microcompactMessages([
		{ role: 'tool', content: '旧', toolCallId: 'a', noteAgents: { dirs: ['Work'], text: '工作规则' } },
		{ role: 'tool', content: '1', toolCallId: 'b' },
		{ role: 'tool', content: '2', toolCallId: 'c' },
		{ role: 'tool', content: '3', toolCallId: 'd' },
		{ role: 'tool', content: '4', toolCallId: 'e' },
		{ role: 'tool', content: '5', toolCallId: 'f' },
		{ role: 'tool', content: '6', toolCallId: 'g' },
	], 5);
	expect(folded[0]!.noteAgents?.dirs).toEqual(['Work']);
});
```

这条在删注入之前就可以是绿的。本任务用它防止有人改折叠时丢掉字段。导入 `microcompactMessages`。

- [ ] **Step 2: Run test to verify it fails**

先改 `move-copy-note` 的调用，第三参还在类型里时测试仍会通过。本步改为：删掉八个工具的第三参之后跑

Run: `npx vitest run tests/tools/move-copy-note.test.ts tests/tools/note-agents-gate.test.ts`

Expected: 在第三参删除前，这一步先改测试里的 `createMoveNoteTool(..., () => ...)` 为两参。若类型仍要求三参，FAIL。若第三参本就是可选，测试直接 PASS，然后继续 Step 3，不要为了制造失败去改生产类型两次。

- [ ] **Step 3: Write minimal implementation**

八个 `create*Tool` 去掉 `getAgents` 参数和函数体内的 `injectAgentsForPaths`。`main.ts` 注册处去掉第三参，删掉 `noteAgentsTurn` 与 `AgentsChainSeen` 导入。`setNoteAgentsReader` 使用现有读文件闭包，不要 `appendChain`。

从 `note-agents.ts` 删除：`AgentsChainSeen`、`collectUnseenAgentsChain`、`injectAgentsForPaths`、`applyNoteAgentsGate`、`NoteAgentsToolDeps`、`joinAgentsChain`（确认无引用后再删）。

删除 `appendNoteAgentsChain`。删除 `note-agents-gate.test.ts` 里对已删符号的 describe；文件若变空则删文件。`note-agents.test.ts` 里 `joinAgentsChain` 与 `AgentsChainSeen` 的用例一并删除。

`rg "injectAgentsForPaths|AgentsChainSeen|appendNoteAgentsChain|applyNoteAgentsGate|NoteAgentsToolDeps|joinAgentsChain"` 结果应为空。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/note-agents.test.ts tests/tools/move-copy-note.test.ts tests/core/note-agents-session.test.ts tests/core/agent-loop.test.ts tests/core/compact-project.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/tools src/main.ts src/core/context-manager.ts tests/tools/note-agents.test.ts tests/tools/note-agents-gate.test.ts tests/tools/move-copy-note.test.ts tests/core/note-agents-session.test.ts
git commit -m "$(cat <<'EOF'
refactor: 笔记工具不再自行注入目录约束

EOF
)"
```

若 `note-agents-gate.test.ts` 已删除，`git add` 会记录删除。

---

## 自审

| Spec 目标 | 任务 |
|---|---|
| 库根每轮重读 | 不改 `setNoteAgentsRoot`；Task 2 断言系统段只有库根 |
| 首次加载、之后不重复 | Task 2、Task 3 |
| 挂在工具结果上，气泡不含块 | Task 2 的 stored `content`、Task 3 的 `tool.result` |
| 按目录去重 | Task 2 的 Diary 用例 |
| 压缩后重新加载；移出不丢字段 | Task 4 的 `microcompactMessages` 用例。投影掉整条消息后的重新加载靠 `loadedNoteAgentsDirs` 只看 `buildHistoryView`；补一则在 Task 2：写入 `compactMarkers` 覆盖带块消息后，`loadNoteAgents` 再次返回 `Work`。实现时若发现测试夹具缺 `CompactMarker` 必填字段，按 `src/types` 里的现有类型补齐，不要改标记结构 |
| 改写后旧块作废 | Task 2 的 stale 用例；Task 1 的 `staleAgentsDirs` |
| 不阻塞执行 | Task 3 权限拒绝不加载；移动失败仍挂块。Task 3 再加一则：`execute` 抛错时消息仍有 `noteAgents` 且没有 `noteAgentsStale` |
| 无 reader | Task 2 |
| 确认卡不动 | 无任务修改 `tool-permissions.ts` |

压缩投影那则和执行失败那则写在 Task 2、Task 3 的测试文件里，不要另开任务。
