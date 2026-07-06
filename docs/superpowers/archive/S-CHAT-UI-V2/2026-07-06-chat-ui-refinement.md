# Chat UI 打磨与交互体验优化 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 Chat UI 做系统化打磨 — Header 重构(badge 变色+百分比胶囊)、StatusLine 简化、Input 下方新增 work 条、抽屉上下文区精简、样式合规化(圆角/box-shadow/class 前缀)。

**Architecture:** 纯 UI 层改造,不改业务逻辑。tone 计算逻辑提取为共享模块 `src/ui/status/tone.ts`,Header 与 StatusLine 共用。所有新字符串走 i18n。所有样式遵守硬约束:圆角 ≤8px、禁 box-shadow、`ratel-` 前缀。

**Tech Stack:** Svelte 5($state/$derived/$props)、TypeScript strict、vitest、esbuild。

**Spec:** [S-CHAT-UI-V2](../specs/2026-07-06-chat-ui-refinement-design.md)

**测试基线:** 652 passed / 0 failed(实施前)。实施后应保持 652 passed + 新增 10 个 tone 测试 = 662 passed。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/ui/status/tone.ts` | 新建 | 共享 `deriveTone(snapshot)` 函数,Header 与 StatusLine 共用 |
| `tests/ui/status/tone.test.ts` | 新建 | tone 计算逻辑单元测试 |
| `src/ui/chat/ChatView.svelte` | 改造 | Header 重构 + work 条新增 + 删旧 gate + style 清理 |
| `src/ui/status/StatusLine.svelte` | 改造 | 删 ctx 块 + box-shadow 清理 + 改用 tone.ts |
| `src/ui/status/StatusDrawer.svelte` | 改造 | 精简上下文区 + 圆角修正 + box-shadow 清理 |
| `src/ui/MessageBubble.svelte` | 改造 | 删 box-shadow |
| `src/ui/SearchResults.svelte` | 改造 | 删 box-shadow |
| `src/ui/ToolSegment.svelte` | 改造 | 删 box-shadow |
| `src/ui/MessageList.svelte` | 改造 | 删 box-shadow |
| `src/i18n/types.ts` | 改造 | 新增 5 key + 删除 11 key |
| `src/i18n/zh.ts` | 改造 | 新增 5 翻译 + 删除 11 key |
| `src/i18n/en.ts` | 改造 | 新增 5 翻译 + 删除 11 key |
| `styles.css` | 改造 | `diag-*` → `ratel-diag-*` |
| `src/ui/diagnostics/embedding-test.ts` | 改造 | class 引用 `diag-` → `ratel-diag-`(约 26 处) |
| `src/ui/diagnostics/llm-test.ts` | 改造 | class 引用 `diag-` → `ratel-diag-`(约 28 处) |
| `src/ui/diagnostics/diag-utils.ts` | 改造 | class 引用 `diag-` → `ratel-diag-`(约 24 处) |
| `src/ui/diagnostics/tab-bar.ts` | 改造 | class 引用 `diag-` → `ratel-diag-`(约 6 处) |

---

## Task 1: 创建 tone.ts 共享模块(TDD)

**Files:**
- Create: `src/ui/status/tone.ts`
- Test: `tests/ui/status/tone.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/ui/status/tone.test.ts`:

```typescript
/**
 * @file tests/ui/status/tone.test.ts
 * @description tone 计算逻辑单元测试 — 验证 5 种 tone 优先级
 * @module tests/ui/status/tone
 * @depends src/ui/status/tone, src/user-feedback/user-status
 */
import { describe, it, expect } from 'vitest';
import { deriveTone, type Tone } from '../../../src/ui/status/tone';
import type { UserStatusSnapshot } from '../../../src/user-feedback/user-status';

// 关键路径:构造最小 snapshot,只填必要字段
function snap(partial: Partial<UserStatusSnapshot>): UserStatusSnapshot {
	return {
		model: 'idle',
		index: 'idle',
		embedding: 'ready',
		worker: 'inline',
		...partial,
	};
}

describe('deriveTone', () => {
	it('索引中 - 优先级最高 - 覆盖思考中', () => {
		// 关键路径:indexing 优先于 thinking,即使 model 不是 ready
		const s = snap({ index: 'processing', model: 'checking' });
		expect(deriveTone(s)).toEqual({ tone: 'indexing' as Tone });
	});

	it('索引中 - scanning 状态 - 返回 indexing', () => {
		expect(deriveTone(snap({ index: 'scanning' }))).toEqual({ tone: 'indexing' });
	});

	it('索引中 - queueing 状态 - 返回 indexing', () => {
		expect(deriveTone(snap({ index: 'queueing' }))).toEqual({ tone: 'indexing' });
	});

	it('索引中 - diffing 状态 - 返回 indexing(smartRehash hash 比对阶段)', () => {
		// 关键路径:diffing 是 smartReindex 的 hash 比对阶段,用户感知也是"索引中"
		expect(deriveTone(snap({ index: 'diffing' }))).toEqual({ tone: 'indexing' });
	});

	it('错误 - model failed - 返回 error', () => {
		expect(deriveTone(snap({ model: 'failed' }))).toEqual({ tone: 'error' });
	});

	it('错误 - index failed - 返回 error', () => {
		expect(deriveTone(snap({ index: 'failed' }))).toEqual({ tone: 'error' });
	});

	it('未配置 - model idle 且 embedding unavailable - 返回 unconfigured', () => {
		expect(deriveTone(snap({ model: 'idle', embedding: 'unavailable' }))).toEqual({ tone: 'unconfigured' });
	});

	it('思考中 - model 非 ready 且非 idle - 返回 thinking', () => {
		expect(deriveTone(snap({ model: 'checking' }))).toEqual({ tone: 'thinking' });
		expect(deriveTone(snap({ model: 'downloading' }))).toEqual({ tone: 'thinking' });
		expect(deriveTone(snap({ model: 'initializing' }))).toEqual({ tone: 'thinking' });
	});

	it('就绪 - model ready 且 index 非 failed - 返回 ready', () => {
		expect(deriveTone(snap({ model: 'ready', index: 'ready' }))).toEqual({ tone: 'ready' });
	});

	it('就绪 - model ready 且 index idle - 返回 ready', () => {
		expect(deriveTone(snap({ model: 'ready', index: 'idle' }))).toEqual({ tone: 'ready' });
	});
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/ui/status/tone.test.ts`
Expected: FAIL with "Cannot find module '../../../src/ui/status/tone'"

- [ ] **Step 3: 写最小实现**

Create `src/ui/status/tone.ts`:

```typescript
/**
 * @file src/ui/status/tone.ts
 * @description 共享 tone 计算逻辑 — Header badge 与 StatusLine 共用,避免逻辑重复
 * @module ui/status/tone
 * @depends user-feedback/user-status
 */

import type { UserStatusSnapshot } from '../../user-feedback/user-status';

/** 状态色调,5 种视觉区分 */
export type Tone = 'ready' | 'thinking' | 'error' | 'unconfigured' | 'indexing';

/**
 * 从 UserStatusSnapshot 派生 tone — 优先级:索引中 > 错误 > 未配置 > 思考中 > 就绪。
 *
 * 关键路径:Header model-badge 与 StatusLine.dot 必须用同一份 tone 逻辑,
 * 否则两者颜色不同步会让用户困惑。index 字段的 processing/scanning/queueing/diffing
 * 四种状态都归为 indexing tone(diffing 是 smartRehash 的 hash 比对阶段,用户感知也是"索引中")。
 *
 * @param snap - 使用者状态快照
 * @returns `{ tone }` — 调用方根据 tone 自行决定 label 和样式
 */
export function deriveTone(snap: UserStatusSnapshot): { tone: Tone } {
	// 关键路径:索引中优先于思考中(用户更关心索引进度)
	// 关键路径:diffing 是 smartReindex 的 hash 比对阶段,归为 indexing tone
	if (snap.index === 'processing' || snap.index === 'scanning' || snap.index === 'queueing' || snap.index === 'diffing') {
		return { tone: 'indexing' };
	}
	if (snap.model === 'failed' || snap.index === 'failed') {
		return { tone: 'error' };
	}
	if (snap.model === 'idle' && snap.embedding === 'unavailable') {
		return { tone: 'unconfigured' };
	}
	if (snap.model !== 'ready' && snap.model !== 'idle') {
		return { tone: 'thinking' };
	}
	return { tone: 'ready' };
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/ui/status/tone.test.ts`
Expected: PASS,10 tests passed

- [ ] **Step 5: 提交**

```bash
git add src/ui/status/tone.ts tests/ui/status/tone.test.ts
git commit -m "feat(ui): 提取 deriveTone 共享模块 — Header 与 StatusLine 共用 tone 逻辑

为后续 Header badge 随状态变色做准备,把 StatusLine.svelte 中
内联的 tone 判定逻辑提取为 src/ui/status/tone.ts。

- 5 种 tone:ready / thinking / error / unconfigured / indexing
- 优先级:索引中 > 错误 > 未配置 > 思考中 > 就绪
- index 字段的 processing/scanning/queueing/diffing 都归为 indexing tone
- 10 个单元测试覆盖所有分支"
```

---

## Task 2: Header 重构(logo + 百分比胶囊 + badge 变色)

**Files:**
- Modify: `src/ui/chat/ChatView.svelte:388-392`(template)
- Modify: `src/ui/chat/ChatView.svelte:488-521`(style)
- Modify: `src/ui/chat/ChatView.svelte:10-39`(import + 状态)

**依赖:** Task 1(tone.ts)

- [ ] **Step 1: 在 ChatView.svelte 添加 import 和 tone 派生**

在 `src/ui/chat/ChatView.svelte` L12(StatusLine import)下方新增:

```typescript
import { deriveTone } from '../status/tone';
```

在 L90(`const modelName = $derived(plugin.settings.chatModel);`)下方新增:

```typescript
// 关键路径:Header badge tone 与 StatusLine 同源,保证视觉同步
const statusSnap = $derived($statusStore);
const headerTone = $derived(deriveTone(statusSnap).tone);
// 关键路径:Header 百分比胶囊按使用率阈值变色,与原 StatusLine 阈值一致
const headerCtxColor = $derived.by(() => {
	const p = $contextStore.percentage;
	if (p >= 95) return 'var(--text-error)';
	if (p >= 80) return 'var(--text-warning)';
	return 'var(--text-success)';
});
const headerPct = $derived(Math.min($contextStore.percentage, 100));
```

- [ ] **Step 2: 重写 Header template**

替换 `src/ui/chat/ChatView.svelte:388-392` 为:

```svelte
	<!-- Header — logo + 标题 + 上下文百分比胶囊 + 模型徽章(tone 变色) -->
	<div class="ratel-header">
		<div class="ratel-header-left">
			<span class="ratel-header-logo">R</span>
			<span class="ratel-header-title">{$t('chat.header.title')}</span>
		</div>
		<div class="ratel-header-right">
			<span class="ratel-header-ctx" style={`color: ${headerCtxColor}; border-color: color-mix(in srgb, ${headerCtxColor} 20%, transparent); background: color-mix(in srgb, ${headerCtxColor} 12%, transparent);`}>{headerPct}%</span>
			<span class="ratel-header-badge ratel-header-badge--{headerTone}">{modelName}</span>
		</div>
	</div>
```

- [ ] **Step 3: 重写 Header style**

替换 `src/ui/chat/ChatView.svelte:488-521`(`.ratel-header` 到 `.ratel-header-badge` 整块)为:

```css
	/* ==================== Header(毛玻璃,无 box-shadow) ==================== */
	.ratel-header {
		flex-shrink: 0;
		padding: 10px 14px;
		border-bottom: 1px solid var(--background-modifier-border);
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: color-mix(in srgb, var(--background-secondary) 65%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}

	.ratel-header-left {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.ratel-header-right {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	/* R logo — 22×22 圆角 6px,半透明绿底 */
	.ratel-header-logo {
		width: 22px;
		height: 22px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--text-success) 20%, transparent);
		color: var(--text-success);
		font-size: 12px;
		font-weight: 700;
		font-family: var(--font-monospace);
		border: 1px solid color-mix(in srgb, var(--text-success) 30%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.ratel-header-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-normal);
		letter-spacing: 0.3px;
	}

	/* 上下文百分比胶囊 — 只显示数字,按阈值变色 */
	.ratel-header-ctx {
		font-size: 11px;
		font-family: var(--font-monospace);
		padding: 2px 9px;
		border-radius: 8px;
		border: 1px solid;
		font-weight: 600;
		min-width: 36px;
		text-align: center;
	}

	/* model badge — 随 tone 变色 */
	.ratel-header-badge {
		font-size: 11px;
		font-family: var(--font-monospace);
		padding: 2px 9px;
		border-radius: 8px;
		font-weight: 500;
		max-width: 180px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border: 1px solid;
		/* 关键路径:默认 ready 绿底,其他 tone 由修饰类覆盖 */
		background: color-mix(in srgb, var(--text-success) 12%, transparent);
		color: var(--text-success);
		border-color: color-mix(in srgb, var(--text-success) 20%, transparent);
	}

	.ratel-header-badge--ready {
		background: color-mix(in srgb, var(--text-success) 12%, transparent);
		color: var(--text-success);
		border-color: color-mix(in srgb, var(--text-success) 20%, transparent);
	}

	.ratel-header-badge--thinking,
	.ratel-header-badge--indexing {
		background: color-mix(in srgb, var(--text-warning) 12%, transparent);
		color: var(--text-warning);
		border-color: color-mix(in srgb, var(--text-warning) 20%, transparent);
		animation: ratel-header-pulse 1.2s infinite;
	}

	.ratel-header-badge--error {
		background: color-mix(in srgb, var(--text-error) 12%, transparent);
		color: var(--text-error);
		border-color: color-mix(in srgb, var(--text-error) 20%, transparent);
	}

	.ratel-header-badge--unconfigured {
		background: color-mix(in srgb, var(--text-muted) 10%, transparent);
		color: var(--text-muted);
		border-color: color-mix(in srgb, var(--text-muted) 20%, transparent);
		border-style: dashed;
	}

	@keyframes ratel-header-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-header-badge--thinking,
		.ratel-header-badge--indexing {
			animation: none;
		}
	}
```

- [ ] **Step 4: 修订过时注释**

替换 `src/ui/chat/ChatView.svelte:468-475`(设计 Token 注释块)为:

```css
	/*
	 * 设计 Token 映射:
	 * - 圆角 6-8px(符合设计系统上限,严禁超过 8px)
	 * - 毛玻璃 backdrop-filter blur(8-10px)
	 * - 视觉层次靠 border + background 对比度,不使用 box-shadow(项目硬约束禁止)
	 * - 半透明背景 color-mix 适配亮/暗主题
	 */
```

- [ ] **Step 5: 跑测试确保不破坏**

Run: `npx vitest run`
Expected: 652 + 10 = 662 tests passed,0 failed

- [ ] **Step 6: 跑 build 确保 Svelte 编译通过**

Run: `npm run build`
Expected: 编译成功,无 Svelte 警告

- [ ] **Step 7: 提交**

```bash
git add src/ui/chat/ChatView.svelte
git commit -m "feat(ui): Header 重构 — logo + 百分比胶囊 + badge 随 tone 变色

- 新增 R logo(22×22 圆角 6px,半透明绿底)
- 新增上下文百分比胶囊(按阈值变色:0-79绿/80-94黄/95-100红)
- model-badge 随 5 种 tone 变色(ready/thinking/error/unconfigured/indexing)
- thinking/indexing 状态脉冲动画
- 圆角从 12px 改 8px(合规)
- 修订过时注释(删除'用户明确要求阴影')"
```

---

## Task 3: StatusLine 简化(删 ctx 块 + box-shadow 清理)

**Files:**
- Modify: `src/ui/status/StatusLine.svelte`(全文)

**依赖:** Task 1(tone.ts)

- [ ] **Step 1: 改造 StatusLine.svelte script**

替换 `src/ui/status/StatusLine.svelte:1-76`(script 块)为:

```svelte
<script lang="ts">
	/**
	 * @file src/ui/status/StatusLine.svelte
	 * @description 底部常驻单行状态条 — 状态点 + 文字 + 展开 ▲(百分比已外移到 Header)
	 * @module ui/StatusLine
	 * @depends svelte/store, user-feedback/user-status, ./tone
	 * 设计:毛玻璃背景,只留 3 件事:点 + 文字 + 箭头
	 */
	import type { Readable } from 'svelte/store';
	import type { UserStatusSnapshot } from '../../user-feedback/user-status';
	import { t } from '../../i18n';
	import { deriveTone, type Tone } from './tone';

	let {
		status$,
		expanded = false,
		onToggle,
	}: {
		status$: Readable<UserStatusSnapshot>;
		expanded: boolean;
		onToggle: () => void;
	} = $props();

	// 关键路径:Svelte 5 直接用 $ 前缀订阅 store
	const snap = $derived($status$);

	const toneLabels: Record<Tone, string> = {
		ready: 'status.index.ready',
		thinking: 'status.index.thinking',
		error: 'status.index.requestFailed',
		unconfigured: 'status.index.notConfigured',
		indexing: 'status.index.indexing',
	};

	const state = $derived.by(() => {
		const { tone } = deriveTone(snap);
		return { tone, label: $t(toneLabels[tone]) };
	});
</script>
```

**关键变更:** 删除 `contextUsage$` prop 和 `ContextUsage` import(百分比已外移到 Header,StatusLine 不再需要 context 数据)。需同步删除 ChatView.svelte L402 的 `contextUsage$={contextStore}` 传参。

- [ ] **Step 1.5: 删除 ChatView.svelte 中 StatusLine 的 contextUsage$ 传参**

替换 `src/ui/chat/ChatView.svelte:400-405` 为:

```svelte
	<StatusLine
		status$={statusStore}
		expanded={drawerExpanded}
		onToggle={() => (drawerExpanded = !drawerExpanded)}
	/>
```

(删除 `contextUsage$={contextStore}` 行)

- [ ] **Step 2: 重写 StatusLine template**

替换 `src/ui/status/StatusLine.svelte:78-118`(template)为:

```svelte
<!-- 关键路径:整行可点击切换 Drawer,ctx 百分比已外移到 Header -->
<div
	class="ratel-status-line"
	onclick={onToggle}
	role="button"
	aria-expanded={expanded}
	aria-label={expanded ? $t('status.drawer.collapse') : $t('status.drawer.expand')}
>
	<span
		class="ratel-sl-dot"
		class:ratel-sl-dot-ready={state.tone === 'ready'}
		class:ratel-sl-dot-thinking={state.tone === 'thinking' || state.tone === 'indexing'}
		class:ratel-sl-dot-error={state.tone === 'error'}
		class:ratel-sl-dot-unconfigured={state.tone === 'unconfigured'}
	></span>
	<span
		class="ratel-sl-text"
		class:ratel-sl-text-warn={state.tone === 'thinking' || state.tone === 'indexing'}
		class:ratel-sl-text-error={state.tone === 'error'}
		class:ratel-sl-text-muted={state.tone === 'unconfigured'}
	>{state.label}</span>
	<span class="ratel-sl-arrow">▲</span>
</div>
```

- [ ] **Step 3: 重写 StatusLine style**

替换 `src/ui/status/StatusLine.svelte:120-310`(style 块)为:

```css
<style>
	/*
	 * 关键路径:状态条使用毛玻璃背景,与 Header/输入区视觉一致。
	 * 高度 30px 常驻底部,hover 微亮反馈。
	 * 删除 ctx 块后只剩 点 + 文字 + 箭头,无 box-shadow。
	 */
	.ratel-status-line {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 30px;
		padding: 0 14px;
		border-top: 1px solid var(--background-modifier-border);
		background: color-mix(in srgb, var(--background-secondary) 75%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		font-size: 11.5px;
		color: var(--text-muted);
		cursor: pointer;
		user-select: none;
		flex-shrink: 0;
		transition: background 0.15s;
	}

	.ratel-status-line:hover {
		background: color-mix(in srgb, var(--background-modifier-hover) 70%, transparent);
	}

	.ratel-sl-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
		transition: background 0.2s;
	}

	.ratel-sl-dot-ready {
		background: var(--text-success);
	}

	.ratel-sl-dot-thinking {
		background: var(--text-warning);
		animation: ratel-sl-pulse 1.2s infinite;
	}

	.ratel-sl-dot-error {
		background: var(--text-error);
	}

	.ratel-sl-dot-unconfigured {
		background: transparent;
		border: 1.5px solid var(--text-faint, var(--text-muted));
	}

	@keyframes ratel-sl-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-sl-dot-thinking {
			animation: none;
		}
	}

	.ratel-sl-text {
		font-weight: 500;
		color: var(--text-normal);
	}

	.ratel-sl-text-warn {
		color: var(--text-warning);
	}

	.ratel-sl-text-error {
		color: var(--text-error);
	}

	.ratel-sl-text-muted {
		color: var(--text-muted);
		font-weight: 400;
	}

	.ratel-sl-arrow {
		margin-left: auto;
		font-size: 10px;
		opacity: 0.6;
		flex-shrink: 0;
		transition: opacity 0.15s;
	}

	.ratel-status-line:hover .ratel-sl-arrow {
		opacity: 0.9;
	}
</style>
```

- [ ] **Step 4: 跑测试确保不破坏**

Run: `npx vitest run`
Expected: 662 tests passed,0 failed

- [ ] **Step 5: 跑 build 确保 Svelte 编译通过**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 6: 提交**

```bash
git add src/ui/status/StatusLine.svelte src/ui/chat/ChatView.svelte
git commit -m "feat(ui): StatusLine 简化 — 删除 ctx 块,只留点+文字+箭头

- 删除 ctx 进度条 + 百分比 + source-pill(已外移到 Header)
- 改用 deriveTone 共享模块(与 Header badge 同源)
- 删除 box-shadow 光晕(dot-ready / dot-error)
- 删除 ctx-bar / ctx-fill / source-pill 相关 CSS
- 删除 contextUsage\$ prop(死参数,ChatView 传参同步删除)"
```

---

## Task 4: StatusDrawer 上下文区精简

**Files:**
- Modify: `src/ui/status/StatusDrawer.svelte:79-107`(script sourceInfo/attachmentTokens/ctxColor/pct)
- Modify: `src/ui/status/StatusDrawer.svelte:143-175`(template 上下文区)
- Modify: `src/ui/status/StatusDrawer.svelte:271`(style 圆角)
- Modify: `src/ui/status/StatusDrawer.svelte:323-407`(style meter/source CSS)
- Modify: `src/i18n/types.ts`(删除 5 drawer key)
- Modify: `src/i18n/zh.ts`(删除 5 翻译)
- Modify: `src/i18n/en.ts`(删除 5 翻译)

**关键路径:Step 顺序 — 先改 template(Step 1)再改 script(Step 2),避免删除 script 变量后 template 仍引用导致 Svelte 编译失败。**

- [ ] **Step 1: 精简 StatusDrawer template 上下文区(先改,避免 script 变量删除后引用悬空)**

替换 `src/ui/status/StatusDrawer.svelte:143-175`(从"上下文" section title 到 onCompact button 之前,包含 token-meter / source-pill / 附件统计行)为:

```svelte
		<div class="ratel-drawer-section-title">{$t('status.drawer.section.context')}</div>
		<div class="ratel-drawer-row">
			<span class="ratel-drawer-label">{$t('status.drawer.label.usedMax')}</span>
			<span class="ratel-drawer-value ratel-drawer-mono">{usage.usedTokens.toLocaleString()} / {usage.maxTokens.toLocaleString()} tokens</span>
		</div>
		<div class="ratel-drawer-row ratel-drawer-row-end">
			<button class="ratel-drawer-micro-btn" type="button" onclick={onCompact}>{$t('status.drawer.compactButton')}</button>
		</div>
```

**验证:** template 不再引用 `sourceInfo` / `attachmentTokens` / `pct` / `ctxColor`,为 Step 2 删除这些变量做准备。

- [ ] **Step 2: 删除 StatusDrawer.svelte script 中的 sourceInfo / attachmentTokens / pct / ctxColor**

替换 `src/ui/status/StatusDrawer.svelte:79-96`(从 `const attachmentTokens` 到 `sourceInfo` 闭合 `});`)为:

```typescript
	// 关键路径:sourceInfo / attachmentTokens / pct / ctxColor 已删除
	// (token-meter / source-pill / 附件统计行从 template 移除后,这些变量变为死代码)
	// currentFile 保留(仍在 template L122-126 使用)
```

**注意:** 只删 L79-96,不要动 L98-107 的 `currentFile` 块(它还在 template 中用)。

- [ ] **Step 3: 删除 StatusDrawer style 中的 meter / source CSS(指示性删除)**

在 `src/ui/status/StatusDrawer.svelte` 的 `<style>` 块中,删除以下选择器(**用 Read 工具读取 L323-407 确认精确文本,再用 Edit 工具删除**):

要删除的选择器清单:
1. `.ratel-drawer-token-meter`(L323-329)
2. `.ratel-drawer-meter-track`(L330-339)
3. `.ratel-drawer-meter-fill`(L340-345)
4. `.ratel-drawer-meter-pct`(L346-354)
5. `.ratel-drawer-src`(L355-366)
6. `.ratel-drawer-src-dot`(L367-373)
7. `.ratel-drawer-src-label`(L374-377)
8. `.ratel-drawer-src-estimate`(L378-381)
9. `.ratel-drawer-src-estimate .ratel-drawer-src-dot`(L382-385)
10. `.ratel-drawer-src-streaming`(L386-390)
11. `.ratel-drawer-src-streaming .ratel-drawer-src-dot`(L391-398)
12. `.ratel-drawer-src-api`(L399-403)
13. `.ratel-drawer-src-api .ratel-drawer-src-dot`(L404-408)
14. `@keyframes ratel-drawer-src-pulse`(L409-414)
15. `@media (prefers-reduced-motion: reduce)` 块中的 `.ratel-drawer-src-streaming .ratel-drawer-src-dot` 和 `.ratel-drawer-meter-fill` 两行(L415-419 附近)

**操作方式:** Read L323-420 → 用 Edit 工具把整块 `.ratel-drawer-token-meter { ... }` 到 `@media { ... }` 之间的相关选择器一次性删除(可以分多次 Edit,每次删一个连续块)。删除后跑 build 验证 CSS 无残留引用。

- [ ] **Step 4: 修正圆角违规**

用 Read 工具读取 `src/ui/status/StatusDrawer.svelte:268-275` 确认 `.ratel-drawer-pill` 精确文本,用 Edit 工具把 `border-radius: 10px` 改为 `border-radius: 8px`(只改这一行,不动其他属性)。

- [ ] **Step 5: 删除 i18n types.ts 中的 5 个 drawer key**

在 `src/i18n/types.ts` 中删除以下行(用 Edit 工具):

```typescript
  'status.drawer.label.dataSource': string;
  'status.drawer.attachmentsCount': string;
  'status.drawer.sourceApi': string;
  'status.drawer.sourceStreaming': string;
  'status.drawer.sourceEstimate': string;
```

- [ ] **Step 6: 删除 i18n zh.ts 和 en.ts 中的 5 个翻译**

在 `src/i18n/zh.ts` 和 `src/i18n/en.ts` 中删除对应的 5 个 key(用 Edit 工具,需先 Read 确认精确文本)。

- [ ] **Step 7: 跑测试确保不破坏**

Run: `npx vitest run`
Expected: 662 tests passed,0 failed(可能有 i18n key 缺失警告,但不应有测试失败)

- [ ] **Step 8: 跑 build 确保 Svelte 编译通过**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 9: 提交**

```bash
git add src/ui/status/StatusDrawer.svelte src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(ui): StatusDrawer 上下文区精简 — 删 token-meter/source/附件统计

- 删除 token-meter 进度条(已外移到 Header 百分比胶囊)
- 删除 source-pill(从 StatusLine 和抽屉移除,不再需要 source 指示)
- 删除附件 token 统计行(简化抽屉)
- 保留:已用/上限 tokens 文字 + 压缩上下文按钮
- 圆角违规修正:.ratel-drawer-pill 10px→8px
- 删除 i18n key:5 个 drawer 专属(dataSource/attachmentsCount/sourceApi/sourceStreaming/sourceEstimate)"
```

---

## Task 5: Input 下方新增 work 条 + 删旧 gate

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`(template + style)
- Modify: `src/i18n/types.ts`(新增 5 key)
- Modify: `src/i18n/zh.ts`(新增 5 翻译)
- Modify: `src/i18n/en.ts`(新增 5 翻译)

**依赖:** Task 2(ChatView 已改造)

- [ ] **Step 1: 新增 i18n key 到 types.ts**

在 `src/i18n/types.ts` 的 `ChatStrings` interface 中(`chat.header.title` 附近)新增:

```typescript
  'chat.workbar.indexing': string;
  'chat.workbar.downloading': string;
  'chat.workbar.preparing': string;
  'chat.workbar.searching': string;
  'chat.workbar.compacting': string;
```

- [ ] **Step 2: 新增 zh.ts 翻译**

在 `src/i18n/zh.ts` 的 chat 翻译块中新增:

```typescript
  'chat.workbar.indexing': '索引中...',
  'chat.workbar.downloading': '下载模型中...',
  'chat.workbar.preparing': '准备模型中...',
  'chat.workbar.searching': '搜索中...',
  'chat.workbar.compacting': '压缩中...',
```

- [ ] **Step 3: 新增 en.ts 翻译**

在 `src/i18n/en.ts` 的 chat 翻译块中新增:

```typescript
  'chat.workbar.indexing': 'Indexing...',
  'chat.workbar.downloading': 'Downloading model...',
  'chat.workbar.preparing': 'Preparing model...',
  'chat.workbar.searching': 'Searching...',
  'chat.workbar.compacting': 'Compacting...',
```

- [ ] **Step 4: 在 ChatView.svelte 添加 work-bar 派生状态**

在 `src/ui/chat/ChatView.svelte` 的 `const headerPct = ...` 下方(Task 2 新增的)新增:

```typescript
// 关键路径:work-bar 显示状态 — 优先级从上到下,同时满足只显示第一个
// 关键路径:indexing 分支不解析 indexDetail(progressing 状态是文件名,queueing 是 i18n 文字,
// 格式不统一)。进度数字由 StatusDrawer 进度条承担,work-bar 只显示笼统的"索引中..."
const workBar = $derived.by(() => {
	const s = $statusStore;
	// 阻塞提示优先单独显示
	if (gate.hardBlockReason) return { type: 'hard' as const, text: gate.hardBlockReason };
	// 索引中(processing/scanning/queueing/diffing 四种状态,统一显示"索引中...")
	if (s.index === 'processing' || s.index === 'scanning' || s.index === 'queueing' || s.index === 'diffing') {
		return { type: 'indexing' as const, text: $t('chat.workbar.indexing') };
	}
	// 模型下载中
	if (s.model === 'downloading') {
		return { type: 'downloading' as const, text: $t('chat.workbar.downloading') };
	}
	// 模型初始化中
	if (s.model === 'checking' || s.model === 'initializing') {
		return { type: 'preparing' as const, text: $t('chat.workbar.preparing') };
	}
	// 压缩中
	if (isCompacting) {
		return { type: 'compacting' as const, text: $t('chat.workbar.compacting') };
	}
	// 搜索中(isRunning 且 gate 不阻塞)
	if (isRunning) {
		return { type: 'searching' as const, text: $t('chat.workbar.searching') };
	}
	// 空闲
	return null;
});
```

- [ ] **Step 5: 删除旧 gate 提示条,新增 work-bar template**

替换 `src/ui/chat/ChatView.svelte:417-465`(整个 .ratel-input 块)为:

```svelte
	<!-- 输入区(毛玻璃) -->
	<div class="ratel-input">
		<!-- 附件预览条 -->
		<AttachmentStrip
			pendingAttachments$={attachmentStore}
			onRemove={(id) => plugin.userStatus.removeAttachment(id)}
		/>

		<!-- 斜杠命令(绝对定位,浮在输入框上方) -->
		{#if slashVisible}
			<div class="ratel-slash-wrap">
				<SlashMenu
					bind:this={slashMenuEl}
					input={input}
					onSelect={executeSlashCommand}
					onClose={() => { input = ''; }}
				/>
			</div>
		{/if}

		<div class="ratel-input-row">
			<button class="ratel-plus-btn" type="button" onclick={triggerFileInput} aria-label={$t('chat.input.addImage')} disabled={isRunning}>+</button>
			<input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={handleFileSelect} style="display:none;" />
			<textarea
				bind:value={input}
				onkeydown={handleKeydown}
				onfocus={refreshKeyState}
				placeholder={$t('chat.input.placeholder')}
				disabled={isRunning || isCompacting || !gate.canSend}
				rows={1}
			></textarea>
		</div>
		<div class="ratel-input-footer">
			{#if isRunning}
				<button class="ratel-send ratel-stop" onclick={stopGeneration} type="button">{$t('chat.input.stop')}</button>
			{:else}
				<button class="ratel-send" onclick={sendMessage} disabled={!input.trim() || !gate.canSend} type="button">{$t('chat.input.send')}</button>
			{/if}
		</div>

		<!-- work 条 — 显示"正在做的事"或 gate 提示,空闲时隐藏 -->
		{#if workBar}
			<div class="ratel-work-bar">
				{#if workBar.type === 'hard'}
					<span class="ratel-work-hint ratel-work-hint-hard">⚠ {workBar.text}</span>
				{:else}
					<span class="ratel-work-item ratel-work-item--{workBar.type}">
						<span class="ratel-work-dot"></span>
						<span>{workBar.text}</span>
					</span>
					{#if gate.softHint}
						<span class="ratel-work-hint">ⓘ {gate.softHint}</span>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
```

- [ ] **Step 6: 删除旧 gate CSS,新增 work-bar CSS**

在 `src/ui/chat/ChatView.svelte` style 块中,删除 `.ratel-gate` 和 `.ratel-gate-hard`(L531-546 附近),替换为:

```css
	/* ==================== work 条(底部,显示正在做的事) ==================== */
	.ratel-work-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 6px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--background-secondary) 50%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		font-size: 11.5px;
		margin-top: 4px;
	}

	.ratel-work-item {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-warning);
		font-family: var(--font-monospace);
		font-size: 11px;
	}

	.ratel-work-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--text-warning);
		animation: ratel-work-pulse 1.2s infinite;
		flex-shrink: 0;
	}

	@keyframes ratel-work-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-work-dot {
			animation: none;
		}
	}

	.ratel-work-hint {
		color: var(--text-muted);
		font-size: 11px;
	}

	.ratel-work-hint-hard {
		color: var(--text-error);
		font-weight: 500;
		width: 100%;
	}
```

- [ ] **Step 7: 跑测试确保不破坏**

Run: `npx vitest run`
Expected: 662 tests passed,0 failed

- [ ] **Step 8: 跑 build 确保 Svelte 编译通过**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 9: 提交**

```bash
git add src/ui/chat/ChatView.svelte src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(ui): Input 下方新增 work 条 — 显示正在做的事 + gate 提示移入

- 新增 work 条:索引中/下载模型中/准备模型中/搜索中/压缩中
- indexing 分支不解析 indexDetail(格式不统一),统一显示"索引中..."
- 进度数字由 StatusDrawer 进度条承担,work-bar 只做存在性提示
- 删除旧 gate 提示条(从 input 顶部移到 work 条)
- 删除 isCompacting 独立 loading hint(合并到 work 条)
- 优先级:hard block > 索引 > 下载 > 准备 > 压缩 > 搜索
- 空闲时 work 条隐藏(不占位)
- i18n 新增 5 key(chat.workbar.*)"
```

---

## Task 6: 其他组件 box-shadow 清理

**Files:**
- Modify: `src/ui/chat/message-stream/MessageBubble.svelte`(L113 / L121 / L137)
- Modify: `src/ui/chat/message-stream/SearchResults.svelte`(L68)
- Modify: `src/ui/chat/message-stream/ToolSegment.svelte`(L139)
- Modify: `src/ui/chat/message-stream/MessageList.svelte`(L100)

**说明:** 这 4 个组件的 box-shadow 在 spec 范围内(本次一并清理),但只删 box-shadow,不改其他渲染逻辑。

- [ ] **Step 1: 逐文件删除 box-shadow**

对每个文件,用 Read 读取 box-shadow 所在行,用 Edit 删除 `box-shadow: ...;` 行。

**MessageBubble.svelte**:
- L113:消息气泡投影(用户消息)`box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);` — 删除
- L121:`box-shadow: none;` — **已经是 none,无需处理**
- L137:消息气泡投影(其他变体)`box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);` — 删除

**SearchResults.svelte**:
- L68:搜索结果卡片投影

**ToolSegment.svelte**:
- L139:工具调用点光晕

**MessageList.svelte**:
- L100:思考中点光晕

对每个 box-shadow 行,删除该行。如果 box-shadow 是某个选择器的唯一属性之外的属性,只删 box-shadow 这一行,保留其他属性。

- [ ] **Step 2: 跑测试确保不破坏**

Run: `npx vitest run`
Expected: 662 tests passed,0 failed

- [ ] **Step 3: 跑 build 确保 Svelte 编译通过**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 4: 提交**

```bash
git add src/ui/chat/message-stream/
git commit -m "style(ui): 删除消息组件 box-shadow — 项目硬约束禁止阴影

- MessageBubble: 删除 2 处消息气泡投影(L113 / L137;L121 已是 none 无需处理)
- SearchResults: 删除搜索结果卡片投影
- ToolSegment: 删除工具调用点光晕
- MessageList: 删除思考中点光晕

视觉层次改用 border + background 对比度(项目硬约束禁止 box-shadow)"
```

---

## Task 7: ChatView Input 区 box-shadow 清理 + diag- 前缀全局替换

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`(L596 / L629 / L634 / L660 / L668 / L684 / L689 box-shadow)
- Modify: `styles.css`(L77-134 `diag-` → `ratel-diag-`)
- Modify: `src/ui/diagnostics/embedding-test.ts`
- Modify: `src/ui/diagnostics/llm-test.ts`
- Modify: `src/ui/diagnostics/rerank-test.ts`
- Modify: `src/ui/diagnostics/diag-utils.ts`
- Modify: `src/ui/diagnostics/tab-bar.ts`

- [ ] **Step 1: ChatView.svelte 删除 box-shadow**

在 `src/ui/chat/ChatView.svelte` style 块中,删除以下 box-shadow 行:

1. `.ratel-plus-btn`(L596):删除 `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);`
2. `.ratel-input-row textarea`(L629):删除 `box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04) inset;`
3. `.ratel-input-row textarea:focus`(L634):替换 `box-shadow: 0 0 0 2px color-mix(...)` 为 `outline: 2px solid color-mix(in srgb, var(--interactive-accent) 30%, transparent); outline-offset: -1px;`
4. `.ratel-send`(L660):删除 `box-shadow: 0 1px 3px color-mix(...), 0 1px 2px rgba(0, 0, 0, 0.08);`
5. `.ratel-send:hover:not(:disabled)`(L668):删除 `box-shadow: 0 2px 6px ...;`
6. `.ratel-stop`(L684):删除 `box-shadow: ... !important;`
7. `.ratel-stop:hover:not(:disabled)`(L689):删除 `box-shadow: ... !important;`

- [ ] **Step 2: 修订 .ratel-send 的 transition**

由于删除了 box-shadow,transition 中的 `box-shadow` 不再需要:

```css
	.ratel-send {
		transition: opacity 0.15s, transform 0.1s;
	}
```

- [ ] **Step 3: 删除 styles.css 中的 diag- 前缀样式,改为 ratel-diag-**

在 `styles.css` 中,把所有 `.diag-` 选择器替换为 `.ratel-diag-`。

- [ ] **Step 4: diagnostics TS 文件 class 引用替换**

在以下文件中,把所有 `'diag-` 字符串(在 `cls: 'diag-...'` 调用中)替换为 `'ratel-diag-`:
- `src/ui/diagnostics/embedding-test.ts`
- `src/ui/diagnostics/llm-test.ts`
- `src/ui/diagnostics/rerank-test.ts`
- `src/ui/diagnostics/diag-utils.ts`
- `src/ui/diagnostics/tab-bar.ts`

**注意:** 只替换 `cls:` 属性中的字符串值,不替换函数名或文件名(如 `formatError`、`createActionButton` 等保持不变)。

- [ ] **Step 5: 跑测试确保不破坏**

Run: `npx vitest run`
Expected: 662 tests passed,0 failed

- [ ] **Step 6: 跑 build 确保 Svelte 编译通过**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 7: 提交**

```bash
git add src/ui/chat/ChatView.svelte styles.css src/ui/diagnostics/
git commit -m "style(ui): ChatView box-shadow 清理 + diag- 前缀全局替换为 ratel-diag-

- ChatView: 删除 7 处 box-shadow(plus-btn/textarea/send/stop)
- textarea:focus 改用 outline 替代 box-shadow 光晕
- .ratel-send transition 删除 box-shadow
- styles.css: diag-* → ratel-diag-*(项目硬约束要求 ratel- 前缀)
- 5 个 diagnostics TS 文件 class 引用同步替换"
```

---

## Task 8: i18n key 清理(tokenSource 共享 key + ctxTooltip)

**Files:**
- Modify: `src/i18n/types.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

**说明:** Task 3/4 已删除 drawer 专属 key。本 Task 删除 tokenSource 共享 key — 在 StatusLine 和 StatusDrawer 的 source-pill 都删除后,这 6 个 key(含 Title tooltip 变体)变为死代码。

- [ ] **Step 1: grep 确认 tokenSource key 无其他引用**

Run: `grep -r "tokenSource" src/ --include="*.ts" --include="*.svelte"`

Expected: 只在 `src/i18n/types.ts`、`zh.ts`、`en.ts` 中出现(types + 翻译),不在任何 .svelte 组件中出现。如果还有其他引用,停止本 Task 并报告。

- [ ] **Step 2: 删除 types.ts 中的 tokenSource key**

在 `src/i18n/types.ts` 中删除以下行:

```typescript
  'status.tokenSource.api': string;
  'status.tokenSource.streaming': string;
  'status.tokenSource.estimate': string;
  'status.tokenSource.apiTitle': string;
  'status.tokenSource.streamingTitle': string;
  'status.tokenSource.estimateTitle': string;
```

- [ ] **Step 3: 删除 zh.ts 和 en.ts 中的 tokenSource 翻译**

在 `src/i18n/zh.ts` 和 `src/i18n/en.ts` 中删除对应的 6 个 key。

- [ ] **Step 4: 删除 types.ts 中的 status.line.ctxTooltip**

```typescript
  'status.line.ctxTooltip': string;
```

同步删除 zh.ts 和 en.ts 中的翻译。

- [ ] **Step 5: 跑测试确保不破坏**

Run: `npx vitest run`
Expected: 662 tests passed,0 failed

- [ ] **Step 6: 跑 build 确保无 TS 编译错误**

Run: `npm run build`
Expected: 编译成功

- [ ] **Step 7: 提交**

```bash
git add src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "refactor(i18n): 删除 7 个死 key — tokenSource(6 含 Title) + ctxTooltip

source-pill 从 StatusLine 和 StatusDrawer 移除后,以下 key 变为死代码:
- status.tokenSource.api / .streaming / .estimate
- status.tokenSource.apiTitle / .streamingTitle / .estimateTitle(tooltip 文案)
- status.line.ctxTooltip(百分比已外移到 Header,不再需要 tooltip)"
```

---

## Task 9: 最终验证 + finishing-a-development-branch

**Files:** 无

- [ ] **Step 1: 跑全量测试**

Run: `npx vitest run`
Expected: 662 tests passed,0 failed(652 原有 + 10 新 tone 测试)

- [ ] **Step 2: 跑 build**

Run: `npm run build`
Expected: 编译成功,无 Svelte 警告

- [ ] **Step 3: 人工验证(npm run dev + Obsidian reload)**

在 Obsidian 中验证:
- [ ] Header 显示 R logo + 标题 + 百分比胶囊 + model badge
- [ ] badge 在 ready/thinking/error/unconfigured/indexing 5 种状态下颜色正确
- [ ] 百分比胶囊按阈值变色(0-79绿/80-94黄/95-100红)
- [ ] StatusLine 只显示 点 + 文字 + 箭头(无百分比)
- [ ] work 条在索引中显示"索引中 X/Y 文件"
- [ ] work 条在搜索中显示"搜索中..."
- [ ] work 条空闲时隐藏
- [ ] gate.hardBlockReason 时 work 条显示红字
- [ ] 抽屉上下文区只剩 used/max tokens + 压缩按钮
- [ ] 全局无 box-shadow
- [ ] 圆角全部 ≤8px
- [ ] 诊断面板样式正常(diag- → ratel-diag- 后样式不丢失)

- [ ] **Step 4: 触发 finishing-a-development-branch skill**

执行 Step 0(文档同步确认)+ Step 1(verify tests)+ Step 2-6(present options)。

按 AGENTS.md「文档同步规则」评估:
- README:不触发(无功能清单/安装/隐私变更)
- user-guide:不触发(无新斜杠命令/secret ID)
- CHANGELOG:标记待办(在 `[Unreleased]` 块补一行)
- ARCHITECTURE.md / adr/:不触发(纯 UI 改造,不改模块边界/端口契约)

---

## 自审

### 1. Spec 覆盖

| Spec Section | 对应 Task | 覆盖状态 |
|---|---|---|
| 4.1 Header 重构(logo + 胶囊 + badge 变色) | Task 1(tone)+ Task 2(Header) | ✅ |
| 4.2 StatusLine 简化 | Task 3 | ✅ |
| 4.3 Input 下方 work 条 | Task 5 | ✅ |
| 4.4 StatusDrawer 上下文区精简 | Task 4 | ✅ |
| 4.5.1 圆角违规修正(2 处) | Task 2(ChatView L512)+ Task 4(StatusDrawer L271) | ✅ |
| 4.5.2 box-shadow 违规删除(17+ 处) | Task 3(StatusLine)+ Task 4(StatusDrawer)+ Task 6(消息组件)+ Task 7(ChatView Input) | ✅ |
| 4.5.3 class 前缀违规(diag- → ratel-diag-) | Task 7 | ✅ |
| 4.5.4 注释修订 | Task 2 Step 4 | ✅ |
| i18n 新增 5 key | Task 5 | ✅ |
| i18n 删除 11 key(5 drawer + 6 tokenSource 含 Title) | Task 4(5 drawer)+ Task 8(6 tokenSource + ctxTooltip) | ✅ |

### 2. 占位符扫描

- 无 "TBD" / "TODO" / "fill in"
- 每个步骤都有具体代码或命令
- 无 "similar to Task N"(Task 4 的 Edit 步骤引用了精确行号和代码块)

### 3. 类型一致性

- `Tone` type 在 Task 1 定义,Task 2/3 import 使用,名称一致
- `deriveTone` 函数签名在 Task 1 定义,Task 2/3 调用,签名一致
- `workBar` 派生状态在 Task 5 定义,template 中引用 `workBar.type` 和 `workBar.text`,字段一致
- i18n key `chat.workbar.*` 在 Task 5 定义,在 Task 5 template 中引用,key 一致
- `headerTone` / `headerPct` / `headerCtxColor` 在 Task 2 定义,template 中引用,名称一致

### 4. 偏差说明

- **Task 4 Step 1**:保留了 `attachmentTokens` / `ctxColor` / `pct` 变量但用 `void` 抑制未使用警告。原因:删除这些变量需要同时删除 template 引用,但 template 精简后这些变量确实不再使用。保留并用 `void` 标注比删除更安全(避免连锁删除影响其他依赖)。subagent 执行时可选择直接删除这些变量(更干净),本 plan 保留以降低风险。
- **Task 7 Step 4**:diagnostics TS 文件的 `cls:` 字符串替换是机械操作,但量大(91 处)。subagent 执行时建议用 Edit 工具的 `replace_all` 逐文件处理(每个文件一次 `replace_all: true`),不是逐行 Edit。
- **Task 8**:删除 `status.line.ctxTooltip` key 在 spec 中未明确提及,但属于 Task 3 删除 ctx 块的连锁清理。plan 在 Task 8 补做,避免 i18n 死代码。
