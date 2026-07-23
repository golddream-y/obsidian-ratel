# Chat 会话管理 Implementation Plan(P-SESSION)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重开续聊、`/new` 扎实、按需分文件存储、Header 小图标菜单、切换 loading/动效、Trace hydrate；Skill 激活对齐 ADR-012；首轮 LLM 短标题。

**Architecture:** `data.json` 只保留 settings + 会话索引 + `lastSessionId` + notes/hooks；每场正文 `pluginDir/sessions/<id>.json`。ChatView 打开时 load 一场并 hydrate；切换走 `exiting → loading → entering`。`activate_skill` 把指令写入 `Session.messages`，不再靠全局 Active 段每轮重注。

**Tech Stack:** TypeScript(strict)、Vitest、Svelte 5、node:fs(桌面)、现有 i18n / Persistence 端口

## Global Constraints

- Spec:[S-SESSION](../specs/2026-07-23-chat-session-management-design.md)；Skill:[ADR-012](../../adr/2026-07-23-skill-activation-claude-aligned.md)
- 用户可见字符串必须 i18n(`chat.session.*` 等)
- 切换动效与 loading 为硬性要求(§6)；`prefers-reduced-motion` 仍须有 loading 反馈
- 禁止每次 Chat 挂载无条件 `session-' + Date.now()`
- `saveSettings` / Persistence **必须 read-merge-write**，禁止互覆盖
- 不擅自 `git commit`(除非用户明确要求)
- 验证:`npx vitest run <单文件>`；若 SIGKILL 用 esbuild/node harness
- 测试描述中文:`行为 - 条件 - 期望结果`
- 文件头 / 导出按 AGENTS.md 中文注释规范

---

## File Map

| 文件 | 职责 |
|------|------|
| Modify: `src/ports/persistence.ts` | `SessionIndexEntry`；`list` 可只返回索引；保留 `Session` |
| Create: `src/adapters/session-file-store.ts` | `sessions/<id>.json` 读写删、限额裁剪 |
| Modify: `src/adapters/persistence-json.ts` | 索引进 data.json；正文走 SessionFileStore；迁移旧内嵌 sessions |
| Modify: `src/main.ts` | 注入 `pluginDir`；`saveSettings` merge；构造 Persistence |
| Create: `src/ui/chat/message-stream/hydrate-session-messages.ts` | `ChatMessage[]` → UI `Message[]`(think/tool/text) |
| Modify: `src/ui/chat/message-stream/chat-message-to-ui.ts` | compact 仍可精简；或委托 hydrate 的 text-only 模式 |
| Create: `src/ui/chat/session/session-content.ts` | `sessionHasContent(messages)` |
| Create: `src/ui/chat/session/session-transition.ts` | 时长常量、`shouldPadLoading(ms)`、reduce-motion 探测接口 |
| Create: `src/ui/chat/session/SessionMenu.svelte` | Header popover 列表 |
| Create: `src/ui/chat/session/session-title.ts` | 截断回退 + LLM 标题 prompt 拼装 |
| Modify: `src/ui/chat/ChatView.svelte` / `styles.css` | 续聊、/new、菜单、shell/overlay/动效 |
| Modify: `src/tools/activate-skill.ts` + `deactivate-skill.ts` + `agent-loop` / `context-manager` / `skill-registry` | ADR-012 |
| Modify: `src/i18n/types.ts` `zh.ts` `en.ts` | 会话文案 |
| Test: 见各 Task | |

---

### Task 1: Session 索引类型 + `sessionHasContent`

**Files:**
- Modify: `src/ports/persistence.ts`
- Create: `src/ui/chat/session/session-content.ts`
- Test: `tests/ui/chat/session/session-content.test.ts`

**Interfaces:**
- Produces:
  - `export interface SessionIndexEntry { id: string; title: string; createdAt: number; updatedAt: number; messageCount?: number }`
  - `export function sessionHasContent(messages: ChatMessage[]): boolean` — 至少一条 `user`，或 assistant/tool 含非空 content / reasoning / toolName

- [ ] **Step 1: 写失败测试**

```ts
/**
 * @file tests/ui/chat/session/session-content.test.ts
 */
import { describe, it, expect } from 'vitest';
import { sessionHasContent } from '../../../../src/ui/chat/session/session-content';

describe('sessionHasContent', () => {
	it('sessionHasContent - 空数组 - false', () => {
		expect(sessionHasContent([])).toBe(false);
	});
	it('sessionHasContent - 仅空 assistant - false', () => {
		expect(sessionHasContent([{ role: 'assistant', content: '' }])).toBe(false);
	});
	it('sessionHasContent - 有 user - true', () => {
		expect(sessionHasContent([{ role: 'user', content: 'hi' }])).toBe(true);
	});
	it('sessionHasContent - assistant 带 toolName - true', () => {
		expect(
			sessionHasContent([{ role: 'assistant', content: '', toolName: 'search_vault', toolCallId: '1' }]),
		).toBe(true);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ui/chat/session/session-content.test.ts`  
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 `session-content.ts` + 在 `persistence.ts` 增加 `SessionIndexEntry` 导出**

```ts
/**
 * @file src/ui/chat/session/session-content.ts
 * @description 判断会话是否「有内容」( /new 归档 vs 丢弃 )
 */
import type { ChatMessage } from '../../../ports/llm';

export function sessionHasContent(messages: ChatMessage[]): boolean {
	for (const m of messages) {
		if (m.role === 'user' && m.content.trim().length > 0) return true;
		if (m.role === 'assistant') {
			if (m.content.trim().length > 0) return true;
			if (m.reasoning && m.reasoning.trim().length > 0) return true;
			if (m.toolName) return true;
		}
		if (m.role === 'tool' && m.content.trim().length > 0) return true;
	}
	return false;
}
```

在 `persistence.ts` 的 `Session` 旁增加:

```ts
/** 轻量索引项 — 不含 messages,供列表与 lastSessionId 配套 */
export interface SessionIndexEntry {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	messageCount?: number;
}
```

- [ ] **Step 4: 测试通过**

Run: `npx vitest run tests/ui/chat/session/session-content.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**(仅当用户要求时)

---

### Task 2: SessionFileStore + Persistence 分文件 + 迁移

**Files:**
- Create: `src/adapters/session-file-store.ts`
- Modify: `src/adapters/persistence-json.ts`
- Modify: `src/ports/persistence.ts` — `SessionRepository.list` 文档改为可返回无 messages 的瘦 Session 或增加 `listIndex(): Promise<SessionIndexEntry[]>`(**推荐新增 `listIndex`**,保留 `list` 兼容时仍读文件会慢 — 本 Task 起 `list` 改为基于索引构造瘦对象且 **messages: []`**,全文只经 `get`**)
- Modify: `src/main.ts` — `new PersistenceJson(load, save, pluginDir)`
- Test: `tests/adapters/session-file-store.test.ts`
- Test: `tests/adapters/persistence-json-sessions.test.ts`(用临时目录)

**Interfaces:**
- Produces:
  - `export class SessionFileStore { constructor(sessionsDir: string); get/upsert/delete/listIds; enforceMaxSessions(index, maxN) }`
  - `PersistenceJson` 构造第三参 `pluginDir: string`；`DataStore` 含 `sessionIndex: SessionIndexEntry[]`、`lastSessionId: string | null`，**不再**内嵌全量 `sessions: Record<id, Session>`
  - 迁移:若旧数据含 `sessions` Record 且含 messages → 写入文件 + 建索引 + 删除内嵌
  - 常量 `DEFAULT_MAX_SESSIONS = 30`

- [ ] **Step 1: 写 SessionFileStore 失败测试**(tmp 目录)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionFileStore } from '../../../src/adapters/session-file-store';
import type { Session } from '../../../src/ports/persistence';

describe('SessionFileStore', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratel-sess-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('upsert/get - 读写单场 - 往返一致', async () => {
		const store = new SessionFileStore(dir);
		const session: Session = {
			id: 'session-1',
			title: 't',
			messages: [{ role: 'user', content: 'hi' }],
			createdAt: 1,
			updatedAt: 2,
		};
		await store.upsert(session);
		const got = await store.get('session-1');
		expect(got?.messages[0]?.content).toBe('hi');
	});

	it('delete - 删除后 get 为 null', async () => {
		const store = new SessionFileStore(dir);
		await store.upsert({
			id: 'session-1',
			title: '',
			messages: [],
			createdAt: 1,
			updatedAt: 1,
		});
		await store.delete('session-1');
		expect(await store.get('session-1')).toBeNull();
	});
});
```

- [ ] **Step 2: 实现 SessionFileStore**(mkdir `sessionsDir`；文件名 escape id；JSON 损坏 → null + devLogger)

- [ ] **Step 3: PersistenceJson 测试 — 迁移与 get 不经全量内存**

用内存 mock:

```ts
let disk: Record<string, unknown> = {};
const load = async () => disk;
const save = async (d: unknown) => {
	disk = d as Record<string, unknown>;
};
// 旧格式
disk = {
	sessions: {
		'session-old': {
			id: 'session-old',
			title: 'old',
			messages: [{ role: 'user', content: 'x' }],
			createdAt: 1,
			updatedAt: 2,
		},
	},
	notes: {},
	hookLog: [],
};
const p = new PersistenceJson(load, save, tmpPluginDir);
const s = await p.sessions.get('session-old');
expect(s?.messages[0]?.content).toBe('x');
// data.json 侧不应再保留全量 messages
const raw = disk as { sessions?: unknown; sessionIndex?: unknown };
expect(raw.sessions).toBeUndefined();
expect(Array.isArray(raw.sessionIndex)).toBe(true);
```

- [ ] **Step 4: 实现 PersistenceJson 改造 + main 注入 pluginDir**

要点:
- `persist()` 写入 `{ ...keepOtherKeysFromMerge, sessionIndex, lastSessionId, notes, hookLog }` — 见 Task 3 与 settings merge 协作；本 Task 至少 **read-merge**: `persist` 先 `loadData`，保留非 Persistence 字段(settings 扁平字段)，再写回
- `sessions.get` → SessionFileStore
- `sessions.upsert` → 写文件 + 更新 sessionIndex 行 + `enforceMaxSessions`
- 暴露 `getLastSessionId` / `setLastSessionId` 或经 Persistence 新方法 — **在 Persistence 接口增加**:

```ts
export interface Persistence {
	sessions: SessionRepository;
	notes: NoteMetaRepository;
	hooks: HookLogRepository;
	getLastSessionId(): Promise<string | null>;
	setLastSessionId(id: string | null): Promise<void>;
	listSessionIndex(limit?: number): Promise<SessionIndexEntry[]>;
}
```

- [ ] **Step 5: 测试全绿**

- [ ] **Step 6: Commit**(仅当用户要求)

---

### Task 3: `saveSettings` 与 Persistence 互不覆盖

**Files:**
- Modify: `src/main.ts` `saveSettings` / `loadSettings`
- Test: `tests/adapters/data-json-merge.test.ts`(或扩展 Task 2 测试)

**Interfaces:**
- Produces: `saveSettings` 流程 = `loadData` → 展开合并 `this.settings` 字段 → `saveData`；**不得**传入仅 settings 对象而丢掉 `sessionIndex`
- Persistence `persist` 同理保留 settings 键

- [ ] **Step 1: 写失败测试** — 模拟先 persistence.upsert 再 saveSettings，断言 sessionIndex 仍在

- [ ] **Step 2: 实现 merge 辅助**

```ts
// src/adapters/data-json-merge.ts(新建) 或内联 main
export function mergePluginData(
	existing: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	return { ...existing, ...patch };
}
```

`saveSettings`:

```ts
async saveSettings() {
	const existing = ((await this.loadData()) ?? {}) as Record<string, unknown>;
	await this.saveData(mergePluginData(existing, { ...this.settings }));
	bumpAppearance(); // 保持现有副作用
}
```

Persistence persist 侧对称 merge。

- [ ] **Step 3: 测试通过**

---

### Task 4: Hydrate `ChatMessage[]` → UI Message

**Files:**
- Create: `src/ui/chat/message-stream/hydrate-session-messages.ts`
- Test: `tests/ui/chat/message-stream/hydrate-session-messages.test.ts`
- Modify: compact 路径按需继续用精简转换；恢复会话必须用 hydrate

**Interfaces:**
- Produces: `export function hydrateSessionMessages(messages: ChatMessage[]): Message[]`

规则:
1. 跳过 `system`
2. `user` → `{ role:'user', segments:[{type:'text', text: content}] }`
3. 连续 `assistant`(可含 toolName) + 配对 `tool` 折叠进**同一条** UI assistant:`reasoning`→think；`toolName`→tool 段(done，result 从 tool.content 解析/原文)；`content` 非空→text；多工具顺序保留
4. 无 tool 的纯 assistant → think? + text

- [ ] **Step 1: 写失败测试**(至少 3 case: 纯文本；tool 一轮；reasoning+tool)

```ts
it('hydrateSessionMessages - 一轮 search_vault - 含 tool 与 text 段', () => {
	const ui = hydrateSessionMessages([
		{ role: 'user', content: 'q' },
		{
			role: 'assistant',
			content: '',
			reasoning: '想一下',
			toolCallId: 't1',
			toolName: 'search_vault',
			toolArgs: { query: 'q' },
		},
		{ role: 'tool', content: '{"hits":1}', toolCallId: 't1' },
		{ role: 'assistant', content: '答' },
	]);
	expect(ui).toHaveLength(2);
	const asst = ui[1]!;
	expect(asst.segments.some((s) => s.type === 'think')).toBe(true);
	expect(asst.segments.some((s) => s.type === 'tool')).toBe(true);
	expect(asst.segments.some((s) => s.type === 'text' && s.text === '答')).toBe(true);
});
```

- [ ] **Step 2–4: 实现并绿灯**

---

### Task 5: 切换时长辅助 + i18n

**Files:**
- Create: `src/ui/chat/session/session-transition.ts`
- Modify: `src/i18n/types.ts`、`zh.ts`、`en.ts`
- Test: `tests/ui/chat/session/session-transition.test.ts`

**Interfaces:**
- Produces:
  - `export const SESSION_EXIT_MS = 150`
  - `export const SESSION_ENTER_MS = 220`
  - `export const SESSION_LOADING_MIN_MS = 160`
  - `export function loadingPadMs(elapsedMs: number, minMs = SESSION_LOADING_MIN_MS): number`

i18n keys(须写入 types + zh + en):

- `chat.session.loading` / `chat.session.loadingNew`
- `chat.session.menuRecent` / `chat.session.new` / `chat.session.delete` / `chat.session.ariaHistory`
- `chat.session.emptyTitle` — 「新对话」
- `chat.session.loadFailed` / `chat.session.noteMissing`(若复用 cite 失败键则文档注明)

- [ ] **Step 1–4: TDD `loadingPadMs` + 加 i18n**

---

### Task 6: ChatView 续聊 + `/new` + SessionMenu + 动效

**Files:**
- Create: `src/ui/chat/session/SessionMenu.svelte`
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `styles.css`(对齐原型:`.ratel-messages-shell` / overlay / exit-enter / icon spin；`prefers-reduced-motion`)
- Modify: `src/ui/chat/input/slash-commands.ts` — `/new` 描述若需可不动

**Interfaces:**
- Consumes: Persistence `getLastSessionId` / `listSessionIndex` / `sessions.get|upsert|delete`；`hydrateSessionMessages`；`sessionHasContent`；transition 常量
- Produces: 可交互 Chat 侧栏

行为清单(对照 S-SESSION §4 + §6):

1. `onMount`: `lastSessionId` → get → hydrate → `sessionId`；无则新建 id 不落盘直到首条消息  
2. `/new` 与菜单新对话:同路径；有内容 upsert；无内容 delete；清 tool session grants；`always` Skill 按 Task 8  
3. 切换:`switching` 锁；exit 类 → overlay loading(≥ min ms) → 换 messages → enter 类；滚到顶  
4. Header 历史按钮 + SessionMenu；删除当前场则切最近或 new  
5. 关视图前 flush:`setLastSessionId` + 若脏则 upsert  

- [ ] **Step 1: 实现 SessionMenu.svelte**(props: `entries`, `currentId`, `loadingId`, `onSelect`, `onNew`, `onDelete`；i18n)

- [ ] **Step 2: ChatView 接线 + CSS**(对照 `docs/prototype/chat-ui-mockup.html`)

- [ ] **Step 3: 手动验证清单**(Obsidian 或至少 svelte 不报错)

  - 发一条消息 → 关侧栏 → 开侧栏 → 仍在  
  - `/new` → 空白；菜单能找回旧场  
  - 切换可见 loading + 动效  
  - 系统减少动态效果时仍有遮罩文案  

- [ ] **Step 4: Commit**(仅当用户要求)

---

### Task 7: 异步 LLM 短标题

**Files:**
- Create: `src/ui/chat/session/session-title.ts`
- Modify: `ChatView.svelte` 或 `main` 旁路在 `message.end` 后触发
- Test: `tests/ui/chat/session/session-title.test.ts`

**Interfaces:**
- Produces:
  - `export function fallbackSessionTitle(firstUserText: string, maxLen = 40): string`
  - `export function buildSessionTitlePrompt(firstUserText: string): string` — 中文短标题指令
  - `export async function generateSessionTitle(llm: LLMPort, firstUserText: string, signal?: AbortSignal): Promise<string>`

规则:仅当 title 为空或等于 `chat.session.emptyTitle`；不阻塞输入；切换 session 时 abort 上一次。

- [ ] **Step 1–4: TDD fallback + 接线 message.end**

---

### Task 8: ADR-012 Skill 激活写入 Session 消息

**Files:**
- Modify: `src/tools/activate-skill.ts` — 需要能拿到「写入当前 ctx 消息」的回调或 `ContextManager` 方法
- Modify: `src/core/context-manager.ts` — `appendSkillInstructions(name, body: string)` 写入带标记的 system 或 user 消息(选 **system** 且 content 前缀稳定如 `[skill:name]\n`，便于 hydrate 跳过或折叠)
- Modify: `src/core/agent-loop.ts` — 激活后改为 append 消息；**停止**依赖 `composeActive` 作为注入源；Discovery 仍 `setSkillsContext(discovery, '')` 或只设 discovery
- Modify: `src/skills/skill-registry.ts` — `activeSkills` 降为可选缓存或删除激活注入职责；`always` 在 session load/`/new` 时由 ChatView/ask 路径调用 `ensureAlwaysSkillsInjected`
- Modify: `deactivate-skill.ts` — 追加 supersede 短 system 消息
- Test: `tests/tools/activate-skill.test.ts`、`tests/core/context-manager-skills.test.ts` 更新

**Interfaces:**
- Produces: 激活后 `session.messages` 含 skill 正文；新 session 无旧 skill；`always` 每场注入一次

- [ ] **Step 1: 写测试** — activate 后 `ctx.toMessages()` 或 session.messages 含 instructions；再次 activate 同名幂等(不重复追加)

- [ ] **Step 2: 实现 ADR-012 路径**

- [ ] **Step 3: 回归 skill 相关 vitest**

- [ ] **Step 4: Commit**(仅当用户要求)

---

## 自审(对照 S-SESSION)

| Spec 节 | Task |
|---------|------|
| §3 分文件/索引/限额/迁移 | T2 |
| §3.4 settings merge | T3 |
| §4 续聊 /new 菜单切换 | T1 + T6 |
| §5 hydrate / 芯片不强制 | T4 |
| §6 动效 loading | T5 + T6 |
| §7 标题 | T7 |
| §8 ADR-012 | T8 |
| §9 错误 Notice | T2/T6(打开失败 i18n) |
| §10 成功标准 | 各 Task 验证 + T6 手动清单 |

Placeholder 扫描:无 TBD。类型:`SessionIndexEntry` / `listSessionIndex` / `hydrateSessionMessages` / transition 常量 前后一致。

---

## 执行交接

Plan 已保存到 `docs/superpowers/plans/2026-07-23-chat-session-management.md`。

**两种执行方式:**

1. **Subagent-Driven(推荐)** — 每 Task 新 subagent，两阶段审查  
2. **Inline Execution** — 本会话按 executing-plans 连续做，设检查点  

要哪种？
