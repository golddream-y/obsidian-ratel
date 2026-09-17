# P-CHAT-TIME:跨日续聊时间锚点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消息流按本地日历日插分割线，会话列表跨日显示日历日；主对话 `env` 在跨日或空闲 ≥4 小时时多一行「距上一轮用户消息」。

**Architecture:** `ChatMessage.createdAt` 可选 epoch ms，push 时缺省补 `Date.now()`；`toMessages` 出站剥离。日历与间隔纯函数在 `src/utils/chat-time.ts`。`ContextManager.refreshEnvContext` 在 `load` 之后、`addUserMessage` 之前调用，避免把本轮用户当成「上一轮」。日分割线画在 MessageList 每条逻辑消息的 first/only 单元上方，不改投影器、不做吸顶。

**Tech Stack:** TypeScript / Vitest / Svelte 5。无新 npm。

**关联文档:** [S-CHAT-TIME](../specs/2026-09-17-chat-time-anchor-design.md)

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- `env` 间隔行只给模型看，中文模板写在 `chat-time.ts` / `local-datetime.ts`，不进 i18n
- 测试 `it(...)` 中文:`行为 - 条件 - 期望结果`
- 源码注释 / 文件头中文（`@file` `@description` `@module`）
- 日历日用本地 `getFullYear/getMonth/getDate`，禁止 `Math.floor(ts/864e5)` 当地日
- 不给气泡贴 `HH:mm`、不做吸顶、不改 `AgentEvent`、不新增 injection source id
- 出站 API 消息不得带 `createdAt`
- 只链 Obsidian Sandbox；禁止 `link:vault` 日常主库；本机绝对路径不进仓库
- 提交只暂存本 task 文件清单，禁止 `git add -A`
- 工作目录：`.worktrees/feat-p-chat-time`；分支 `feat/p-chat-time`（从当前 `develop`）

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/utils/chat-time.ts` | `localYmd` / 分割线 / 列表 when / `composeEnvContext` |
| `tests/utils/chat-time.test.ts` | spec §4.5 纯函数用例 |
| `src/utils/local-datetime.ts` | 不改时间行格式；`composeEnvContext` 复用 `formatEnvContextLine` |
| `src/i18n/types.ts` `zh.ts` `en.ts` | `chat.day.*` + `chat.session.when*` |
| `src/ports/llm.ts` | `ChatMessage.createdAt?` |
| `src/core/context-manager.ts` | 打戳、剥离、`refreshEnvContext` |
| `tests/core/context-manager.test.ts` | 打戳 / 出站无字段 / 间隔行 |
| `src/core/agent-loop.ts` | load 后、addUser 前 `refreshEnvContext` |
| `src/main.ts` | 可保留时间行兜底；loop 覆盖为带间隔的 env |
| `src/prompts/defaults/zh.ts` | toolGuide 补一句 |
| `src/ui/chat/message-stream/types.ts` | UI `Message.createdAt?` |
| `src/ui/chat/message-stream/hydrate-session-messages.ts` | 拷贝 raw 时刻 |
| `tests/ui/chat/message-stream/hydrate-session-messages.test.ts` | 有/无 createdAt |
| `src/ui/chat/ChatView.svelte` | 现场气泡打戳 |
| `src/ui/chat/message-stream/MessageList.svelte` | 日分割线 |
| `src/ui/chat/session/SessionMenu.svelte` | `formatSessionWhen` |
| `docs/architecture/host/persistence.md` | 一句 createdAt |
| `docs/user-guide.md` | 一句分割线 |

## 并行波次

- **Wave 1：** Task 1 ∥ Task 2
- **Wave 2（等 Wave 1 过审）：** Task 3 ∥ Task 4 ∥ Task 5
- **Wave 3：** Task 6 文档

---

### Task 1:日历纯函数 + i18n

**Files:**
- Create: `src/utils/chat-time.ts`
- Create: `tests/utils/chat-time.test.ts`
- Modify: `src/i18n/types.ts`（`'chat.retry.now'` 后）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`（同样位置）

**Interfaces:**
- Produces: `localYmd`、`shouldShowDayDivider`、`formatDayDividerLabel`、`formatSessionWhen`、`lastUserCreatedAt`、`shouldShowEnvGap`、`formatEnvGapLine`、`composeEnvContext`、`ENV_GAP_IDLE_MS`

- [ ] **Step 1:写失败测试**

```typescript
/**
 * @file tests/utils/chat-time.test.ts
 * @description 跨日分割线 / 会话列表 / env 间隔纯函数
 * @module utils/chat-time.test
 */
import { describe, it, expect } from 'vitest';
import {
	composeEnvContext,
	formatDayDividerLabel,
	formatEnvGapLine,
	formatSessionWhen,
	lastUserCreatedAt,
	localYmd,
	shouldShowDayDivider,
	shouldShowEnvGap,
} from '../../src/utils/chat-time';

const local = (y: number, m: number, d: number, h = 12, min = 0) =>
	new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('localYmd / shouldShowDayDivider', () => {
	it('shouldShowDayDivider - curr 缺省 - 不插', () => {
		expect(shouldShowDayDivider(local(2026, 9, 16), undefined)).toBe(false);
	});

	it('shouldShowDayDivider - prev 缺省且 curr 有值 - 插', () => {
		expect(shouldShowDayDivider(undefined, local(2026, 9, 16))).toBe(true);
	});

	it('shouldShowDayDivider - 同一本地日 - 不插', () => {
		expect(shouldShowDayDivider(local(2026, 9, 16, 1), local(2026, 9, 16, 23))).toBe(false);
	});

	it('shouldShowDayDivider - 跨本地日 - 插', () => {
		expect(shouldShowDayDivider(local(2026, 9, 16, 23), local(2026, 9, 17, 0, 30))).toBe(true);
	});

	it('localYmd - 同一本地日早晚 - 年月日相同', () => {
		expect(localYmd(local(2026, 9, 16, 0, 30))).toEqual(localYmd(local(2026, 9, 16, 23, 30)));
	});
});

describe('formatDayDividerLabel', () => {
	const now = new Date(2026, 8, 17, 12, 0, 0, 0);

	it('formatDayDividerLabel - 当天 - 今天', () => {
		expect(formatDayDividerLabel(local(2026, 9, 17), now)).toEqual({ key: 'chat.day.today' });
	});

	it('formatDayDividerLabel - 昨天 - 昨天', () => {
		expect(formatDayDividerLabel(local(2026, 9, 16), now)).toEqual({ key: 'chat.day.yesterday' });
	});

	it('formatDayDividerLabel - 同年更早 - monthDay', () => {
		expect(formatDayDividerLabel(local(2026, 3, 5), now)).toEqual({
			key: 'chat.day.monthDay',
			params: { month: 3, day: 5 },
		});
	});

	it('formatDayDividerLabel - 跨年 - yearMonthDay', () => {
		expect(formatDayDividerLabel(local(2025, 12, 31), now)).toEqual({
			key: 'chat.day.yearMonthDay',
			params: { year: 2025, month: 12, day: 31 },
		});
	});
});

describe('formatSessionWhen', () => {
	const now = new Date(2026, 8, 17, 12, 0, 0, 0).getTime();

	it('formatSessionWhen - 当天 3 小时前 - hours', () => {
		expect(formatSessionWhen(now - 3 * 3600_000, now)).toEqual({
			key: 'chat.session.whenHours',
			params: { n: 3 },
		});
	});

	it('formatSessionWhen - 昨天 - yesterday', () => {
		expect(formatSessionWhen(local(2026, 9, 16, 18), now)).toEqual({ key: 'chat.day.yesterday' });
	});

	it('formatSessionWhen - 跨年 - yearMonthDay', () => {
		expect(formatSessionWhen(local(2025, 12, 1), now)).toEqual({
			key: 'chat.day.yearMonthDay',
			params: { year: 2025, month: 12, day: 1 },
		});
	});
});

describe('env gap', () => {
	const now = new Date(2026, 8, 17, 12, 0, 0, 0);

	it('composeEnvContext - 无上一轮时间戳 - 只有当前时间行', () => {
		const text = composeEnvContext(now, undefined);
		expect(text.startsWith('当前本地时间:')).toBe(true);
		expect(text.includes('距上一轮')).toBe(false);
	});

	it('shouldShowEnvGap - 同日 3 小时 - 否', () => {
		expect(shouldShowEnvGap(local(2026, 9, 17, 9), now)).toBe(false);
	});

	it('shouldShowEnvGap - 同日 5 小时 - 是', () => {
		expect(shouldShowEnvGap(local(2026, 9, 17, 7), now)).toBe(true);
	});

	it('formatEnvGapLine - 跨日 30 分钟 - 不足 1 小时', () => {
		const last = local(2026, 9, 16, 23, 30);
		const n = new Date(2026, 8, 17, 0, 0, 0, 0);
		expect(shouldShowEnvGap(last, n)).toBe(true);
		expect(formatEnvGapLine(last, n)).toContain('不足 1 小时');
		expect(formatEnvGapLine(last, n)).toContain('上次 2026-09-16 23:30');
	});

	it('formatEnvGapLine - 26 小时 50 分 - 26 小时', () => {
		const n = new Date(2026, 8, 17, 12, 0, 0, 0);
		const last = n.getTime() - (26 * 3600_000 + 50 * 60_000);
		expect(formatEnvGapLine(last, n)).toContain('26 小时');
	});

	it('lastUserCreatedAt - 从后往前找 user', () => {
		expect(
			lastUserCreatedAt([
				{ role: 'user', createdAt: 1 },
				{ role: 'assistant', createdAt: 2 },
				{ role: 'user', createdAt: 3 },
				{ role: 'assistant', createdAt: 4 },
			]),
		).toBe(3);
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/utils/chat-time.test.ts`

Expected: FAIL 无法解析模块 `chat-time`

- [ ] **Step 3:实现 + i18n**

`src/utils/chat-time.ts`：

```typescript
/**
 * @file src/utils/chat-time.ts
 * @description 跨日续聊 — 本地日历日、分割线文案、会话列表、env 间隔（S-CHAT-TIME）
 * @module utils/chat-time
 * @depends utils/local-datetime, i18n/types
 */
import type { StringKey } from '../i18n/types';
import { formatEnvContextLine, formatLocalDateTime } from './local-datetime';

export const ENV_GAP_IDLE_MS = 4 * 60 * 60 * 1000;

export type Ymd = { y: number; m: number; d: number };

export type ChatTimeLabel = { key: StringKey; params?: Record<string, string | number> };

export function localYmd(ts: number): Ymd {
	const d = new Date(ts);
	return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

function ymdEq(a: Ymd, b: Ymd): boolean {
	return a.y === b.y && a.m === b.m && a.d === b.d;
}

function startOfLocalDay(ts: number): number {
	const d = new Date(ts);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function shouldShowDayDivider(prev: number | undefined, curr: number | undefined): boolean {
	if (curr === undefined) return false;
	if (prev === undefined) return true;
	return !ymdEq(localYmd(prev), localYmd(curr));
}

export function formatDayDividerLabel(ts: number, now: Date): ChatTimeLabel {
	const nowTs = now.getTime();
	const curr = localYmd(ts);
	const today = localYmd(nowTs);
	if (ymdEq(curr, today)) return { key: 'chat.day.today' };
	const yStart = startOfLocalDay(nowTs);
	const yest = localYmd(yStart - 1);
	if (ymdEq(curr, yest)) return { key: 'chat.day.yesterday' };
	if (curr.y === today.y) {
		return { key: 'chat.day.monthDay', params: { month: curr.m, day: curr.d } };
	}
	return { key: 'chat.day.yearMonthDay', params: { year: curr.y, month: curr.m, day: curr.d } };
}

export function formatSessionWhen(updatedAt: number, nowMs: number = Date.now()): ChatTimeLabel {
	const diff = nowMs - updatedAt;
	if (ymdEq(localYmd(updatedAt), localYmd(nowMs))) {
		if (diff < 60_000) return { key: 'chat.session.whenNow' };
		if (diff < 3600_000) {
			return { key: 'chat.session.whenMinutes', params: { n: Math.floor(diff / 60_000) } };
		}
		return { key: 'chat.session.whenHours', params: { n: Math.floor(diff / 3600_000) } };
	}
	return formatDayDividerLabel(updatedAt, new Date(nowMs));
}

export function lastUserCreatedAt(
	messages: Array<{ role: string; createdAt?: number }>,
): number | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role === 'user' && typeof m.createdAt === 'number') return m.createdAt;
	}
	return undefined;
}

export function shouldShowEnvGap(lastUserAt: number, now: Date): boolean {
	if (!ymdEq(localYmd(lastUserAt), localYmd(now.getTime()))) return true;
	return now.getTime() - lastUserAt >= ENV_GAP_IDLE_MS;
}

export function formatEnvGapLine(lastUserAt: number, now: Date): string {
	const delta = Math.max(0, now.getTime() - lastUserAt);
	const hours = Math.floor(delta / 3600_000);
	const span = hours < 1 ? '不足 1 小时' : `${hours} 小时`;
	const prev = formatLocalDateTime(new Date(lastUserAt)).local.slice(0, 16);
	return `距上一轮用户消息: ${span}（上次 ${prev}）`;
}

export function composeEnvContext(now: Date, lastUserAt?: number): string {
	const line1 = formatEnvContextLine(now);
	if (lastUserAt === undefined || !shouldShowEnvGap(lastUserAt, now)) return line1;
	return `${line1}\n${formatEnvGapLine(lastUserAt, now)}`;
}
```

i18n（三文件同一组 key）：

```typescript
  'chat.day.today': '今天',           // en: 'Today'
  'chat.day.yesterday': '昨天',       // en: 'Yesterday'
  'chat.day.monthDay': '{month}月{day}日', // en: '{month}/{day}'
  'chat.day.yearMonthDay': '{year}年{month}月{day}日', // en: '{year}/{month}/{day}'
  'chat.session.whenNow': '·',
  'chat.session.whenMinutes': '{n}m',
  'chat.session.whenHours': '{n}h',
```

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/utils/chat-time.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/utils/chat-time.ts tests/utils/chat-time.test.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "$(cat <<'EOF'
feat(chat-time): 本地日历日与 env 间隔纯函数

EOF
)"
```

---

### Task 2:落盘 createdAt + 出站剥离 + refreshEnvContext

**Files:**
- Modify: `src/ports/llm.ts`（`ChatMessage` 接口）
- Modify: `src/core/context-manager.ts`（四个 push + `toMessages` + 新方法）
- Modify: `tests/core/context-manager.test.ts`

**Interfaces:**
- Consumes: `composeEnvContext`、`lastUserCreatedAt`
- Produces: `ChatMessage.createdAt?`、`refreshEnvContext(now?: Date)`、`getTranscript()` 仍含 createdAt

- [ ] **Step 1:写失败测试**

在 `tests/core/context-manager.test.ts` 的 `setEnvContext - 注入后 toMessages 含时间行` **之前**插入：

```typescript
	it('addUserMessage - 未传入 createdAt - 写入 epoch', async () => {
		const ctx = createCtx(createMockPersistence());
		await ctx.load('s-ts');
		ctx.addUserMessage('hi');
		const u = ctx.getTranscript().find((m) => m.role === 'user');
		expect(typeof u?.createdAt).toBe('number');
	});

	it('toMessages - 历史 user - 出站对象无 createdAt 键', async () => {
		const ctx = createCtx(createMockPersistence());
		await ctx.load('s-strip');
		ctx.addUserMessage('hi');
		const user = ctx.toMessages().find((m) => m.role === 'user');
		expect(user).toBeDefined();
		expect(Object.prototype.hasOwnProperty.call(user, 'createdAt')).toBe(false);
		expect(ctx.getTranscript().find((m) => m.role === 'user')?.createdAt).toEqual(expect.any(Number));
	});

	it('refreshEnvContext - 上一轮 user 跨日 - env 含距上一轮', async () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence);
		await ctx.load('s-gap');
		const yesterday = new Date(2026, 8, 16, 21, 4, 0, 0).getTime();
		ctx.addUserMessage('old');
		const raw = ctx.getTranscript().find((m) => m.role === 'user')!;
		raw.createdAt = yesterday;
		ctx.refreshEnvContext(new Date(2026, 8, 17, 12, 0, 0, 0));
		const env = ctx.toMessages().find((m) => m.role === 'system' && m.content.includes('当前本地时间'));
		expect(env?.content).toContain('距上一轮用户消息');
		expect(env?.content).toContain('上次 2026-09-16 21:04');
	});
```

若 `getTranscript` 返回浅拷贝导致改 `raw.createdAt` 无效，改为：load 后 `persistence.sessions.upsert` 一场带 `createdAt` 的旧消息再 `load` 另一 id；或给 `addUserMessage` 测完后通过 `(ctx as unknown as { session }).session.messages[0].createdAt = yesterday`。**优先：**在 `addUserMessage` 实现里允许测注入后改 transcript 浅拷贝的同一对象引用（现网 `getTranscript` 若 slice 则测里直接 upsert Session）。

若浅拷贝是新数组但元素同引用，改 `raw.createdAt` 即可。

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/core/context-manager.test.ts -t 'createdAt|refreshEnvContext|出站对象'`

Expected: FAIL

- [ ] **Step 3:最小实现**

`ChatMessage` 增加：

```typescript
	/** 写入会话时的本地墙钟 epoch ms；旧数据缺省（S-CHAT-TIME） */
	createdAt?: number;
```

`context-manager.ts`：

```typescript
function stampCreatedAt(msg: ChatMessage): ChatMessage {
	if (typeof msg.createdAt === 'number') return msg;
	return { ...msg, createdAt: Date.now() };
}

function stripCreatedAt(msg: ChatMessage): ChatMessage {
	const { createdAt: _drop, ...rest } = msg;
	return rest;
}
```

`addUserMessage` / `addAssistantMessage` / `addAssistantToolCall` / `addToolResult`：构造后 `push(stampCreatedAt(msg))`。

`toMessages` 里 `...head, ...trimmedTail` 改为 `.map(stripCreatedAt)`。`getTranscript()` 不剥。

```typescript
	/**
	 * 按当前 session 刷新 env 段（当前时间 + 条件间隔）。
	 * 必须在 load 之后、本轮 addUserMessage 之前调用。
	 */
	refreshEnvContext(now: Date = new Date()): void {
		const last = lastUserCreatedAt(this.session?.messages ?? []);
		this.envContextLine = composeEnvContext(now, last);
	}
```

import `composeEnvContext`、`lastUserCreatedAt`。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/core/context-manager.test.ts`

Expected: 原有 + 新用例 PASS

- [ ] **Step 5:Commit**

```bash
git add src/ports/llm.ts src/core/context-manager.ts tests/core/context-manager.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-time): 会话消息打 createdAt，出站剥离

EOF
)"
```

---

### Task 3:ask 路径刷新 env + 提示词

**Files:**
- Modify: `src/core/agent-loop.ts`（`await ctx.load` 之后、`addUserMessage` 之前）
- Modify: `src/main.ts`（`setEnvContext(formatEnvContextLine)` 改为同样可先写时间行；loop 会覆盖。为免双源，**删掉** ask 里那次 `setEnvContext`，只保留 loop 内 `refreshEnvContext`。）
- Modify: `src/prompts/defaults/zh.ts`（`agent.rag.toolGuide` 时间那一行后面加一句）
- Modify: `tests/core/agent-loop.test.ts`（可选一条：load 后带旧 user createdAt 时 llm.chat 的 system 含距上一轮）

**Interfaces:**
- Consumes: `ContextManager.refreshEnvContext`

- [ ] **Step 1:写失败测试**

在 `tests/core/agent-loop.test.ts` 追加：

```typescript
	it('agentLoop - 上一轮 user 跨日 - env system 含距上一轮', async () => {
		const sessions = new Map();
		const persistence = createMockPersistence(sessions);
		const yesterday = new Date(2026, 8, 16, 10, 0, 0, 0).getTime();
		sessions.set('s-gap', {
			id: 's-gap',
			title: 't',
			messages: [{ role: 'user', content: '昨天', createdAt: yesterday }],
			createdAt: yesterday,
			updatedAt: yesterday,
		});
		const ctx = new ContextManager(persistence, undefined, 8000);
		let env = '';
		const llm: LLMClient = {
			supportsImages: false,
			countTokens: () => 10,
			async *chat(req: ChatRequest) {
				env = req.messages.find((m) => m.content.includes('当前本地时间'))?.content ?? '';
				yield { text: 'ok' };
			},
		};
		for await (const _ of agentLoop(
			{ sessionId: 's-gap', message: '今天继续' },
			ctx,
			llm,
			new ToolRegistry(),
			new HookRegistry(),
		)) {
			/* drain */
		}
		expect(env).toContain('距上一轮用户消息');
	});
```

（`createMockPersistence` 若签名不接收 Map，按该文件现有工厂改成能 `upsert` 预置 session。）

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/core/agent-loop.test.ts -t '距上一轮'`

Expected: FAIL（env 只有时间行或空）

- [ ] **Step 3:接线**

`agent-loop.ts` 在 `await ctx.load(req.sessionId);` 之后立刻：

```typescript
	ctx.refreshEnvContext(new Date());
```

然后才 `addUserMessage`。

`main.ts` 删除：

```typescript
		ctx.setEnvContext(formatEnvContextLine(new Date()));
```

若删除后 `formatEnvContextLine` 无其它引用，去掉 import。

`zh.ts` toolGuide 把

`- 涉及「今天 / 本周 / 现在几点」:先看系统注入的当前本地时间;需要精确或相对日期时再调 get_datetime。`

改成两句（仍是同一 bullet 后紧跟下一 bullet）：

`- 涉及「今天 / 本周 / 现在几点」:先看系统注入的当前本地时间;需要精确或相对日期时再调 get_datetime。历史正文里的「今天」以说话当时为准;当前日只看环境时间行;是否隔天看「距上一轮」行。`

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/core/agent-loop.test.ts tests/core/context-manager.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/core/agent-loop.ts src/main.ts src/prompts/defaults/zh.ts tests/core/agent-loop.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-time): load 后刷新 env 间隔行

EOF
)"
```

---

### Task 4:hydrate + 现场气泡 + 日分割线

**Files:**
- Modify: `src/ui/chat/message-stream/types.ts`
- Modify: `src/ui/chat/message-stream/hydrate-session-messages.ts`
- Modify: `tests/ui/chat/message-stream/hydrate-session-messages.test.ts`
- Modify: `src/ui/chat/ChatView.svelte`（push user/assistant 时 `createdAt: Date.now()`）
- Modify: `src/ui/chat/message-stream/MessageList.svelte`

**Interfaces:**
- Consumes: `shouldShowDayDivider`、`formatDayDividerLabel`
- Produces: UI `Message.createdAt?`；first/only 单元上方日线

- [ ] **Step 1:写失败测试**

```typescript
	it('hydrateSessionMessages - user 带 createdAt - UI 消息保留', async () => {
		const ts = 1_700_000_000_000;
		const ui = await hydrateSessionMessages([
			{ role: 'user', content: 'hi', createdAt: ts },
			{ role: 'assistant', content: 'hello', createdAt: ts + 1 },
		]);
		expect(ui[0]!.createdAt).toBe(ts);
		expect(ui[1]!.createdAt).toBe(ts + 1);
	});

	it('hydrateSessionMessages - 缺 createdAt - 不抛且字段缺省', async () => {
		const ui = await hydrateSessionMessages([{ role: 'user', content: 'hi' }]);
		expect(ui[0]!.createdAt).toBeUndefined();
	});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/ui/chat/message-stream/hydrate-session-messages.test.ts -t 'createdAt'`

Expected: FAIL

- [ ] **Step 3:实现**

`Message` 增加 `createdAt?: number`。

hydrate user 分支：`...(typeof m.createdAt === 'number' ? { createdAt: m.createdAt } : {})`。

assistant 组：在 `const start = i` 处记下 `messages[start]!.createdAt`，push UI 时同样展开。

ChatView 两处 `messages.push` user / 空 assistant 加上 `createdAt: Date.now()`。

MessageList script 增加：

```typescript
	import { formatDayDividerLabel, shouldShowDayDivider } from '../../../utils/chat-time';

	function prevChatCreatedAt(index: number): number | undefined {
		for (let i = index - 1; i >= 0; i--) {
			const m = messages[i]!;
			if (m.role === 'compact') continue;
			return m.createdAt;
		}
		return undefined;
	}

	function dayDividerLabel(msg: Message): { key: StringKey; params?: Record<string, string | number> } | null {
		if (msg.role === 'compact') return null;
		const idx = messages.findIndex((m) => m.id === msg.id);
		if (idx < 0) return null;
		if (!shouldShowDayDivider(prevChatCreatedAt(idx), msg.createdAt)) return null;
		return formatDayDividerLabel(msg.createdAt!, new Date());
	}
```

模板在 `MessageBubble` 前（`unit.kind === 'message'` 且 `position` 为 `only` 或 `first`）：

```svelte
{#if unit.kind !== 'compact'}
  {@const day = (unit.position === 'only' || unit.position === 'first') ? dayDividerLabel(unit.msg) : null}
  {#if day}
    <div class="ratel-day-divider">{$t(day.key, day.params)}</div>
  {/if}
  <MessageBubble ... />
{/if}
```

（若 `{@const}` 在现网 Svelte 版本不顺，改成 `{#if}` 里直接调 `dayDividerLabel`。）

CSS 可复用 compact 分割线尺寸，class 名 `ratel-day-divider`：居中、11px、`--text-faint`、上下 1px border。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/ui/chat/message-stream/hydrate-session-messages.test.ts tests/utils/chat-time.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/ui/chat/message-stream/types.ts src/ui/chat/message-stream/hydrate-session-messages.ts tests/ui/chat/message-stream/hydrate-session-messages.test.ts src/ui/chat/ChatView.svelte src/ui/chat/message-stream/MessageList.svelte
git commit -m "$(cat <<'EOF'
feat(chat-time): 消息流按本地日插入分割线

EOF
)"
```

---

### Task 5:会话列表日历日

**Files:**
- Modify: `src/ui/chat/session/SessionMenu.svelte`

**Interfaces:**
- Consumes: `formatSessionWhen`

- [ ] **Step 1:把 formatWhen 换成纯函数（无独立测试文件则依赖 Task 1 已覆盖 formatSessionWhen）**

删除组件内 `formatWhen`。模板：

```svelte
<div class="ratel-session-when">
  {@const when = formatSessionWhen(e.updatedAt)}
  {$t(when.key, when.params)}
</div>
```

import `formatSessionWhen` from `../../../utils/chat-time`。

- [ ] **Step 2:Commit**

```bash
git add src/ui/chat/session/SessionMenu.svelte
git commit -m "$(cat <<'EOF'
feat(chat-time): 会话列表跨日显示日历日

EOF
)"
```

（本 task 无新失败测试：日历分支已在 Task 1。审查看模板是否走 `$t`。）

---

### Task 6:文档一句

**Files:**
- Modify: `docs/architecture/host/persistence.md`（§2.2 后加一小段，不新开节层级超过现有）
- Modify: `docs/user-guide.md`（§4 多场会话表下或 §11 Header 子弹后）

- [ ] **Step 1:补文**

persistence.md 在 2.2 段落后：

```markdown
会话正文 `sessions/<id>.json` 的 `messages[]` 条目可带可选 `createdAt`（epoch ms，本地墙钟）。缺省视为旧数据，不回填。该字段只用于 UI 日分割线与 env「距上一轮」；出站给模型 API 时剥离。
```

user-guide.md §4 后加一句：

```markdown
跨了自然日的对话，消息流里会插入「今天 / 昨天 / 某月某日」分割线；历史列表超过当天也显示日历日，不再只写 `2d`。
```

- [ ] **Step 2:Commit**

```bash
git add docs/architecture/host/persistence.md docs/user-guide.md docs/superpowers/STATUS.md
git commit -m "$(cat <<'EOF'
docs(chat-time): 补持久化字段与 user-guide 分割线说明

EOF
)"
```

STATUS：本 plan 已在登记；本 task 若 STATUS 仍写 Pending 则改为 Completed 仅在**全部 task 完成后**由收尾做，此处不要提前改 Completed。

---

## 自审

**1. Spec coverage**

| spec | task |
|---|---|
| §4.1 createdAt 打戳 / 旧数据 / 出站剥离 | T2 |
| §4.1 UI Message hydrate / 现场气泡 | T4 |
| §4.2 日分割线纯函数 + i18n | T1 + T4 |
| compact 不参与比较 | T4 `prevChatCreatedAt` 跳过 compact |
| §4.3 会话列表 | T1 + T5 |
| §4.4 env 两行、4h、跨日不足 1 小时 | T1 + T2 + T3 |
| load 后 addUser 前刷新 | T3 |
| 提示词一句 | T3 |
| §4.5 测试清单 | T1/T2/T3/T4 |
| persistence / user-guide | T6 |
| 非目标：HH:mm、吸顶、新 injection id、AgentEvent | 无 task |

**2. Placeholder scan:** 无 TBD。agent-loop 预置 session 工厂按该文件现有 `createMockPersistence` 改，实现者对照文件头，不另造 persistence。

**3. Type consistency:** `ChatTimeLabel` / `composeEnvContext` / `refreshEnvContext(now?: Date)` / `Message.createdAt` 全程同名。
