# P-CHAT-NAV — 对话进度轨 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消息区细进度轨：阅读拇指 + 离底回底 + 点刻度跳 user 轮次 + 左右吸附持久化。

**Architecture:** 纯函数算锚点/抽稀/拇指比例；`Message.id` 作 DOM 锚点；`ChatNavRail.svelte` 叠在消息区包裹层；滚动仍走现有 `.ratel-messages` + sticky-to-bottom。与 StatusStrip 上下文 `%` 解耦。

**Tech Stack:** TypeScript / Svelte 5 / Obsidian Plugin / Vitest / i18n

**Spec:** [S-CHAT-NAV](../specs/2026-08-11-chat-nav-rail-design.md)

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- 测试 `it(...)` 中文：`行为 - 条件 - 期望结果`
- 文件头 / 导出按 AGENTS.md 中文注释
- **不改** Agent Loop、Session 落盘协议、工具权限
- 轨上文案用「对话位置」，**不**显示 token 占用 `%`，避免与 Strip 混淆
- 只左右吸附，不自由像素拖放
- 不做完整 Outline / 键盘 Alt+J/K / 压缩绑定

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/chat/nav/chat-nav-rail.ts` | **新建** — 锚点提取、摘要、抽稀、needsRail、thumbRatio |
| `tests/ui/chat/nav/chat-nav-rail.test.ts` | **新建** — 纯函数单测 |
| `src/ui/chat/message-stream/types.ts` | `Message.id: string` |
| `src/ui/chat/message-stream/new-message-id.ts` | **新建** — `newMessageId()` |
| `src/ui/chat/message-stream/hydrate-session-messages.ts` | hydrate 时为每条 UI Message 赋 id |
| `src/ui/chat/ChatView.svelte` | 发送时赋 id；包裹层；接线轨；回底强制滚；跳转+高亮 |
| `src/ui/chat/message-stream/MessageList.svelte` | 透传 highlightId（可选）或靠 DOM `data-msg-id` |
| `src/ui/chat/message-stream/MessageBubble.svelte` | `data-msg-id` + 高亮 class |
| `src/ui/chat/nav/ChatNavRail.svelte` | **新建** — 轨 UI |
| `src/settings.ts` | `chatNavRailEnabled` / `chatNavRailSide` + 设置项 |
| `src/i18n/{types,zh,en}.ts` | nav + settings 文案 |
| `styles.css` | 必要时压 Obsidian button（回底钮） |
| `docs/user-guide.md` | 对话位置轨说明 |
| `CHANGELOG.md` | `[Unreleased]` |
| `docs/superpowers/STATUS.md` | P-CHAT-NAV |

---

### Task 1: 纯函数 — 锚点 / 抽稀 / 比例（TDD）

**Files:**
- Create: `src/ui/chat/nav/chat-nav-rail.ts`
- Create: `tests/ui/chat/nav/chat-nav-rail.test.ts`

**Interfaces:**
- Produces:
  - `export interface ChatNavAnchor { id: string; summary: string; index: number }`
  - `export const CHAT_NAV_TICK_CAP = 12`
  - `export function textFromMessage(msg: { segments: Array<{ type: string; text?: string }> }): string`
  - `export function summarizeNavText(text: string, maxChars?: number): string` — 默认 24
  - `export function extractUserAnchors(messages: Array<{ id: string; role: string; segments: ... }>): ChatNavAnchor[]`
  - `export function thinAnchors(anchors: ChatNavAnchor[], visibleId: string | null, cap?: number): ChatNavAnchor[]`
  - `export function needsRail(scrollHeight: number, clientHeight: number, epsilon?: number): boolean`
  - `export function thumbRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number` — 钳制 [0,1]

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/chat/nav/chat-nav-rail.test.ts
 * @description 对话进度轨纯函数
 * @module tests/ui/chat/nav/chat-nav-rail
 */
import { describe, it, expect } from 'vitest';
import {
	CHAT_NAV_TICK_CAP,
	extractUserAnchors,
	thinAnchors,
	needsRail,
	thumbRatio,
	summarizeNavText,
} from '../../../../src/ui/chat/nav/chat-nav-rail';

function msg(id: string, role: 'user' | 'assistant', text: string) {
	return { id, role, segments: [{ type: 'text' as const, text }] };
}

describe('summarizeNavText', () => {
	it('summarizeNavText - 超长 - 截断到 maxChars', () => {
		expect(summarizeNavText('一二三四五六七八九十一二三四五六七八九十', 24).length).toBeLessThanOrEqual(24);
	});
});

describe('extractUserAnchors', () => {
	it('extractUserAnchors - 空列表 - 空数组', () => {
		expect(extractUserAnchors([])).toEqual([]);
	});

	it('extractUserAnchors - 仅 assistant - 空数组', () => {
		expect(extractUserAnchors([msg('a1', 'assistant', 'hi')])).toEqual([]);
	});

	it('extractUserAnchors - 交错 user - 只收 user 且带 summary', () => {
		const a = extractUserAnchors([
			msg('u1', 'user', '第一问'),
			msg('a1', 'assistant', '答'),
			msg('u2', 'user', '第二问很长很长很长很长很长很长很长'),
		]);
		expect(a.map((x) => x.id)).toEqual(['u1', 'u2']);
		expect(a[0]!.summary).toContain('第一问');
		expect(a[0]!.index).toBe(0);
		expect(a[1]!.index).toBe(2);
	});
});

describe('thinAnchors', () => {
	it('thinAnchors - 不超过 cap - 原样', () => {
		const anchors = Array.from({ length: 5 }, (_, i) => ({
			id: `u${i}`,
			summary: `q${i}`,
			index: i,
		}));
		expect(thinAnchors(anchors, null, 12)).toHaveLength(5);
	});

	it('thinAnchors - 超过 cap - 含首尾与 visible', () => {
		const anchors = Array.from({ length: 20 }, (_, i) => ({
			id: `u${i}`,
			summary: `q${i}`,
			index: i * 2,
		}));
		const thinned = thinAnchors(anchors, 'u10', CHAT_NAV_TICK_CAP);
		expect(thinned.length).toBeLessThanOrEqual(CHAT_NAV_TICK_CAP);
		expect(thinned[0]!.id).toBe('u0');
		expect(thinned[thinned.length - 1]!.id).toBe('u19');
		expect(thinned.some((x) => x.id === 'u10')).toBe(true);
	});
});

describe('needsRail / thumbRatio', () => {
	it('needsRail - 内容不高过视口 - false', () => {
		expect(needsRail(100, 100)).toBe(false);
		expect(needsRail(100, 120)).toBe(false);
	});

	it('needsRail - 可滚动 - true', () => {
		expect(needsRail(500, 200)).toBe(true);
	});

	it('thumbRatio - 顶/底/中 - 钳制', () => {
		expect(thumbRatio(0, 500, 200)).toBe(0);
		expect(thumbRatio(300, 500, 200)).toBe(1);
		expect(thumbRatio(150, 500, 200)).toBeCloseTo(0.5);
		expect(thumbRatio(-10, 500, 200)).toBe(0);
	});

	it('thumbRatio - scrollHeight<=clientHeight - 0', () => {
		expect(thumbRatio(0, 100, 100)).toBe(0);
	});
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/ui/chat/nav/chat-nav-rail.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```typescript
/**
 * @file src/ui/chat/nav/chat-nav-rail.ts
 * @description 对话进度轨纯函数 — 锚点、抽稀、拇指比例
 * @module ui/chat/nav/chat-nav-rail
 */

export interface ChatNavAnchor {
	id: string;
	summary: string;
	/** 在 messages 数组中的下标 */
	index: number;
}

export const CHAT_NAV_TICK_CAP = 12;

type Seg = { type: string; text?: string };
type MsgLike = { id: string; role: string; segments: Seg[] };

/**
 * 从消息 segments 拼出纯文本（仅 text 段）。
 */
export function textFromMessage(msg: { segments: Seg[] }): string {
	return msg.segments
		.filter((s) => s.type === 'text' && typeof s.text === 'string')
		.map((s) => s.text!.trim())
		.filter(Boolean)
		.join(' ');
}

/**
 * 刻度悬停摘要 — 压空白并截断。
 */
export function summarizeNavText(text: string, maxChars = 24): string {
	const t = text.replace(/\s+/g, ' ').trim();
	if (t.length <= maxChars) return t;
	return t.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/**
 * 提取 user 轮次锚点（按 messages 顺序）。
 */
export function extractUserAnchors(messages: MsgLike[]): ChatNavAnchor[] {
	const out: ChatNavAnchor[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i]!;
		if (m.role !== 'user') continue;
		out.push({
			id: m.id,
			summary: summarizeNavText(textFromMessage(m)),
			index: i,
		});
	}
	return out;
}

/**
 * 刻度过多时抽稀：必留首、尾；若有 visibleId 则留它及其邻域；其余均匀取样至 cap。
 */
export function thinAnchors(
	anchors: ChatNavAnchor[],
	visibleId: string | null,
	cap: number = CHAT_NAV_TICK_CAP,
): ChatNavAnchor[] {
	if (anchors.length <= cap) return anchors.slice();
	const byId = new Map(anchors.map((a) => [a.id, a]));
	const keep = new Set<string>();
	keep.add(anchors[0]!.id);
	keep.add(anchors[anchors.length - 1]!.id);
	if (visibleId && byId.has(visibleId)) {
		const vi = anchors.findIndex((a) => a.id === visibleId);
		for (let d = -1; d <= 1; d++) {
			const a = anchors[vi + d];
			if (a) keep.add(a.id);
		}
	}
	// 均匀填满剩余名额
	const step = (anchors.length - 1) / Math.max(1, cap - 1);
	for (let i = 0; i < cap && keep.size < cap; i++) {
		const idx = Math.round(i * step);
		keep.add(anchors[Math.min(anchors.length - 1, idx)]!.id);
	}
	return anchors.filter((a) => keep.has(a.id)).slice(0, cap);
}

/**
 * 内容高度不足以滚动时不显示轨。
 */
export function needsRail(scrollHeight: number, clientHeight: number, epsilon = 8): boolean {
	return scrollHeight > clientHeight + epsilon;
}

/**
 * 拇指比例 [0,1]；不可滚动时为 0。
 */
export function thumbRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number {
	const max = scrollHeight - clientHeight;
	if (max <= 0) return 0;
	const r = scrollTop / max;
	return Math.min(1, Math.max(0, r));
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run tests/ui/chat/nav/chat-nav-rail.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/chat/nav/chat-nav-rail.ts tests/ui/chat/nav/chat-nav-rail.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-nav): 进度轨锚点与比例纯函数

为 S-CHAT-NAV 提供 extract/thin/needsRail/thumbRatio。
EOF
)"
```

---

### Task 2: Message.id — 类型 + hydrate + 发送赋 id

**Files:**
- Create: `src/ui/chat/message-stream/new-message-id.ts`
- Modify: `src/ui/chat/message-stream/types.ts`
- Modify: `src/ui/chat/message-stream/hydrate-session-messages.ts`
- Modify: `src/ui/chat/ChatView.svelte`（仅 push message 处加 id）
- Modify: `src/ui/chat/message-stream/MessageBubble.svelte`（`data-msg-id={msg.id}`）
- Modify: 既有 hydrate 相关测试（若断言完整对象形状）

**Interfaces:**
- Consumes: Task 1 无硬依赖；为 Task 4 提供 `msg.id`
- Produces:
  - `Message.id: string`（必填）
  - `export function newMessageId(): string`

- [ ] **Step 1: 加 id 工厂与类型**

`new-message-id.ts`:

```typescript
/**
 * @file src/ui/chat/message-stream/new-message-id.ts
 * @description UI Message 稳定 id（会话内锚点，不必落盘）
 * @module ui/chat/message-stream/new-message-id
 */

/** 生成会话内消息 id；优先 crypto.randomUUID。 */
export function newMessageId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `m-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
```

`types.ts` 的 `Message` 增加：

```typescript
export interface Message {
	/** 会话内稳定锚点（hydrate/发送时生成，不要求写入 Session 落盘） */
	id: string;
	role: 'user' | 'assistant';
	// ...其余不变
}
```

- [ ] **Step 2: hydrate 赋 id**

在 `hydrate-session-messages.ts` 每个 `out.push({...})` 加 `id: newMessageId()`（user 与 assistant 两处）。

- [ ] **Step 3: ChatView 发送路径赋 id**

找到 `messages.push({ role: 'user' ...})` 与 `messages.push({ role: 'assistant' ...})`，写入 `id: newMessageId()`。  
全局搜其它构造 UI `Message` 的路径一并补上（如 compact 后重 hydrate 已走 hydrate）。

- [ ] **Step 4: Bubble 锚点**

`MessageBubble.svelte` 根节点增加：

```svelte
data-msg-id={msg.id}
class:ratel-msg-nav-flash={/* 由 prop 或父级 class 控制，见 Task 4；本 Task 可先只加 data-msg-id */}
```

本 Task 至少落地 `data-msg-id={msg.id}`。高亮 class 可在 Task 4 接 `highlightId` prop。

- [ ] **Step 5: 跑相关测试 + build**

Run:

```bash
npx vitest run tests/ui/chat/message-stream tests/ui/chat/nav 2>&1 | tail -40
node esbuild.config.mjs production
```

Expected: 测试 PASS；build exit 0。若 hydrate 测试因缺 `id` 失败，在期望对象中补 `id: expect.any(String)` 或生成逻辑。

- [ ] **Step 6: Commit**

```bash
git add src/ui/chat/message-stream/new-message-id.ts \
  src/ui/chat/message-stream/types.ts \
  src/ui/chat/message-stream/hydrate-session-messages.ts \
  src/ui/chat/message-stream/MessageBubble.svelte \
  src/ui/chat/ChatView.svelte \
  tests/
git commit -m "$(cat <<'EOF'
feat(chat): UI Message 增加会话内 id 锚点

供对话进度轨跳转与高亮；hydrate/发送时生成。
EOF
)"
```

---

### Task 3: settings + i18n

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

**Interfaces:**
- Produces:
  - `chatNavRailEnabled: boolean` 默认 `true`
  - `chatNavRailSide: 'left' | 'right'` 默认 `'right'`
  - 设置项挂在 `settings.appearance.heading` 分组之后或同组末尾（外观/聊天呈现）

- [ ] **Step 1: 接口与默认值**

在 `RatelVaultSettings` 增加：

```typescript
chatNavRailEnabled: boolean;
chatNavRailSide: 'left' | 'right';
```

`DEFAULT_SETTINGS`:

```typescript
chatNavRailEnabled: true,
chatNavRailSide: 'right',
```

- [ ] **Step 2: i18n keys**

`types.ts` / `zh.ts` / `en.ts` 同步：

| Key | zh | en |
|---|---|---|
| `chat.nav.rail.aria` | 对话位置 | Conversation position |
| `chat.nav.backToBottom` | 回到底部 | Back to bottom |
| `chat.nav.tick.aria` | 跳到：{summary} | Jump to: {summary} |
| `settings.chatNavRailEnabled.name` | 对话位置轨 | Conversation position rail |
| `settings.chatNavRailEnabled.desc` | 在消息区显示阅读位置与回到底部 | Show reading position and back-to-bottom in the message list |
| `settings.chatNavRailSide.name` | 位置轨靠边 | Rail side |
| `settings.chatNavRailSide.desc` | 吸附在消息区左侧或右侧 | Snap to the left or right of the message list |
| `settings.chatNavRailSide.left` | 左侧 | Left |
| `settings.chatNavRailSide.right` | 右侧 | Right |

- [ ] **Step 3: 设置页控件**

在 appearance 相关 `defs` 数组末尾（或 chat 呈现分组）增加：

```typescript
{
  name: tNow('settings.chatNavRailEnabled.name'),
  desc: tNow('settings.chatNavRailEnabled.desc'),
  control: { type: 'toggle', key: 'chatNavRailEnabled' },
},
{
  name: tNow('settings.chatNavRailSide.name'),
  desc: tNow('settings.chatNavRailSide.desc'),
  control: {
    type: 'dropdown',
    key: 'chatNavRailSide',
    options: {
      left: tNow('settings.chatNavRailSide.left'),
      right: tNow('settings.chatNavRailSide.right'),
    },
  },
},
```

`setControlValue` 对 `chatNavRailSide` 校验 `'left'|'right'`（仿 `toolPermissionLevel`）。

- [ ] **Step 4: 跑 settings 测试（若有）+ build**

Run: `npx vitest run tests/settings.declarative.test.ts tests/settings-migration.test.ts`  
Expected: PASS（无迁移逻辑；新字段走默认）

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "$(cat <<'EOF'
feat(settings): 对话位置轨开关与左右侧

chatNavRailEnabled / chatNavRailSide 默认开、靠右。
EOF
)"
```

---

### Task 4: ChatNavRail 组件 + ChatView 接线

**Files:**
- Create: `src/ui/chat/nav/ChatNavRail.svelte`
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `src/ui/chat/message-stream/MessageList.svelte`（可选透传 `highlightId`）
- Modify: `src/ui/chat/message-stream/MessageBubble.svelte`（高亮 class）
- Modify: `styles.css`（若回底钮被 Obsidian 撑高）

**Interfaces:**
- Consumes: Task 1 纯函数；Task 2 `msg.id` / `data-msg-id`；Task 3 settings
- Produces: 可验收的进度轨 UI

- [ ] **Step 1: MessageBubble 高亮**

```svelte
let {
  msg,
  isLast,
  isRunning,
  onOpenPath,
  navFlash = false,
}: {
  // ...
  navFlash?: boolean;
} = $props();
```

根节点：`class:ratel-msg-nav-flash={navFlash}`  

样式（scoped）：

```css
.ratel-msg-nav-flash {
  outline: 1px solid color-mix(in srgb, var(--interactive-accent) 55%, transparent);
  background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
  transition: background 0.35s ease, outline-color 0.35s ease;
}
```

MessageList：增加 `highlightId: string | null`，传 `navFlash={msg.id === highlightId}`。

- [ ] **Step 2: 实现 ChatNavRail.svelte**

Props：

```typescript
let {
  enabled,
  side,
  anchors,       // ChatNavAnchor[] 已抽稀
  ratio,         // 0..1
  showBackToBottom,
  onJump,        // (id: string) => void
  onBackToBottom,
  onSideChange,  // (side: 'left' | 'right') => void
  onThumbSeek,   // (ratio: number) => void  — 拖拇指
}: { ... } = $props();
```

结构要点：

- 根：`class="ratel-chat-nav"` + `data-side={side}` + `aria-label={$t('chat.nav.rail.aria')}`
- 轨道条 + 拇指（`top: ratio * 100%`）
- 刻度按钮：`aria-label={$t('chat.nav.tick.aria', { summary })}` `title={summary}` `onclick → onJump(id)`
- 回底：`{#if showBackToBottom}` button `↓`，`aria-label={$t('chat.nav.backToBottom')}`
- 左右拖：在轨上 `pointerdown` 记录 startX；`pointermove` 若越过包裹层中线则 `onSideChange`；用 `setPointerCapture`
- `enabled === false` 时组件可不挂载（由父决定）

视觉：轨宽 3–4px，热区 padding 使可点宽度约 14px；`position: absolute; top: 8px; bottom: 8px;`；`right: 2px` 或 `left: 2px`；`z-index` 低于 slash 浮层、高于消息。

- [ ] **Step 3: ChatView 接线**

1. 消息区外包一层：

```svelte
<div class="ratel-messages-wrap" bind:this={messagesWrapEl}>
  <MessageList ... highlightId={navHighlightId} />
  {#if railVisible}
    <ChatNavRail
      enabled={$settingsStore.chatNavRailEnabled}
      side={$settingsStore.chatNavRailSide ?? 'right'}
      anchors={navAnchorsThinned}
      ratio={navRatio}
      showBackToBottom={!isUserNearBottom}
      onJump={jumpToMessage}
      onBackToBottom={forceScrollToBottom}
      onSideChange={setNavSide}
      onThumbSeek={seekByRatio}
    />
  {/if}
</div>
```

2. 状态与派生：

```typescript
let navHighlightId = $state<string | null>(null);
let navRatio = $state(0);
let navFlashTimer: ReturnType<typeof setTimeout> | null = null;

const navEnabled = $derived($settingsStore.chatNavRailEnabled !== false);
const rawAnchors = $derived(
  extractUserAnchors(messages.filter((m) => !!m.id) as Array<{ id: string; role: string; segments: Message['segments'] }>),
);
// visibleId：可用靠近视口中线的 user id；首版可用 null 或第一条可见 — 简单做法：null，thin 仍保首尾
const navAnchorsThinned = $derived(thinAnchors(rawAnchors, navHighlightId, CHAT_NAV_TICK_CAP));

let railVisible = $state(false);

function updateNavMetrics(el: HTMLDivElement) {
  railVisible = navEnabled && needsRail(el.scrollHeight, el.clientHeight);
  navRatio = thumbRatio(el.scrollTop, el.scrollHeight, el.clientHeight);
}

function handleScroll(el: HTMLDivElement) {
  isUserNearBottom =
    el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_THRESHOLD;
  updateNavMetrics(el);
}

function forceScrollToBottom() {
  isUserNearBottom = true;
  requestAnimationFrame(() => {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function seekByRatio(r: number) {
  if (!messagesEl) return;
  const max = messagesEl.scrollHeight - messagesEl.clientHeight;
  if (max <= 0) return;
  messagesEl.scrollTop = Math.min(1, Math.max(0, r)) * max;
}

function jumpToMessage(id: string) {
  const node = messagesEl?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`) as HTMLElement | null;
  if (!node) return;
  node.scrollIntoView({ block: 'start', behavior: 'smooth' });
  navHighlightId = id;
  if (navFlashTimer) clearTimeout(navFlashTimer);
  navFlashTimer = setTimeout(() => {
    navHighlightId = null;
    navFlashTimer = null;
  }, 1000);
}

async function setNavSide(side: 'left' | 'right') {
  plugin.settings.chatNavRailSide = side;
  await plugin.saveSettings();
}
```

3. CSS：`.ratel-messages-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }`；内层 `.ratel-messages` 仍 `flex: 1; overflow-y: auto`。

4. `messages` / 尺寸变化：在 `$effect` 里当 `messagesEl` 存在时 `updateNavMetrics(messagesEl)`（含发送后内容变高）。

- [ ] **Step 4: build 冒烟**

Run: `node esbuild.config.mjs production`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/ui/chat/nav/ChatNavRail.svelte \
  src/ui/chat/ChatView.svelte \
  src/ui/chat/message-stream/MessageList.svelte \
  src/ui/chat/message-stream/MessageBubble.svelte \
  styles.css
git commit -m "$(cat <<'EOF'
feat(ui): 对话位置轨 — 回底、跳轮次、左右吸附

对齐 S-CHAT-NAV P1 细轨方案。
EOF
)"
```

---

### Task 5: user-guide + CHANGELOG + STATUS

**Files:**
- Modify: `docs/user-guide.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: user-guide**

在「状态怎么读」或聊天 UI 节增加：

```markdown
### 对话位置轨

消息区右侧（可改到左侧）细轨表示当前读到哪里：点刻度跳到对应提问，离开底部时点 ↓ 回到最新。设置里可关闭。与状态条上的上下文占用 % 不是同一回事。
```

- [ ] **Step 2: CHANGELOG `[Unreleased]`**

```markdown
### Added
- **对话位置轨** — 消息区可读进度、跳到某轮提问、离开底部一键回底；可左右吸附或在设置中关闭
```

- [ ] **Step 3: STATUS**

将 `P-CHAT-NAV` 标为 ✅ Completed（执行结束时）；本 plan 登记时先 ⏳ Pending → 执行中 🔄 In Progress。

- [ ] **Step 4: Commit**

```bash
git add docs/user-guide.md CHANGELOG.md docs/superpowers/STATUS.md
git commit -m "docs: S-CHAT-NAV 用户说明与 CHANGELOG"
```

---

## 自审（对照 spec）

| Spec 项 | Task |
|---|---|
| 细轨 + 拇指比例 | Task 1 + 4 |
| user 刻度跳转 + 高亮 | Task 2 + 4 |
| 离底回底 | Task 4 |
| 左右吸附持久化 | Task 3 + 4 |
| 不可滚动隐藏 / 开关 | Task 1 needsRail + Task 3/4 |
| 刻度抽稀 cap=12 | Task 1 |
| 与 Strip % 解耦 | Global + Task 4 文案 |
| i18n | Task 3 |
| user-guide / CHANGELOG | Task 5 |
| 非目标未纳入 | 无 Outline / 无自由拖 / 无键盘 |

**占位符扫描：** 无 TBD。  
**类型一致：** `ChatNavAnchor` / `chatNavRailSide` / `newMessageId` 全 plan 统一。
