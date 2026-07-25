# P-CHAT-UI-V3-1 — Conversation-first 布局骨架

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Chat 侧栏从「消息夹层运维台」改成 Conversation-first：StatusStrip 沉入 composer 顶沿、Header 去 %/tone、work-bar 合并进 Strip、Drawer 精简并加上下文 meter 渐变。

**Architecture:** 不改 Agent Loop / 消息协议 / Worker。抽出纯函数 `composeStripLabel` / `contextPctTextColor` 做 TDD；`StatusLine.svelte` 扩 props（上下文 %、busyOverride）但不强制改文件名；`ChatView.svelte` 重排 DOM 为 Header → Messages → `.ratel-composer(Strip → Drawer → Input)`；删除 `.ratel-work-bar`。

**Tech Stack:** Svelte 5 / TypeScript / Vitest / 现有 i18n / Obsidian CSS 变量

## Global Constraints

- 严格对照 [S-CHAT-UI-V3](../specs/2026-07-16-chat-ui-v3-conversation-first.md) §5.1–5.3、§5.7–5.8、§5.10–5.11（**不含** Trace / 引用芯片 / 一体输入框抛光 — 那些是 P2–P4）
- 用户可见新字符串必须走 i18n（`zh.ts` + `en.ts` + `types.ts`）
- 禁止紫→蓝 / 彩虹渐变；meter 用 `--ratel-meter-from` / `--ratel-meter-to`
- Drawer 不回潮「可在设置启用 Worker」类文案；删除运行模式行
- 测试描述中文：`行为 - 条件 - 期望结果`
- 文件头 / 导出函数按 AGENTS.md 注释规范
- 不引入 Web font；圆角 ≤12

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/status/strip-label.ts` | **新建** — `composeStripLabel` + `contextPctTextColor` |
| `tests/ui/status/strip-label.test.ts` | **新建** — 纯函数单测 |
| `src/ui/status/StatusLine.svelte` | Strip：右侧 %、busyOverride、更薄皮肤 |
| `src/ui/status/StatusDrawer.svelte` | 删运行模式；上下文 meter 渐变；索引进度纯色 warning；`embedKind` prop |
| `src/ui/status/tone.ts` | 仅更新文件头注释（Header 不再消费 tone 修饰） |
| `src/ui/chat/ChatView.svelte` | DOM 重排 + Header 精简 + work-bar 删除 + composer 壳 |
| `src/i18n/{types,zh,en}.ts` | `chat.header.tagline` + Embedding 本地/API 标签 |
| `docs/user-guide.md` | §9 状态怎么读 — 对齐新布局 |

**本 plan 不改：** ToolSegment / ThinkSegment / SearchResults / SlashMenu 皮肤 / Markdown `[n]` 挂钩（P2–P3）。

---

### Task 1: Strip 文案与 % 色阶纯函数

**Files:**
- Create: `src/ui/status/strip-label.ts`
- Create: `tests/ui/status/strip-label.test.ts`

**Interfaces:**
- Produces:
  - `composeStripLabel(opts: { busyOverride: string | null; toneLabel: string; chatBusy: boolean; tone: Tone }): string`
  - `contextPctTextColor(percentage: number): string` — 返回 CSS 变量字符串

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/status/strip-label.test.ts
 * @description StatusStrip 文案合成与上下文 % 色阶
 * @module tests/ui/status/strip-label
 */
import { describe, it, expect } from 'vitest';
import { composeStripLabel, contextPctTextColor } from '../../../src/ui/status/strip-label';

describe('composeStripLabel', () => {
	it('busyOverride 优先 - 有 override - 返回 override', () => {
		expect(
			composeStripLabel({
				busyOverride: '索引中...',
				toneLabel: '就绪',
				chatBusy: false,
				tone: 'ready',
			}),
		).toBe('索引中...');
	});

	it('chatBusy 压制思考 - tone=thinking 且无 override - 返回 toneLabel 调用方已压制后的就绪文案', () => {
		// 关键路径:压制在 StatusLine 内先做,本函数只在无 override 时透传 toneLabel
		expect(
			composeStripLabel({
				busyOverride: null,
				toneLabel: '就绪',
				chatBusy: true,
				tone: 'ready',
			}),
		).toBe('就绪');
	});

	it('无 override - 透传 toneLabel', () => {
		expect(
			composeStripLabel({
				busyOverride: null,
				toneLabel: '思考中',
				chatBusy: false,
				tone: 'thinking',
			}),
		).toBe('思考中');
	});
});

describe('contextPctTextColor', () => {
	it('色阶 - <80 - success', () => {
		expect(contextPctTextColor(12)).toBe('var(--text-success)');
		expect(contextPctTextColor(79)).toBe('var(--text-success)');
	});

	it('色阶 - ≥80 且 <95 - warning', () => {
		expect(contextPctTextColor(80)).toBe('var(--text-warning)');
		expect(contextPctTextColor(94)).toBe('var(--text-warning)');
	});

	it('色阶 - ≥95 - error', () => {
		expect(contextPctTextColor(95)).toBe('var(--text-error)');
		expect(contextPctTextColor(100)).toBe('var(--text-error)');
	});
});
```

- [ ] **Step 2: 跑测确认失败**

```bash
npx vitest run tests/ui/status/strip-label.test.ts
```

Expected: FAIL — 模块不存在

- [ ] **Step 3: 最小实现**

```typescript
/**
 * @file src/ui/status/strip-label.ts
 * @description StatusStrip 文案合成与上下文百分比文字色
 * @module ui/status/strip-label
 * @depends ./tone
 */
import type { Tone } from './tone';

export interface ComposeStripLabelOpts {
	/** work-bar 合并后的忙态文案;硬 gate 文案也走此字段 */
	busyOverride: string | null;
	/** deriveTone + i18n 得到的默认文案(含 chatBusy 压制后) */
	toneLabel: string;
	chatBusy: boolean;
	tone: Tone;
}

/**
 * 合成 StatusStrip 主文案。
 *
 * 优先级:busyOverride > toneLabel。
 * chatBusy / tone 保留在签名里供调用方语义对齐与后续扩展,本函数当前不二次压制。
 */
export function composeStripLabel(opts: ComposeStripLabelOpts): string {
	if (opts.busyOverride) return opts.busyOverride;
	return opts.toneLabel;
}

/**
 * 上下文占用百分比的文字色(Strip 右侧 mono %)。
 * 阈值与旧 Header 胶囊一致:≥95 error / ≥80 warning / 否则 success。
 */
export function contextPctTextColor(percentage: number): string {
	if (percentage >= 95) return 'var(--text-error)';
	if (percentage >= 80) return 'var(--text-warning)';
	return 'var(--text-success)';
}
```

- [ ] **Step 4: 跑测确认通过**

```bash
npx vitest run tests/ui/status/strip-label.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/status/strip-label.ts tests/ui/status/strip-label.test.ts
git commit -m "$(cat <<'EOF'
feat(chat-ui): StatusStrip 文案与 % 色阶纯函数

EOF
)"
```

---

### Task 2: StatusLine 扩为 Strip（% + busyOverride）

**Files:**
- Modify: `src/ui/status/StatusLine.svelte`
- Modify: `src/ui/status/tone.ts`（仅注释）

**Interfaces:**
- Consumes: `composeStripLabel`、`contextPctTextColor`、`ContextUsage` store
- Produces: props `contextUsage$: Readable<ContextUsage>`、`busyOverride?: string | null`

- [ ] **Step 1: 更新 `tone.ts` 文件头注释**

将「Header badge 与 StatusLine 共用」改为「StatusStrip 点色与忙态派生；Header model chip 不再消费 tone 修饰类」。`deriveTone` 实现**不动**。

- [ ] **Step 2: 改 `StatusLine.svelte` props 与模板**

在现有 props 上增加：

```typescript
import type { ContextUsage } from '../../user-feedback/user-status';
import { composeStripLabel, contextPctTextColor } from './strip-label';

let {
	status$,
	contextUsage$,
	expanded = false,
	onToggle,
	chatBusy = false,
	busyOverride = null,
}: {
	status$: Readable<UserStatusSnapshot>;
	contextUsage$: Readable<ContextUsage>;
	expanded: boolean;
	onToggle: () => void;
	chatBusy?: boolean;
	busyOverride?: string | null;
} = $props();

const usage = $derived($contextUsage$);
const pct = $derived(Math.min(usage.percentage, 100));
const pctColor = $derived(contextPctTextColor(usage.percentage));

// state 计算保持现有 chatBusy 压制 thinking → ready 逻辑
const label = $derived(
	composeStripLabel({
		busyOverride,
		toneLabel: state.label,
		chatBusy,
		tone: state.tone,
	}),
);
```

模板改为（布局 `点 | 文案 | spacer | % | ▲`）：

```svelte
<div
	class="ratel-status-line"
	onclick={onToggle}
	role="button"
	aria-expanded={expanded}
	aria-label={expanded ? $t('status.drawer.collapse') : $t('status.drawer.expand')}
>
	<span class="ratel-sl-dot" class:ratel-sl-dot-ready={...} ...></span>
	<span class="ratel-sl-text" ...>{label}</span>
	<span class="ratel-sl-pct" style={`color: ${pctColor}`}>{pct}%</span>
	<span class="ratel-sl-arrow">▲</span>
</div>
```

**点色规则补充:** 当 `busyOverride` 非空且非 hard 类错误时，点应呈 busy（thinking/indexing 脉冲）。实现：若 `busyOverride` 且 `state.tone === 'ready'`，点用 `ratel-sl-dot-thinking`（因 work-bar 忙态可能尚未反映进 deriveTone，如 compacting）。

```typescript
const dotBusy = $derived(
	state.tone === 'thinking' ||
		state.tone === 'indexing' ||
		(!!busyOverride && state.tone !== 'error' && state.tone !== 'unconfigured'),
);
```

- [ ] **Step 3: 调整 CSS 为更薄 strip**

- 高度 `30px` → `26px`
- `border-top` 保留（composer 内顶沿分隔）
- `.ratel-sl-pct`：`margin-left: auto; font-family: var(--font-monospace); font-size: 11px; font-weight: 600;`
- `.ratel-sl-arrow`：去掉原来的 `margin-left: auto`（改由 pct 顶到右侧，arrow 紧跟 pct，gap 6–8）

- [ ] **Step 4: 更新文件头 `@description`**

改为：`composer 顶沿 StatusStrip — 点 + 文案 + 上下文% + 展开`

- [ ] **Step 5: Commit**

```bash
git add src/ui/status/StatusLine.svelte src/ui/status/tone.ts
git commit -m "$(cat <<'EOF'
feat(chat-ui): StatusLine 承载 % 与 busyOverride

EOF
)"
```

---

### Task 3: StatusDrawer 精简 + 上下文 meter 渐变

**Files:**
- Modify: `src/ui/status/StatusDrawer.svelte`
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

**Interfaces:**
- Consumes: `embedKind: 'local' | 'api'`（由 ChatView 传入 `plugin.settings.embedProvider`）
- Produces: Drawer 无运行模式行；上下文区有 used/max + 渐变 meter + 压缩按钮

- [ ] **Step 1: 加 i18n key**

在 `types.ts` / `zh.ts` / `en.ts` 增加（放在 `status.drawer.*` 附近）：

| key | zh | en |
|---|---|---|
| `status.drawer.label.embedKind` | Embedding 类型 | Embedding type |
| `status.drawer.embedKind.local` | 本地 | Local |
| `status.drawer.embedKind.api` | API | API |
| `chat.header.tagline` | 图谱原生 | graph-native |

（`chat.header.tagline` 本 Task 一并加，供 Task 4 Header 使用。）

- [ ] **Step 2: Drawer props + 模板**

新增 prop：

```typescript
embedKind: 'local' | 'api';
```

**删除整行：**

```svelte
<div class="ratel-drawer-row">
  <span class="ratel-drawer-label">{$t('status.drawer.label.workerMode')}</span>
  ...
</div>
```

**Embedding 行：** 保留状态 `labelEmbedding(snap.embedding)`；其下新增：

```svelte
<div class="ratel-drawer-row">
	<span class="ratel-drawer-label">{$t('status.drawer.label.embedKind')}</span>
	<span class="ratel-drawer-value">
		{embedKind === 'api' ? $t('status.drawer.embedKind.api') : $t('status.drawer.embedKind.local')}
	</span>
</div>
```

**上下文区**在 used/max 行之后、压缩按钮之前插入 meter：

```svelte
<div
	class="ratel-drawer-meter"
	role="progressbar"
	aria-valuenow={Math.min(usage.percentage, 100)}
	aria-valuemin={0}
	aria-valuemax={100}
>
	<div
		class="ratel-drawer-meter-fill"
		style={`width: ${Math.min(usage.percentage, 100)}%;`}
	></div>
</div>
```

**索引进度条**（已有）：保持 `background: ${indexBarColor}` 纯色；**不要**用铜绿渐变（spec §5.7.2）。

- [ ] **Step 3: meter CSS**

```css
.ratel-drawer-meter {
	width: 100%;
	height: 4px;
	background: var(--background-modifier-border);
	border-radius: 2px;
	overflow: hidden;
	margin: 6px 0 4px;
}

.ratel-drawer-meter-fill {
	height: 100%;
	border-radius: 2px;
	/* 关键路径:默认不改渐变随阈值变红,阈值只作用 Strip 文字(spec §5.7.1) */
	background: linear-gradient(
		90deg,
		var(--ratel-meter-from, var(--interactive-accent)) 0%,
		var(--ratel-meter-to, var(--text-success)) 100%
	);
	transition: width 0.35s ease;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/ui/status/StatusDrawer.svelte src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "$(cat <<'EOF'
feat(chat-ui): Drawer 精简并加上下文 meter 渐变

EOF
)"
```

---

### Task 4: ChatView 布局重排 + Header + 删 work-bar

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `docs/user-guide.md`（§9）

**Interfaces:**
- Consumes: Task 2/3 新 props；既有 `workBar` derived → 改为 `busyOverride`
- Produces: DOM `Header → Messages → .ratel-composer(StatusLine → StatusDrawer → .ratel-input)`

- [ ] **Step 1: 改 Header 模板**

替换现 Header 为：

```svelte
<div class="ratel-header">
	<div class="ratel-header-left">
		<div class="ratel-header-brand">
			<span class="ratel-header-title">{$t('chat.header.title')}</span>
			<span class="ratel-header-tagline">{$t('chat.header.tagline')}</span>
		</div>
	</div>
	<div class="ratel-header-right">
		<button
			type="button"
			class="ratel-header-model"
			onclick={() => new ModelInfoModal(plugin.app, plugin).open()}
			aria-label={$t('chat.header.title')}
		>{modelName}</button>
	</div>
</div>
```

**删除：** `ratel-header-logo`、`ratel-header-ctx`、所有 `ratel-header-badge--*` / `headerTone` / `headerCtxColor` / `headerPct` / `deriveTone` 在 ChatView 内的 Header 用途。

- [ ] **Step 2: 从 workBar 派生 busyOverride**

保留现有 `workBar` derived 逻辑；在模板外增加：

```typescript
const busyOverride = $derived(workBar ? workBar.text : null);
```

硬 gate：`workBar.type === 'hard'` 时 Strip 仍显示 `workBar.text`（原 work-bar 黄条文案），Send 禁用逻辑不变。

- [ ] **Step 3: 重排底部 DOM**

删除消息与输入之间的独立 StatusLine/Drawer 挂载。改为：

```svelte
<div class="ratel-messages-wrap">
	<MessageList ... />
</div>

<div class="ratel-composer">
	<StatusLine
		status$={statusStore}
		contextUsage$={contextStore}
		expanded={drawerExpanded}
		chatBusy={isRunning}
		busyOverride={busyOverride}
		onToggle={() => (drawerExpanded = !drawerExpanded)}
	/>
	<StatusDrawer
		expanded={drawerExpanded}
		status$={statusStore}
		contextUsage$={contextStore}
		embedKind={plugin.settings.embedProvider}
		onCompact={handleCompact}
	/>
	<div class="ratel-input">
		<!-- AttachmentStrip / MentionStrip / menus / textarea / Send|Stop 保持原样 -->
		<!-- 删除整个 {#if workBar} ... .ratel-work-bar 块 -->
	</div>
</div>
```

- [ ] **Step 4: CSS**

在 `.ratel-chat` 上定义：

```css
.ratel-chat {
	/* ...existing... */
	--ratel-meter-from: var(--interactive-accent);
	--ratel-meter-to: var(--text-success);
}

.ratel-composer {
	flex-shrink: 0;
	display: flex;
	flex-direction: column;
	border-top: 1px solid var(--background-modifier-border);
}

.ratel-header-brand {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

.ratel-header-tagline {
	font-size: 10px;
	font-weight: 500;
	color: var(--text-muted);
	letter-spacing: 0.02em;
}

.ratel-header-model {
	font-size: 11px;
	font-family: var(--font-monospace);
	padding: 2px 9px;
	border-radius: 8px;
	border: 1px solid var(--background-modifier-border);
	background: color-mix(in srgb, var(--background-secondary) 80%, transparent);
	color: var(--text-muted);
	cursor: pointer;
	max-width: 180px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.ratel-header-model:hover {
	color: var(--text-normal);
	border-color: var(--interactive-accent);
}
```

**删除：** `.ratel-header-logo`、`.ratel-header-ctx`、`.ratel-header-badge*`、`@keyframes ratel-header-pulse`、整块 `.ratel-work-bar` / `.ratel-work-*` 样式。

**调整：** `.ratel-input` 的 `border-top` 若与 composer 重复，改为无顶边或更轻分隔（避免双线）。StatusLine 在 composer 内时可去掉 StatusLine 自己的 `border-top`，改由 composer 外边框承担 — 二选一，目视一条线即可。

- [ ] **Step 5: 清理 ChatView script 无用 import**

若 `deriveTone` 仅用于 Header，从 ChatView 删除 import。

- [ ] **Step 6: 更新 `docs/user-guide.md` §9**

改为：

```markdown
## 9. 状态怎么读

- **输入区顶沿 StatusStrip**：状态点 + 就绪/忙态文案 + 右侧上下文占用 `%`（绿 → 黄 → 红）
- **点开 Strip**：抽屉里看索引篇数、Embedding 类型、上下文 used/max 与进度条、压缩按钮
- **Header**：模型名（点击查看模型信息）；不再显示占用百分比

未配置 API Key 或索引未就绪时，发送会被挡住并在 Strip 提示原因。
```

- [ ] **Step 7: 构建与冒烟测**

```bash
npm run build
npx vitest run tests/ui/status/
```

Expected: build 成功；tone + strip-label 全绿。

手动冒烟（Sandbox vault）：

1. 打开侧栏：消息区与输入之间**无**常驻夹层条；Strip 在输入框上方  
2. Header 无 %、无脉冲；有 tagline；点模型 chip 开 Modal  
3. 展开 Drawer：无「运行模式」；有上下文渐变 meter；索引 processing 时进度条为 warning 纯色  
4. 触发索引 / 未配置 Key：Strip 显示原 work-bar 文案；无独立黄条  
5. 发送消息：对话中 Strip 不叠第二条「思考中」（chatBusy 压制仍在）

- [ ] **Step 8: Commit**

```bash
git add src/ui/chat/ChatView.svelte docs/user-guide.md
git commit -m "$(cat <<'EOF'
feat(chat-ui): Conversation-first 布局 — Strip 入 composer

EOF
)"
```

---

## 自审

### Spec 覆盖（P1 范围）

| Spec 项 | Task |
|---|---|
| §5.1 Status 不得夹在消息与输入之间 | Task 4 |
| §5.2 Header 去 %/tone；model chip | Task 4 |
| §5.3 Strip 点+文案+%+chevron | Task 2 |
| §5.3 Drawer 索引/上下文精简、删运行模式 | Task 3 |
| §5.7 meter 渐变 + Strip % 阈值文字色 | Task 1–3 |
| §5.7.2 索引进度纯色 warning | Task 3 |
| §5.8 work-bar 合并 | Task 4 |
| §5.11 tagline i18n | Task 3–4 |
| user-guide 状态说明 | Task 4 |

**明确不在本 plan：** §5.4 Trace、§5.5 引用、§5.6 Slash/Mention 皮肤、§5.9 一体输入框（P2–P4）。

### 占位符扫描

无 TBD /「类似 Task N」/ 空测试步骤。

### 类型一致性

- `busyOverride: string | null`（Task 1–4 一致）
- `embedKind: 'local' | 'api'`（与 `settings.embedProvider` 同形）
- `contextUsage$` 类型为既有 `Readable<ContextUsage>`

---

## 执行交接

Plan 完成后可选：

1. **Subagent-Driven（推荐）** — 每 Task 新 subagent + 两阶段审查  
2. **Inline Execution** — 本会话按 executing-plans 连续做，设检查点  

**分支建议：** `feat/p-chat-ui-v3-1`（执行前用 using-git-worktrees 隔离）。
