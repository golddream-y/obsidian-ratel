# P-CHAT-MOTION-v2 — 聊天动效增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 v1 动效地基上完成三桶增强：空态 SoftAurora + Gradient 主句 + 轮换 hint + Noise 托盘；用户气泡 StarBorder；发送 Glare + 菜单 AnimatedList + StatusLine CountUp。

**Architecture:** 增量落在 `src/ui/motion/{empty,bubble,chrome}/`；继续走 `isChatMotionEnabled` 总闸；SoftAurora 剥 ogl 只抄 shader（受阻则同槽 Waves）；不新增 npm 动画库；不挂载 Magnet / cite Glass / Halftone。

**Tech Stack:** TypeScript / Svelte 5 / 原生 WebGL2 或 Canvas2D / CSS·WAAPI / Vitest / i18n

**Spec:** [S-CHAT-MOTION-v2](../specs/2026-08-12-chat-motion-v2-design.md)  
**前置:** S-CHAT-MOTION / P-CHAT-MOTION（Completed）；worktree 分支 `feat/p-chat-motion` 可继续或开 `feat/p-chat-motion-v2`

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- 测试 `it(...)` 中文：`行为 - 条件 - 期望结果`
- 文件头含 `@file` / `@description` / `@module`；翻译件含 `@origin` URL
- **禁止**新增 `ogl` / `gsap` / `motion` / `framer-motion` / `three` / Tailwind
- 装饰动效受 `chatMotionEnabled ∩ !prefers-reduced-motion` 约束；ThinkingOrb 不受影响
- 流式正文不做打字机；空态 WebGL/Canvas 仅 `messages.length===0`
- 回归：用户气泡右侧对齐；`snapScrollToBottom` instant；ClickSpark tick+body 叠层
- Commons Clause：NOTICE 增补本批上游；不可单独再分发 motion 包

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/motion/empty/empty-hints.ts` | 组装三条 hint i18n |
| `src/ui/motion/empty/soft-aurora-shaders.ts` | SoftAurora VERT/FRAG（自上游抄） |
| `src/ui/motion/empty/SoftAuroraBackdrop.svelte` | 柔光底；失败 CSS 降级 |
| `src/ui/motion/empty/GradientWelcome.svelte` | Gradient 着色包装 Blur 单元或整句 |
| `src/ui/motion/empty/NoiseTray.svelte` | 静态 noise 叠层 |
| `src/ui/motion/empty/RotateHint.svelte` | 多 hint 交叉轮换 |
| `src/ui/motion/empty/EmptyStage.svelte` | 重组接线（替换 Aurora / TypeLine） |
| `src/ui/motion/bubble/user-star-border.css` 或 `UserStarBorder.svelte` | 用户描边 |
| `src/ui/motion/chrome/GlareHover.svelte` | 发送悬停扫光 |
| `src/ui/motion/chrome/AnimatedList.svelte` | 菜单项 stagger |
| `src/ui/motion/chrome/count-up.ts` + `CountUp.svelte` | 数字 lerp |
| `src/ui/chat/message-stream/MessageBubble.svelte` | 用户 StarBorder class |
| `src/ui/chat/input/SlashMenu.svelte` | AnimatedList |
| `src/ui/chat/ChatView.svelte` | 会话菜单列表 + Glare 包发送 |
| `src/ui/status/StatusLine.svelte` | CountUp % |
| `src/i18n/*` | `chat.empty.hint.1/2/3` |
| `src/ui/motion/NOTICE.md` | 增补上游表 |
| `docs/user-guide.md` | 动效一句（若已有则微调） |
| `tests/ui/motion/**` | 纯函数与策略测 |

**明确不创建：** Magnet、GradualBlur、SpotlightCard、Halftone、MaskedHeading。

---

### Task 1: i18n 三 hint + emptyHints 助手

**Files:**
- Create: `src/ui/motion/empty/empty-hints.ts`
- Create: `tests/ui/motion/empty-hints.test.ts`
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`

**Interfaces:**
- Produces:
  - `export type EmptyHintKey = 'chat.empty.hint.1' | 'chat.empty.hint.2' | 'chat.empty.hint.3'`
  - `export const EMPTY_HINT_KEYS: EmptyHintKey[]`
  - `export function resolveEmptyHints(t: (k: string) => string): string[]` — 长度恒为 3；缺译时回退 `chat.empty.hint`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/motion/empty-hints.test.ts
 * @description 空态副句 hint 列表组装
 */
import { describe, it, expect } from 'vitest';
import { EMPTY_HINT_KEYS, resolveEmptyHints } from '../../../src/ui/motion/empty/empty-hints';

describe('empty-hints', () => {
	it('EMPTY_HINT_KEYS - 长度 - 为 3', () => {
		expect(EMPTY_HINT_KEYS).toHaveLength(3);
	});

	it('resolveEmptyHints - 三键齐全 - 返回三句', () => {
		const map: Record<string, string> = {
			'chat.empty.hint.1': 'a',
			'chat.empty.hint.2': 'b',
			'chat.empty.hint.3': 'c',
			'chat.empty.hint': 'fallback',
		};
		expect(resolveEmptyHints((k) => map[k] ?? k)).toEqual(['a', 'b', 'c']);
	});

	it('resolveEmptyHints - 缺键 - 回退 chat.empty.hint', () => {
		const map: Record<string, string> = { 'chat.empty.hint': 'only' };
		expect(resolveEmptyHints((k) => map[k] ?? '')).toEqual(['only', 'only', 'only']);
	});
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/ui/motion/empty-hints.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 + i18n**

```typescript
/**
 * @file src/ui/motion/empty/empty-hints.ts
 * @description 空态副句轮换文案键
 * @module ui/motion/empty/empty-hints
 */
export type EmptyHintKey = 'chat.empty.hint.1' | 'chat.empty.hint.2' | 'chat.empty.hint.3';

export const EMPTY_HINT_KEYS: EmptyHintKey[] = [
	'chat.empty.hint.1',
	'chat.empty.hint.2',
	'chat.empty.hint.3',
];

export function resolveEmptyHints(t: (k: string) => string): string[] {
	const fallback = t('chat.empty.hint') || '';
	return EMPTY_HINT_KEYS.map((k) => {
		const v = t(k);
		return v && v !== k ? v : fallback;
	});
}
```

`types.ts` 在 `ChatStrings` 增加三键；`zh.ts` / `en.ts` 示例：

```typescript
'chat.empty.hint.1': '直接提问，或输入 / 看命令',
'chat.empty.hint.2': '试试「总结这周笔记」',
'chat.empty.hint.3': '用 @ 点名库里的某篇',
// en 对应三条英文；保留原 chat.empty.hint 与 hint.1 同文以兼容
```

- [ ] **Step 4: 跑测通过**

Run: `npx vitest run tests/ui/motion/empty-hints.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/motion/empty/empty-hints.ts tests/ui/motion/empty-hints.test.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "$(cat <<'EOF'
feat(motion): 空态副句三 hint i18n 与组装助手

EOF
)"
```

---

### Task 2: SoftAuroraBackdrop（替换空态 Aurora）

**Files:**
- Create: `src/ui/motion/empty/soft-aurora-shaders.ts`
- Create: `src/ui/motion/empty/SoftAuroraBackdrop.svelte`
- Modify: `src/ui/motion/empty/EmptyStage.svelte`（改用 SoftAurora；删/停挂旧 Aurora）
- Test: `tests/ui/motion/soft-aurora-fallback.test.ts`（复用/扩展 `shouldUseAuroraFallback` 或新 `shouldUseSoftAuroraFallback`）

**Interfaces:**
- Consumes: v1 `probeWebGL2Support` / fallback 工具（可从 `aurora-fallback.ts` 复用）
- Produces: `<SoftAuroraBackdrop enabled color1 color2 speed … />`；`enabled=false` 不建 GL

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/motion/soft-aurora-fallback.test.ts
 * @description SoftAurora 降级策略
 */
import { describe, it, expect } from 'vitest';
import { shouldUseAuroraFallback } from '../../../src/ui/motion/empty/aurora-fallback';

describe('soft-aurora-fallback', () => {
	it('shouldUseAuroraFallback - enabled 且无 webgl2 - true', () => {
		expect(shouldUseAuroraFallback(true, false)).toBe(true);
	});
	it('shouldUseAuroraFallback - enabled 且有 webgl2 - false', () => {
		expect(shouldUseAuroraFallback(true, true)).toBe(false);
	});
	it('shouldUseAuroraFallback - 关闭动效 - true（走静态，不挂 GL）', () => {
		expect(shouldUseAuroraFallback(false, true)).toBe(true);
	});
});
```

（若 v1 已有等价测，本 Task 可改为「断言 EmptyStage 在 motionOn 时渲染 SoftAurora 根 class」的纯函数配置测；禁止为测而起 jsdom WebGL。）

- [ ] **Step 2: 跑测**

Run: `npx vitest run tests/ui/motion/soft-aurora-fallback.test.ts`

- [ ] **Step 3: 实现 SoftAurora**

1. 从上游 `SoftAurora.tsx` **原文抄** `vertexShader` / `fragmentShader` 到 `soft-aurora-shaders.ts`，导出 `SOFT_AURORA_VERT` / `SOFT_AURORA_FRAG`（WebGL1 风格 attribute 可按 v1 Aurora 模式升到 `#version 300 es` + `in`/`out`，或保持 WebGL1 + `webgl` context——**与现网 AuroraBackdrop 同一 GL 代际**，避免双栈）。  
2. `SoftAuroraBackdrop.svelte` 镜像 `AuroraBackdrop.svelte` 生命周期：`ResizeObserver`、`IntersectionObserver`、`visibilitychange`、teardown。  
3. 默认色：`color1=#e8c49a`、`color2=#3d5a56`（暖铜+青灰）；`brightness`/`bandHeight` 按上游默认略提亮。  
4. `EmptyStage`：`{#if motionOn}<SoftAuroraBackdrop />{/if}`；**不再**挂 `AuroraBackdrop`（文件可保留供回滚，但 EmptyStage 不引用）。  
5. 若 WebGL 编译失败：`console.error` + CSS 双径向呼吸（沿用 EmptyStage 现 veil 或 SoftAurora fallback class）。

- [ ] **Step 4: build 烟雾**

Run: `npm run build`  
Expected: 成功

- [ ] **Step 5: Commit**

```bash
git add src/ui/motion/empty/soft-aurora-shaders.ts src/ui/motion/empty/SoftAuroraBackdrop.svelte src/ui/motion/empty/EmptyStage.svelte tests/ui/motion/soft-aurora-fallback.test.ts
git commit -m "$(cat <<'EOF'
feat(motion): 空态 SoftAurora 柔光底替换 Aurora

EOF
)"
```

**回退约定：** 若 SoftAurora 在 Obsidian 实机不可用，同 Task 内改挂 Canvas **Waves**（上游 `Waves.tsx` 剥依赖），仍占 SoftAurora 插槽；commit message 注明 `fallback: Waves`。

---

### Task 3: Gradient 主句 + Noise 托盘

**Files:**
- Create: `src/ui/motion/empty/GradientWelcome.svelte`
- Create: `src/ui/motion/empty/NoiseTray.svelte`
- Modify: `src/ui/motion/empty/WelcomeBlurText.svelte`（或 EmptyStage 外包 Gradient）
- Modify: `src/ui/motion/empty/EmptyStage.svelte`

**Interfaces:**
- Produces:
  - `GradientWelcome` props: `{ text: string; play: boolean }` — 内部仍用 `WelcomeBlurText` 或复制 span stagger，文字色改为 `background-clip:text`
  - `NoiseTray`：无 props；绝对定位 `pointer-events:none`；opacity ≤ 0.06

- [ ] **Step 1: 写样式契约测（可选纯函数）** — 若无可测纯逻辑，本 Task 以 build + 目视为主；至少加：

```typescript
// tests/ui/motion/noise-opacity.test.ts
import { describe, it, expect } from 'vitest';
/** Noise 透明度上限 — 防止过噪伤可读 */
export const NOISE_OPACITY_MAX = 0.08;
it('NOISE_OPACITY_MAX - 常量 - 不超过 0.08', () => {
	expect(NOISE_OPACITY_MAX).toBeLessThanOrEqual(0.08);
});
```

实现里 `NoiseTray` 使用同一常量导出。

- [ ] **Step 2: 实现 GradientWelcome**

关键 CSS（scoped）：

```css
.ratel-gradient-welcome :global(.ratel-welcome-blur-unit),
.ratel-gradient-welcome :global(.ratel-welcome-blur-static) {
	background: linear-gradient(
		120deg,
		color-mix(in srgb, var(--text-normal) 70%, var(--interactive-accent) 30%),
		color-mix(in srgb, var(--interactive-accent) 55%, #e8c49a 45%),
		color-mix(in srgb, var(--text-normal) 75%, #3d5a56 25%)
	);
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
}
```

`play=false` 时仍显示渐变静态全文。

- [ ] **Step 3: NoiseTray**

```svelte
<!-- 静态 SVG fractalNoise，不每帧重绘 -->
<div class="ratel-noise-tray" aria-hidden="true" style:opacity={NOISE_OPACITY_MAX}>
	<svg width="100%" height="100%">…</svg>
</div>
```

放进 EmptyStage `.has-glass` 内容盒内，z-index 在文字下。

- [ ] **Step 4: EmptyStage 接线 + build**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): 空态 Gradient 主句与 Noise 托盘

EOF
)"
```

---

### Task 4: RotateHint 替换 WelcomeTypeLine

**Files:**
- Create: `src/ui/motion/empty/RotateHint.svelte`
- Create: `tests/ui/motion/rotate-hint-policy.test.ts`
- Modify: `src/ui/motion/empty/EmptyStage.svelte`（用 RotateHint；可保留 WelcomeTypeLine 文件但空态不引用）

**Interfaces:**
- Produces:
  - `export function nextHintIndex(i: number, len: number): number`
  - `RotateHint` props: `{ hints: string[]; play: boolean; intervalMs?: number }` 默认 `intervalMs=3200`
  - `play=false` → 只显示 `hints[0]`；卸载时清 timer

- [ ] **Step 1: 失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { nextHintIndex } from '../../../src/ui/motion/empty/rotate-hint-policy';

describe('rotate-hint-policy', () => {
	it('nextHintIndex - 末项 - 回到 0', () => {
		expect(nextHintIndex(2, 3)).toBe(0);
	});
	it('nextHintIndex - 中段 - +1', () => {
		expect(nextHintIndex(0, 3)).toBe(1);
	});
	it('nextHintIndex - len 0 - 0', () => {
		expect(nextHintIndex(0, 0)).toBe(0);
	});
});
```

- [ ] **Step 2: 实现 policy + RotateHint**

```typescript
// rotate-hint-policy.ts
export function nextHintIndex(i: number, len: number): number {
	if (len <= 0) return 0;
	return (i + 1) % len;
}
```

`RotateHint.svelte`：双层交叉淡入（当前/下一）；`$effect` 在 `play && hints.length>1` 时 `setInterval`；`onDestroy` 清理。

EmptyStage：

```svelte
const hints = $derived(resolveEmptyHints((k) => $t(k as any)));
…
<RotateHint {hints} play={motionOn} />
```

- [ ] **Step 3: 测过 + build**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): 空态副句 RotateHint 轮换

EOF
)"
```

---

### Task 5: 用户 StarBorder + 右对齐回归

**Files:**
- Create: `src/ui/motion/bubble/star-border.css`（或 `UserStarBorder.svelte` 仅 class 包装）
- Modify: `src/ui/chat/message-stream/MessageBubble.svelte`
- Create: `tests/ui/motion/fade-align-contract.test.ts`（文档化 FadeIn 必须 flex column）
- Verify: `src/ui/motion/enter/FadeIn.svelte` 已含 `display:flex; flex-direction:column; width:100%`

**Interfaces:**
- 用户气泡在 `motionOn` 时加 `ratel-msg-user--star`（或始终加样式、动画仅 motionOn）

- [ ] **Step 1: 契约测**

```typescript
/**
 * @file tests/ui/motion/fade-align-contract.test.ts
 * @description FadeIn 源码须保持 flex 列，否则用户 align-self:flex-end 失效
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('fade-align-contract', () => {
	it('FadeIn.svelte - 样式 - 含 flex column 与 width 100%', () => {
		const src = readFileSync(
			resolve(__dirname, '../../../src/ui/motion/enter/FadeIn.svelte'),
			'utf8',
		);
		expect(src).toMatch(/display:\s*flex/);
		expect(src).toMatch(/flex-direction:\s*column/);
		expect(src).toMatch(/width:\s*100%/);
	});
});
```

- [ ] **Step 2: StarBorder CSS**

抄上游 `StarBorder.tsx` 的扫边思路 → 纯 CSS：

```css
.ratel-msg-user--star {
	position: relative;
	isolation: isolate;
}
.ratel-msg-user--star::before {
	content: '';
	position: absolute;
	inset: -1px;
	border-radius: inherit;
	padding: 1px;
	background: linear-gradient(
		var(--ratel-star-angle, 0deg),
		transparent 30%,
		color-mix(in srgb, var(--interactive-accent) 70%, #e8c49a) 50%,
		transparent 70%
	);
	-webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
	mask-composite: exclude;
	pointer-events: none;
	z-index: -1;
	animation: ratel-star-spin 6s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
	.ratel-msg-user--star::before { animation: none; opacity: 0.55; }
}
```

MessageBubble：`class:ratel-msg-user--star={msg.role === 'user' && motionOn}`。

- [ ] **Step 3: 测过 + build**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): 用户气泡 StarBorder 与 FadeIn 右对齐契约测

EOF
)"
```

---

### Task 6: GlareHover 包发送钮

**Files:**
- Create: `src/ui/motion/chrome/GlareHover.svelte`
- Modify: `src/ui/chat/ChatView.svelte`（ClickSpark 内或外包 Glare；Stop 态可 `enabled=false`）

**Interfaces:**
- Props: `{ enabled?: boolean; children: Snippet }`
- pointermove 更新 CSS 变量 `--ratel-glare-x/y`；`enabled=false` 无监听

- [ ] **Step 1: 实现 GlareHover**（上游 GlareHover 剥依赖，~70 行）

```svelte
<div
	class="ratel-glare"
	class:is-on={enabled}
	bind:this={root}
	onpointermove={enabled ? onMove : undefined}
	onpointerleave={enabled ? onLeave : undefined}
>
	{#if enabled}<div class="ratel-glare-shine" aria-hidden="true"></div>{/if}
	{@render children()}
</div>
```

- [ ] **Step 2: ChatView 接线**

```svelte
<ClickSpark enabled={chatMotionOn} tick={sendSparkTick}>
	<GlareHover enabled={chatMotionOn && !isRunning}>
		<!-- send / stop button -->
	</GlareHover>
</ClickSpark>
```

注意 snippet 嵌套：若 ClickSpark 只用 children snippet，则 Glare 放在 snippet 内包住 button。

- [ ] **Step 3: build**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): 发送钮 GlareHover 悬停扫光

EOF
)"
```

---

### Task 7: AnimatedList → SlashMenu + 会话菜单

**Files:**
- Create: `src/ui/motion/chrome/animated-list-policy.ts`
- Create: `src/ui/motion/chrome/AnimatedList.svelte`（或纯 class + stagger delay 工具）
- Create: `tests/ui/motion/animated-list-policy.test.ts`
- Modify: `src/ui/chat/input/SlashMenu.svelte`
- Modify: `src/ui/chat/ChatView.svelte`（会话下拉 `{#each sessionEntries}` 项）

**Interfaces:**
- `export const ANIMATED_LIST_STAGGER_CAP = 24`
- `export function staggerDelayMs(index: number, cap?: number): number | null` — `index>=cap` 返回 `null`（表示整组一次，由调用方给 0）
- 默认 step 40ms

- [ ] **Step 1: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { ANIMATED_LIST_STAGGER_CAP, staggerDelayMs } from '../../../src/ui/motion/chrome/animated-list-policy';

describe('animated-list-policy', () => {
	it('staggerDelayMs - 第 0 项 - 0', () => {
		expect(staggerDelayMs(0)).toBe(0);
	});
	it('staggerDelayMs - 第 3 项 - 120', () => {
		expect(staggerDelayMs(3)).toBe(120);
	});
	it('staggerDelayMs - 超过 cap - null', () => {
		expect(staggerDelayMs(ANIMATED_LIST_STAGGER_CAP)).toBeNull();
	});
});
```

- [ ] **Step 2: SlashMenu**

```svelte
import { isChatMotionEnabled } from '../../motion/prefs';
import { settings$ } from '../../settings-store';
import { staggerDelayMs } from '../../motion/chrome/animated-list-policy';

const motionOn = $derived(isChatMotionEnabled($settings$));
…
{#each commands as cmd, i}
	<div
		class="ratel-sm-item"
		class:ratel-sm-enter={motionOn}
		style:animation-delay={motionOn ? `${staggerDelayMs(i) ?? 0}ms` : '0ms'}
		…
	>
```

CSS `@keyframes ratel-sm-enter`：opacity 0→1、translateY(6px→0)、220ms。`prefers-reduced-motion` 关闭。

会话菜单：同样 class 接到 `sessionEntries` 行（找 `ratel-session-menu` 列表项 class名，按现网改）。

- [ ] **Step 3: 测过 + build**

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): 斜杠与会话菜单 AnimatedList stagger

EOF
)"
```

---

### Task 8: CountUp → StatusLine 上下文 %

**Files:**
- Create: `src/ui/motion/chrome/count-up.ts`
- Create: `src/ui/motion/chrome/CountUp.svelte`
- Create: `tests/ui/motion/count-up.test.ts`
- Modify: `src/ui/status/StatusLine.svelte`

**Interfaces:**
- `export function easeOutCount(t: number): number` — `1 - (1-t)^3`
- `export function lerpCount(from: number, to: number, t: number): number`
- `CountUp` props: `{ value: number; enabled: boolean; durationMs?: number }` 默认 360；`enabled=false` 显示 `value` 瞬时
- 展示：`Math.round(display)` + 调用方加 `%`

- [ ] **Step 1: 测试**

```typescript
import { describe, it, expect } from 'vitest';
import { easeOutCount, lerpCount } from '../../../src/ui/motion/chrome/count-up';

describe('count-up', () => {
	it('lerpCount - t=0 - from', () => {
		expect(lerpCount(10, 50, 0)).toBe(10);
	});
	it('lerpCount - t=1 - to', () => {
		expect(lerpCount(10, 50, 1)).toBe(50);
	});
	it('easeOutCount - 0 与 1 - 端点', () => {
		expect(easeOutCount(0)).toBe(0);
		expect(easeOutCount(1)).toBe(1);
	});
});
```

- [ ] **Step 2: CountUp.svelte**

`$effect` 追踪 `value`：若 `!enabled` 设 `display=value`；否则自 `display` lerp 到 `value`，rAF 循环，`durationMs≤400`。

- [ ] **Step 3: StatusLine**

```svelte
import CountUp from '../motion/chrome/CountUp.svelte';
import { isChatMotionEnabled } from '../motion/prefs';
import { settings$ as settingsStore } from '../settings-store';
const motionOn = $derived(isChatMotionEnabled($settingsStore));
…
<span class="ratel-sl-pct" style:color={pctColor}>
	<CountUp value={pct} enabled={motionOn} />%
</span>
```

（按现网 `%` 节点结构微调，勿破坏 aria。）

- [ ] **Step 4: 测过 + build**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): StatusLine 上下文占用 CountUp

EOF
)"
```

---

### Task 9: NOTICE / user-guide / 回归验证

**Files:**
- Modify: `src/ui/motion/NOTICE.md`
- Modify: `docs/user-guide.md`（动效小节补 v2 能力一句）
- Modify: `docs/superpowers/STATUS.md`（plan → Completed 待执行时先保持 In Progress）
- Verify: sticky-scroll 测、fade-play-policy、empty-hints、本计划全部 motion 测、全量 `npm test`、`npm run build`

**NOTICE 增补行（示例）：**

| 本地 | 上游 |
|---|---|
| `empty/SoftAuroraBackdrop.svelte` | Backgrounds/SoftAurora |
| `empty/GradientWelcome.svelte` | TextAnimations/GradientText |
| `empty/RotateHint.svelte` | TextAnimations/RotatingText |
| `empty/NoiseTray.svelte` | Animations/Noise |
| `bubble/*` StarBorder | Components/StarBorder |
| `chrome/GlareHover.svelte` | Animations/GlareHover |
| `chrome/AnimatedList*` | Components/AnimatedList |
| `chrome/CountUp*` | TextAnimations/CountUp |

- [ ] **Step 1: 更新 NOTICE + user-guide**

user-guide 示例句：「聊天装饰动效（可关）：空态柔光与轮换提示、用户气泡描边、发送扫光、菜单入场、上下文占用数字过渡；忙态思考球不受此开关影响。」

- [ ] **Step 2: 回归命令**

```bash
npx vitest run tests/ui/motion tests/ui/chat/sticky-scroll.test.ts
npm test
npm run build
```

Expected: 全绿；build 成功。

- [ ] **Step 3: Sandbox 手工清单**

1. 空会话：柔光 + 渐变主句 + hint 轮换 + 托盘噪点  
2. 关「聊天装饰动效」：静态、无 GL  
3. 发消息：用户右侧 + 描边；助手素文；火花+glare  
4. `/` 菜单 stagger；上下文 % 变化有短过渡  
5. 长回复贴底；上滑停滚  

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs(motion): v2 NOTICE 与 user-guide；回归清单

EOF
)"
```

---

## Plan 自审

| Spec 要求 | Task |
|---|---|
| SoftAurora（失败 Waves） | T2 |
| Gradient + Blur | T3 |
| Rotate hints 1/2/3 | T1+T4 |
| Noise 托盘 | T3 |
| StarBorder 用户 + 右对齐 | T5 |
| GlareHover | T6 |
| AnimatedList 菜单 | T7 |
| CountUp StatusLine | T8 |
| NOTICE / 文档 / 贴底回归 | T9 |
| 不做 Magnet/Glass/Halftone/MaskedHeading | 全局约束 + 文件结构声明 |

占位符扫描：无 TBD；回退路径写在 T2。  
类型名：`resolveEmptyHints` / `nextHintIndex` / `staggerDelayMs` / `lerpCount` 前后一致。

---

## 执行交接

Plan complete and saved to `docs/superpowers/plans/2026-08-12-chat-motion-v2.md`.

**Two execution options:**

1. **Subagent-Driven（推荐）** — 每 Task 新 subagent，两阶段审查  
2. **Inline Execution** — 本会话按 executing-plans 连续做，设检查点  

**Which approach?**
