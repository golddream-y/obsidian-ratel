# P-LLM-RETRY-UI:打字行网络重试提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主对话 `ask` 路径上，`wrapLlmChatRetry` 退避/再发时，`.ratel-typing` 换成 `connecting` 球 + 三条重试文案；yield / 失败 / 停止立即清掉。标题、压缩、分类器不驱动这条行。

**Architecture:** 可选回调挂在 `ChatRequest.onRetryWait`（适配器忽略）。包装器只在退避前、再发前、以及所有出口调用。ChatView 本地倒计时（约 250ms），MessageList 在 `retryWait != null` 时覆盖 busyKind。不新增 AgentEvent、不改 StatusStrip、不进设置页。

**Tech Stack:** TypeScript / Vitest / Svelte 5。无新 npm。thinking-orbs 九态已移植，只用现成 `connecting`。

**关联文档:** [S-LLM-RETRY-UI](../specs/2026-09-11-llm-retry-status-design.md)；策略 [S-LLM-RETRY](../specs/2026-09-09-llm-chat-retry.md)

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- 测试 `it(...)` 中文:`行为 - 条件 - 期望结果`
- 源码注释 / 文件头中文（`@file` `@description` `@module`）
- 不改重试次数、间隔、可恢复判定；不进设置页
- 不新增 thinking-orbs 动画或 npm 包
- 不改 `AgentEvent` 判别联合、消息持久化、架构文档
- 不给 StatusStrip / Drawer / Notice / 空助手气泡加「再试一次」
- 秒数按 spec §4.5 用例：`remainingMs < 1000` → soon；否则 `Math.floor(remainingMs / 1000)`（1500ms → 1）。不用 ceil（会得到 2，与用例冲突）
- 只链 Obsidian Sandbox；`npm run link:vault` 禁止日常主库
- 提交只暂存本 task 文件清单，禁止 `git add -A`
- 工作目录:当前仓库；分支 `feat/p-llm-retry-ui`

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ports/llm.ts` | `LlmRetryWait` + `ChatRequest.onRetryWait` |
| `src/core/llm-retry-wait.ts` | 文案 key 纯函数 |
| `src/core/llm-retry-wait.test.ts` | 500ms / 1500ms / request 用例 |
| `src/core/llm-chat-retry.ts` | 退避前后与出口回调 |
| `src/core/llm-chat-retry.test.ts` | 回调序列与 abort 清 null |
| `src/ui/orbs/map-orb-state.ts` | `retry` → `connecting` |
| `tests/ui/orbs/map-orb-state.test.ts` | 映射断言 |
| `src/i18n/types.ts` `zh.ts` `en.ts` | `chat.retry.soon` / `after` / `now` |
| `src/types.ts` | `UserChatRequest.onRetryWait` |
| `src/core/agent-loop.ts` | 把回调抄进 `llm.chat` |
| `tests/core/agent-loop.test.ts` | 断言 chat 收到同一回调 |
| `src/main.ts` | `ask` opts 透传 |
| `src/ui/chat/ChatView.svelte` | `$state` + 倒计时 + 传 MessageList |
| `src/ui/chat/message-stream/MessageList.svelte` | 覆盖球与文案 |

---

### Task 1:类型、文案纯函数、i18n

**Files:**
- Modify: `src/ports/llm.ts`（`ChatRequest` 后）
- Create: `src/core/llm-retry-wait.ts`
- Create: `src/core/llm-retry-wait.test.ts`
- Modify: `src/i18n/types.ts`（`ChatStrings`，`'chat.typing'` 后）
- Modify: `src/i18n/zh.ts` / `src/i18n/en.ts`（同样位置）

**Interfaces:**
- Produces: `LlmRetryWait`、`retryWaitLabel(wait, remainingMs)`

- [ ] **Step 1:写失败测试**

```typescript
/**
 * @file src/core/llm-retry-wait.test.ts
 * @description 重试打字行文案 key — 剩余毫秒到 i18n
 * @module core/llm-retry-wait.test
 */

import { describe, it, expect } from 'vitest';
import { retryWaitLabel } from './llm-retry-wait';

describe('retryWaitLabel', () => {
	const backoff = { phase: 'backoff' as const, attempt: 2, maxAttempts: 3, delayMs: 1500 };

	it('retryWaitLabel - 退避剩余不足 1 秒 - 即将重试', () => {
		expect(retryWaitLabel(backoff, 500)).toEqual({
			key: 'chat.retry.soon',
			params: { attempt: 2, max: 3 },
		});
	});

	it('retryWaitLabel - 退避刚开始 1500ms - 1 秒后重试', () => {
		expect(retryWaitLabel(backoff, 1500)).toEqual({
			key: 'chat.retry.after',
			params: { attempt: 2, max: 3, seconds: 1 },
		});
	});

	it('retryWaitLabel - request 相位 - 正在重试', () => {
		expect(
			retryWaitLabel({ phase: 'request', attempt: 2, maxAttempts: 3 }, 0),
		).toEqual({
			key: 'chat.retry.now',
			params: { attempt: 2, max: 3 },
		});
	});

	it('retryWaitLabel - 退避剩余落到 0 - 当作正在重试', () => {
		expect(retryWaitLabel(backoff, 0)).toEqual({
			key: 'chat.retry.now',
			params: { attempt: 2, max: 3 },
		});
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run src/core/llm-retry-wait.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3:最小实现**

在 `src/ports/llm.ts` 的 `ChatRequest` 上增加（`signal` 旁）：

```typescript
	/**
	 * 主对话打字行重试提示（S-LLM-RETRY-UI）。适配器忽略。
	 * 仅 wrapLlmChatRetry 调用；标题/压缩/分类器不传。
	 */
	onRetryWait?: (state: LlmRetryWait | null) => void;
```

同文件、`ChatRequest` 之前：

```typescript
/**
 * 单次 chat() 的重试等待态。attempt 为即将进行或正在进行的尝试，1-based。
 */
export type LlmRetryWait =
	| { phase: 'backoff'; attempt: number; maxAttempts: number; delayMs: number }
	| { phase: 'request'; attempt: number; maxAttempts: number };
```

`src/core/llm-retry-wait.ts`：

```typescript
/**
 * @file src/core/llm-retry-wait.ts
 * @description 重试打字行 — 把等待态折成 i18n key（不含翻译表）
 * @module core/llm-retry-wait
 * @depends ports/llm
 */

import type { LlmRetryWait } from '../ports/llm';

export type RetryWaitLabel = {
	key: 'chat.retry.soon' | 'chat.retry.after' | 'chat.retry.now';
	params: { attempt: number; max: number; seconds?: number };
};

/**
 * 打字行文案。退避剩余落到 0 时先显示「正在重试」，即使 request 回调晚一帧。
 *
 * @param wait - 包装器回调
 * @param remainingMs - ChatView 本地倒计时；request 相位忽略
 */
export function retryWaitLabel(wait: LlmRetryWait, remainingMs: number): RetryWaitLabel {
	const params = { attempt: wait.attempt, max: wait.maxAttempts };
	if (wait.phase === 'request' || remainingMs <= 0) {
		return { key: 'chat.retry.now', params };
	}
	if (remainingMs < 1000) {
		return { key: 'chat.retry.soon', params };
	}
	return {
		key: 'chat.retry.after',
		params: { ...params, seconds: Math.floor(remainingMs / 1000) },
	};
}
```

i18n（三种语言表同一组 key，插在 `'chat.typing'` 后）：

- zh: `'即将重试（{attempt}/{max}）'` / `'网络不稳，{seconds} 秒后重试（{attempt}/{max}）'` / `'网络不稳，正在重试（{attempt}/{max}）'`
- en: `'About to retry ({attempt}/{max})'` / `'Unstable network, retrying in {seconds}s ({attempt}/{max})'` / `'Unstable network, retrying ({attempt}/{max})'`
- types: 三个 `string` 字段

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run src/core/llm-retry-wait.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/ports/llm.ts src/core/llm-retry-wait.ts src/core/llm-retry-wait.test.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat: 重试打字行文案 key 与 ChatRequest 回调类型"
```

---

### Task 2:包装器回调序列

**Files:**
- Modify: `src/core/llm-chat-retry.ts`
- Modify: `src/core/llm-chat-retry.test.ts`

**Interfaces:**
- Consumes: `ChatRequest.onRetryWait`、`LlmRetryWait`
- Produces: 退避前 `backoff`、睡醒再发前 `request`、yield/结束/抛错/abort 时 `null`

- [ ] **Step 1:在现有 describe('wrapLlmChatRetry') 追加失败测试**

```typescript
	it('onRetryWait - 第二次成功 yield - 序列 backoff request null', async () => {
		vi.useFakeTimers();
		const inner = fakeLlm(['503', 'ok']);
		const wrapped = wrapLlmChatRetry(inner);
		const seq: unknown[] = [];
		const pending = collect(
			wrapped.chat({
				messages: [],
				onRetryWait: (s) => {
					seq.push(s);
				},
			}),
		);
		await vi.runAllTimersAsync();
		await expect(pending).resolves.toEqual([{ text: 'ok' }]);
		expect(seq).toEqual([
			{ phase: 'backoff', attempt: 2, maxAttempts: 3, delayMs: 500 },
			{ phase: 'request', attempt: 2, maxAttempts: 3 },
			null,
		]);
	});

	it('onRetryWait - 退避中 abort - 收到 null 且不再请求', async () => {
		vi.useFakeTimers();
		const inner = fakeLlm(['503', 'ok']);
		const wrapped = wrapLlmChatRetry(inner);
		const seq: unknown[] = [];
		const ac = new AbortController();
		const pending = collect(
			wrapped.chat({
				messages: [],
				signal: ac.signal,
				onRetryWait: (s) => {
					seq.push(s);
				},
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		ac.abort();
		await expect(pending).rejects.toThrow(/请求已取消/);
		expect(inner.calls).toBe(1);
		expect(seq[seq.length - 1]).toBe(null);
		expect(seq.some((s) => s && typeof s === 'object' && (s as { phase: string }).phase === 'request')).toBe(false);
	});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run src/core/llm-chat-retry.test.ts`

Expected: FAIL（回调未调用）

- [ ] **Step 3:改 wrapLlmChatRetry.chat**

保持 `isRetryableLlmFailure` / 延迟公式不变。循环改为：

1. `attempt > 0` 时先 `onRetryWait({ phase: 'request', attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS })`
2. `inner.chat`；第一次 `yield` 之前若尚未清过，对调用方 yield 前调用 `onRetryWait(null)`
3. 正常耗尽流：再 `onRetryWait(null)` 后 `return`
4. catch：不可恢复或最后一次 → `onRetryWait(null)` 后 `throw`
5. 可恢复：`onRetryWait({ phase: 'backoff', attempt: attempt + 2, maxAttempts: MAX_ATTEMPTS, delayMs: retryDelayMs(...) })`，再 `sleepMs`；sleep 因 abort 拒绝时 `onRetryWait(null)` 后把错误抛出
6. 函数所有出口都要清掉（可用内层 try/finally 兜底 `null`，但不要在仍处于 backoff 等待时提前清）

`onRetryWait` 缺省则什么都不做。不要改判定表。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run src/core/llm-chat-retry.test.ts`

Expected: PASS（含原有 503×2 / abort / yield-then-fail）

- [ ] **Step 5:Commit**

```bash
git add src/core/llm-chat-retry.ts src/core/llm-chat-retry.test.ts
git commit -m "feat: wrapLlmChatRetry 在退避与再发时通知打字行"
```

---

### Task 3:retry 映射 connecting

**Files:**
- Modify: `src/ui/orbs/map-orb-state.ts`
- Modify: `tests/ui/orbs/map-orb-state.test.ts`

**Interfaces:**
- Produces: `RatelOrbBusyKind` 增加 `'retry'`；`mapOrbState('retry') === 'connecting'`

- [ ] **Step 1:写失败测试**

在 `describe('mapOrbState')` 增加：

```typescript
	it('mapOrbState - retry - 映射为 connecting', () => {
		expect(mapOrbState('retry')).toBe('connecting');
	});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/ui/orbs/map-orb-state.test.ts`

Expected: FAIL（类型 / 落到 breathing）

- [ ] **Step 3:最小实现**

`RatelOrbBusyKind` 增加 `'retry'`。`switch` 增加 `case 'retry': return 'connecting';`（可与 `index` 共用 return，但不要删 `index` 分支）。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/ui/orbs/map-orb-state.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/ui/orbs/map-orb-state.ts tests/ui/orbs/map-orb-state.test.ts
git commit -m "feat: 打字行 retry 忙态映射 connecting 球"
```

---

### Task 4:ask 透传到打字行

**Files:**
- Modify: `src/types.ts`（`UserChatRequest`）
- Modify: `src/core/agent-loop.ts`（`llm.chat({...})`）
- Modify: `tests/core/agent-loop.test.ts`
- Modify: `src/main.ts`（`ask` 的 `opts` 与 `agentLoop` 入参）
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `src/ui/chat/message-stream/MessageList.svelte`

**Interfaces:**
- Consumes: `onRetryWait`、`retryWaitLabel`、`mapOrbState('retry')`
- Produces: 仅 ChatView 主循环传入回调；`classifyIntent` / compact / 标题不传

- [ ] **Step 1:agent-loop 转发测试（失败）**

在 `tests/core/agent-loop.test.ts` 增加：改 `createMockLLM` 为记录最后一次 `ChatRequest`（或包一层 spy）。新用例：

```typescript
	it('agentLoop - UserChatRequest.onRetryWait - 原样传给 llm.chat', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence, undefined, 8000);
		const cb = () => {};
		let seen: ChatRequest | undefined;
		const llm: LLMClient = {
			supportsImages: false,
			countTokens: () => 10,
			async *chat(req: ChatRequest) {
				seen = req;
				yield { text: 'ok' };
			},
		};
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();
		for await (const _ of agentLoop(
			{ sessionId: 's1', message: 'Hi', onRetryWait: cb },
			ctx,
			llm,
			tools,
			hooks,
		)) {
			/* drain */
		}
		expect(seen?.onRetryWait).toBe(cb);
	});
```

若现网 `createMockLLM` 缺 `supportsImages`，本用例自带完整 `LLMClient`，不要借机大改 mock。

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/core/agent-loop.test.ts -t 'onRetryWait'`

Expected: FAIL（`seen?.onRetryWait` 为 undefined）

- [ ] **Step 3:接线**

1. `UserChatRequest` 增加可选 `onRetryWait?: (state: LlmRetryWait | null) => void`（从 `ports/llm` 引类型）。
2. `agentLoop` 里 `llm.chat({ ..., signal, onRetryWait: req.onRetryWait })`。
3. `main.ts` `ask` 的 `opts` 增加 `onRetryWait?`，构造 `{ sessionId, message, attachments, modelMessage, onRetryWait: opts?.onRetryWait }`。
4. `ChatView.svelte`：
   - `let retryWait = $state<LlmRetryWait | null>(null);`
   - `let retryRemainingMs = $state(0);`
   - backoff 时用收到回调的时刻 + `delayMs`，`window.setInterval` 约 250ms 更新剩余；切 `request` / `null` 时清 timer。
   - `plugin.ask(..., { ..., onRetryWait })`；`finally` 里再清 `null` 与 timer。
   - 传给 MessageList：`retryWait`、`retryRemainingMs`。
5. `MessageList.svelte`：
   - 可选 props 默认 `null` / `0`。
   - `showBusyOrb && retryWait != null` 时 `busyKind = 'retry'`。
   - 文案：`retryWaitLabel(retryWait, retryRemainingMs)` 再 `$t(key, params)`，不要用 `ORB_LABEL[connecting]`（那是「连接中…」）。
6. 不要改 `workBar` 在 `isRunning` 返回 `null` 的现网逻辑。不要给 StatusStrip 加文案。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/core/agent-loop.test.ts src/core/llm-chat-retry.test.ts src/core/llm-retry-wait.test.ts tests/ui/orbs/map-orb-state.test.ts`

Expected: PASS。不要求 Svelte 测倒计时动画。

- [ ] **Step 5:Commit**

```bash
git add src/types.ts src/core/agent-loop.ts tests/core/agent-loop.test.ts src/main.ts src/ui/chat/ChatView.svelte src/ui/chat/message-stream/MessageList.svelte
git commit -m "feat: 主对话打字行显示网络重试 connecting 提示"
```

---

## 自审

**1. Spec coverage:** §2.1 ask 路径 + 清态 → Task 2/4；§2.3 标题压缩分类器不传回调 → Task 4 只挂 ask；§2.4 停止仍 abort sleep → 现网 sleepMs + Task 2 abort 用例；§4.2 回调形状 → Task 1/2；§4.3 文案与 0 剩余 → Task 1；§4.4 不进 Strip → Task 4 不改 workBar；§4.5 测试清单 → Task 1/2/3。

**2. Placeholder scan:** 无 TBD。秒数争议已钉死 floor。

**3. Type consistency:** `LlmRetryWait` 只在 `ports/llm.ts` 声明；`retryWaitLabel` 的 key 与 i18n 三字段同名。
