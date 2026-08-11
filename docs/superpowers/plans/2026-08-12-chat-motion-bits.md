# P-CHAT-MOTION — 聊天动效 Bits 翻译 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 react-bits 的 Aurora / BlurText / TextType / Fade / ShinyText / ClickSpark 译成无重依赖的 Svelte 5 组件，接入空态、消息入场、标题落定、品牌与发送微光，并带总开关与 reduced-motion。

**Architecture:** `src/ui/motion/` vendor（抄上游时序与参数，剥 ogl/motion/gsap/Tailwind）；`prefs.ts` 统一闸门；`MessageList` / `MessageBubble` / `ChatView` 编排。忙态继续 ThinkingOrb，空态才挂 Aurora。

**Tech Stack:** TypeScript / Svelte 5 / Canvas2D + 原生 WebGL2 / CSS·WAAPI / Vitest / Obsidian settings + i18n

**Spec:** [S-CHAT-MOTION](../specs/2026-08-12-chat-motion-bits-design.md)

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- 测试 `it(...)` 中文：`行为 - 条件 - 期望结果`
- 文件头 / 导出按 AGENTS.md 中文注释；翻译文件含 `@origin` URL
- **禁止**新增 `ogl` / `gsap` / `motion` / `framer-motion` / Tailwind 依赖
- **禁止**与 `$state` 同名的 prop（用 `orbState` 同类命名）
- Commons Clause：组件只作为插件内嵌；NOTICE 写明不可单独再分发 motion 包
- `prefers-reduced-motion` 或 `chatMotionEnabled===false` → 装饰动效静默
- 流式正文 **不做** 打字机；块级入场只播一次
- Obsidian `button` 几何重置放 `styles.css`（同 `ratel-send` / `ratel-perm-btn`）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/motion/prefs.ts` | `isChatMotionEnabled(settings)` |
| `src/ui/motion/NOTICE.md` / `LICENSE.react-bits.md` | 溯源与许可 |
| `src/ui/motion/empty/AuroraBackdrop.svelte` | Aurora shader → WebGL2 |
| `src/ui/motion/empty/WelcomeBlurText.svelte` | BlurText → spans+CSS |
| `src/ui/motion/empty/WelcomeTypeLine.svelte` | TextType 一次 |
| `src/ui/motion/empty/EmptyStage.svelte` | 空态组合 |
| `src/ui/motion/enter/FadeIn.svelte` | 通用入场 |
| `src/ui/motion/title/TitleDissolve.svelte` | 标题落定 |
| `src/ui/motion/brand/ShinyBrand.svelte` | Header 扫光 |
| `src/ui/motion/brand/ClickSpark.svelte` | 发送火花 |
| `src/settings.ts` | `chatMotionEnabled` + 外观 toggle |
| `src/i18n/*` | 设置与空态文案 |
| `MessageList.svelte` / `MessageBubble.svelte` / `ChatView.svelte` | 编排 |
| `styles.css` | 入场/扫光全局关键帧（若需压 Obsidian） |
| `tests/ui/motion/prefs.test.ts` 等 | 闸门与纯逻辑 |
| `docs/user-guide.md` / `CHANGELOG.md` / `STATUS.md` | 文档 |

---

### Task 1: prefs + settings + i18n（闸门）

**Files:**
- Create: `src/ui/motion/prefs.ts`
- Create: `tests/ui/motion/prefs.test.ts`
- Modify: `src/settings.ts`（字段、DEFAULT、外观 Tab toggle）
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`

**Interfaces:**
- Produces:
  - `export function prefersMotionReduced(): boolean`
  - `export function isChatMotionEnabled(settings: { chatMotionEnabled?: boolean }): boolean`
  - `RatelVaultSettings.chatMotionEnabled: boolean` 默认 `true`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/motion/prefs.test.ts
 * @description 聊天动效总闸门
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isChatMotionEnabled, prefersMotionReduced } from '../../../src/ui/motion/prefs';

describe('prefs', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('isChatMotionEnabled - 默认缺字段 - true（需未 reduce）', () => {
		vi.stubGlobal('matchMedia', (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		expect(isChatMotionEnabled({})).toBe(true);
		expect(isChatMotionEnabled({ chatMotionEnabled: true })).toBe(true);
	});

	it('isChatMotionEnabled - 设置为 false - false', () => {
		vi.stubGlobal('matchMedia', (q: string) => ({
			matches: false,
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		expect(isChatMotionEnabled({ chatMotionEnabled: false })).toBe(false);
	});

	it('isChatMotionEnabled - prefers-reduced-motion - false', () => {
		vi.stubGlobal('matchMedia', (q: string) => ({
			matches: q.includes('prefers-reduced-motion'),
			media: q,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));
		expect(prefersMotionReduced()).toBe(true);
		expect(isChatMotionEnabled({ chatMotionEnabled: true })).toBe(false);
	});
});
```

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run tests/ui/motion/prefs.test.ts`  
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 prefs.ts**

```typescript
/**
 * @file src/ui/motion/prefs.ts
 * @description 聊天装饰动效总闸门（设置 ∩ reduced-motion）
 * @module ui/motion/prefs
 */

export function prefersMotionReduced(): boolean {
	if (typeof matchMedia === 'undefined') return false;
	return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 是否播放装饰动效（空态/入场/扫光/火花）。忙态 ThinkingOrb 自有闸门，不经此函数。
 */
export function isChatMotionEnabled(settings: { chatMotionEnabled?: boolean }): boolean {
	if (settings.chatMotionEnabled === false) return false;
	return !prefersMotionReduced();
}
```

- [ ] **Step 4: settings + i18n**

在 `RatelVaultSettings` 与 `DEFAULT_SETTINGS` 增加 `chatMotionEnabled: true`。  
外观 Tab 在 `chatNavRailEnabled` 旁加 toggle：

```typescript
{
	name: tNow('settings.chatMotionEnabled.name'),
	desc: tNow('settings.chatMotionEnabled.desc'),
	control: { type: 'toggle', key: 'chatMotionEnabled' },
},
```

i18n keys（中英）：

- `settings.chatMotionEnabled.name` / `.desc`
- `chat.empty.welcome`（主句，如「有什么想从库里挖的？」）
- `chat.empty.hint`（副句，如「直接提问，或输入 / 看命令」）

- [ ] **Step 5: 跑测通过并提交**

Run: `npx vitest run tests/ui/motion/prefs.test.ts`  
Expected: PASS

```bash
git add src/ui/motion/prefs.ts tests/ui/motion/prefs.test.ts src/settings.ts src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "$(cat <<'EOF'
feat(motion): 聊天动效总闸门与设置项

EOF
)"
```

---

### Task 2: NOTICE / LICENSE 脚手架

**Files:**
- Create: `src/ui/motion/LICENSE.react-bits.md`（从 https://raw.githubusercontent.com/DavidHDev/react-bits/main/LICENSE.md 全文拷贝）
- Create: `src/ui/motion/NOTICE.md`

- [ ] **Step 1: 写入 NOTICE.md**

```markdown
# react-bits 溯源（聊天动效）

本目录含 [react-bits](https://github.com/DavidHDev/react-bits)（MIT + Commons Clause，© 2026 David Haz）组件的 **剥依赖翻译**：

| 本地 | 上游 |
|---|---|
| `empty/AuroraBackdrop.svelte` | Backgrounds/Aurora（shader；无 ogl） |
| `empty/WelcomeBlurText.svelte` | TextAnimations/BlurText（无 motion） |
| `empty/WelcomeTypeLine.svelte` | TextAnimations/TextType |
| `enter/FadeIn.svelte` | Animations/Fade Content（参数级） |
| `brand/ShinyBrand.svelte` | TextAnimations/ShinyText（无 motion） |
| `brand/ClickSpark.svelte` | Animations/ClickSpark |
| `title/TitleDissolve.svelte` | BlurText 短时变体 |

完整许可见 `LICENSE.react-bits.md`。

**Commons Clause：** 允许作为 Ratel 插件应用的一部分分发；**禁止**将本目录再打包为独立组件库出售或再分发。
```

- [ ] **Step 2: 拷贝 LICENSE 全文到 `LICENSE.react-bits.md`**

- [ ] **Step 3: Commit**

```bash
git add src/ui/motion/NOTICE.md src/ui/motion/LICENSE.react-bits.md
git commit -m "$(cat <<'EOF'
docs(motion): 登记 react-bits 溯源与 Commons Clause

EOF
)"
```

---

### Task 3: AuroraBackdrop（空态背景）

**Files:**
- Create: `src/ui/motion/empty/AuroraBackdrop.svelte`
- Create: `src/ui/motion/empty/aurora-shaders.ts`（VERT/FRAG 字符串，自上游 Aurora.tsx 抄）
- Optional test: WebGL 在 jsdom 常缺，逻辑测「无 gl 时走 CSS 降级 class」可用纯函数拆出

**Interfaces:**
- Produces: `<AuroraBackdrop enabled={boolean} />`  
  - `enabled=false` 或无 WebGL → 渲染 `.ratel-aurora-fallback` CSS 呼吸，不跑 rAF  
  - `onDestroy`：cancelAnimationFrame + loseContext + 卸 canvas  
- Consumes: 无；颜色默认从 CSS 读不到时用 accent 近似 hex（`#7c5cff` 级），允许 props `colorStops?: [string, string, string]`

**上游：**  
`https://cdn.jsdelivr.net/gh/DavidHDev/react-bits@main/src/ts-default/Backgrounds/Aurora/Aurora.tsx`

- [ ] **Step 1: 抄 VERT/FRAG 到 `aurora-shaders.ts`**（保持 shader 数学不变；文件头 `@origin`）

- [ ] **Step 2: 实现 AuroraBackdrop.svelte**

要点（完整实现时按此结构）：

```svelte
<script lang="ts">
	/**
	 * @file src/ui/motion/empty/AuroraBackdrop.svelte
	 * @origin https://github.com/DavidHDev/react-bits/.../Aurora/Aurora.tsx
	 * @description Aurora 背景：原生 WebGL2，无 ogl
	 */
	interface Props {
		enabled?: boolean;
		colorStops?: [string, string, string];
		amplitude?: number;
		blend?: number;
		speed?: number;
	}
	let {
		enabled = true,
		colorStops = ['#5b4a3a', '#c4a574', '#5b4a3a'],
		amplitude = 0.85,
		blend = 0.55,
		speed = 0.7,
	}: Props = $props();

	let hostEl: HTMLDivElement | undefined = $state();
	// $effect: enabled 且 host 存在 → 建 gl；否则 CSS fallback
	// resize: ResizeObserver
	// visibilitychange / IntersectionObserver: 停 rAF
</script>

<div class="ratel-aurora" class:is-fallback={!enabled} bind:this={hostEl} aria-hidden="true"></div>
```

色停用暖铜/纸感，对齐 Ratel 而非上游默认紫绿。

- [ ] **Step 3: 手工验证清单（实现者在 Sandbox）**

- 空会话可见极淡极光  
- 关插件 / 切会话有消息后组件卸载无泄漏（无持续 rAF）  
- DevTools 无 `ogl` 引用

- [ ] **Step 4: Commit**

```bash
git add src/ui/motion/empty/aurora-shaders.ts src/ui/motion/empty/AuroraBackdrop.svelte
git commit -m "$(cat <<'EOF'
feat(motion): 翻译 Aurora 为空态 WebGL2 背景

EOF
)"
```

---

### Task 4: WelcomeBlurText + WelcomeTypeLine + EmptyStage + MessageList 接入

**Files:**
- Create: `src/ui/motion/empty/WelcomeBlurText.svelte`
- Create: `src/ui/motion/empty/WelcomeTypeLine.svelte`
- Create: `src/ui/motion/empty/EmptyStage.svelte`
- Create: `tests/ui/motion/split-units.test.ts`（分词 / 是否静态）
- Modify: `src/ui/chat/message-stream/MessageList.svelte`

**Interfaces:**
- `WelcomeBlurText`: `{ text: string; play: boolean }` — `play=false` 时直接静态全文  
- `WelcomeTypeLine`: `{ text: string; play: boolean; charMs?: number }` — 打完停止  
- `EmptyStage`: `{ motionOn: boolean }` — 组合背景+主句+副句  
- MessageList: `messages.length===0` 时渲染 EmptyStage；`motionOn={isChatMotionEnabled($settings)}`

**上游 BlurText 参数（必须保留量级）：**  
`delay≈80–120ms/词`，`stepDuration≈0.35`，`blur(10px)→0`，`y: ±12`（侧栏收窄，勿用上游 y:50）

- [ ] **Step 1: 分词测**

```typescript
import { splitBlurUnits } from '../../../src/ui/motion/empty/blur-split';
// 实现: words 按空格；中文无空格时按字（或整句一段）
it('splitBlurUnits - 英文词 - 按空格', () => {
	expect(splitBlurUnits('Hello vault', 'words')).toEqual(['Hello', 'vault']);
});
```

- [ ] **Step 2: 实现 blur-split + WelcomeBlurText（CSS animation + stagger delay）**

- [ ] **Step 3: WelcomeTypeLine — `setInterval` 逐字，`play=false` 显示全文**

- [ ] **Step 4: EmptyStage 组合；MessageList 在列表空时插入**

```svelte
{#if messages.length === 0}
	<EmptyStage motionOn={motionOn} />
{/if}
```

`motionOn` 由 ChatView 传入或 MessageList 内读 settings store（与现有 `$settingsStore` 模式一致）。

- [ ] **Step 5: 测 + commit**

```bash
git add src/ui/motion/empty tests/ui/motion/split-units.test.ts src/ui/chat/message-stream/MessageList.svelte
git commit -m "$(cat <<'EOF'
feat(motion): 空会话 Aurora + Blur/Type 欢迎台

EOF
)"
```

---

### Task 5: FadeIn — 消息与 cite 入场

**Files:**
- Create: `src/ui/motion/enter/FadeIn.svelte`
- Create: `tests/ui/motion/fade-in-policy.test.ts`
- Modify: `MessageBubble.svelte`
- Modify: cite chip 渲染处（`MessageBubble` / `SearchResults` / `MarkdownView` 以实际 chip 节点为准；**内联 `[n]`** 用 class `ratel-cite-enter`，避免每个 delta 重播）

**Interfaces:**
- `FadeIn`: `{ play: boolean; delayMs?: number; children }`  
  - `play=false` → 无 animation class  
  - 仅组件首次 mount 加 `ratel-fade-in`；勿对 streaming 子树反复挂载  
- Policy 纯函数：`shouldStaggerCite(count: number): 'each' | 'group'` — `count>=8` → `group`

- [ ] **Step 1: policy 测试**

```typescript
import { shouldStaggerCite } from '../../../src/ui/motion/enter/cite-policy';
it('shouldStaggerCite - 少于 8 - each', () => {
	expect(shouldStaggerCite(3)).toBe('each');
});
it('shouldStaggerCite - 不少于 8 - group', () => {
	expect(shouldStaggerCite(8)).toBe('group');
});
```

- [ ] **Step 2: FadeIn.svelte + styles（translateY(6px)+opacity，220ms，ease）**

- [ ] **Step 3: MessageBubble 外包 FadeIn；user/assistant 都包；key 保持 message id**

- [ ] **Step 4: cite 首次出现加 class；确认流式改 content 不重新触发（用 messageId 级 play-once）**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): 消息与引用 FadeIn 入场

EOF
)"
```

---

### Task 6: TitleDissolve — 标题落定

**Files:**
- Create: `src/ui/motion/title/TitleDissolve.svelte`
- Modify: `ChatView.svelte` header chip 文案处

**Interfaces:**
- `TitleDissolve`: `{ text: string; playToken: number; motionOn: boolean }`  
  - `playToken` 递增时播一次交叉/blur；同 token 不重播  
- ChatView：`maybeGenerateTitle` / 手改成功后 `titleMotionToken += 1`

- [ ] **Step 1: 实现 TitleDissolve（短 Blur 或 opacity crossfade，≤280ms）**

- [ ] **Step 2: chip 内用 TitleDissolve 显示 `sessionShortTitle`**

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): 会话标题落定溶解过渡

EOF
)"
```

---

### Task 7: ShinyBrand + ClickSpark + Send/Stop

**Files:**
- Create: `src/ui/motion/brand/ShinyBrand.svelte`
- Create: `src/ui/motion/brand/ClickSpark.svelte`
- Create: `tests/ui/motion/click-spark-ease.test.ts`（抄上游 ease-out：`t*(2-t)`）
- Modify: `ChatView.svelte` header brand + send 按钮包装
- Modify: `styles.css`（Send↔Stop transition；必要时 spark 容器定位）

**上游 ClickSpark：** 纯 canvas，直接译为 Svelte；默认 `sparkCount=8`，`duration=400`，颜色用 `--interactive-accent`。  
**上游 ShinyText：** 用 CSS `background-size:200%` + `@keyframes shiny-shift`，**不**引 motion。

- [ ] **Step 1: ease 单测**

```typescript
import { sparkEaseOut } from '../../../src/ui/motion/brand/spark-ease';
it('sparkEaseOut - 0 与 1 - 端点', () => {
	expect(sparkEaseOut(0)).toBe(0);
	expect(sparkEaseOut(1)).toBe(1);
});
```

- [ ] **Step 2: ClickSpark — 包装 send 按钮；暴露 `sparkAt(x,y)` 或在 click 时若 `!isRunning && motionOn` 触发**

注意：发送逻辑在 `onclick={sendMessage}` — Spark 应在 **成功入队后** 触发，gate 失败不火花。可在 `sendMessage` 末尾调 `sparkApi?.burst()`。

- [ ] **Step 3: ShinyBrand 替换静态「Ratel.」文本节点**

- [ ] **Step 4: `.ratel-send` / `.ratel-stop` 加 `transition: background 0.15s, transform 0.12s`**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(motion): Header 扫光与发送 ClickSpark

EOF
)"
```

---

### Task 8: 文档收口 + STATUS + 全量验证

**Files:**
- Modify: `docs/user-guide.md` §10（聊天动效可关）
- Modify: `CHANGELOG.md` `[Unreleased]`
- Modify: `docs/superpowers/STATUS.md`（P-CHAT-MOTION Completed 或 In Progress→Completed）
- Optional: `docs/prototype/chat-ui-mockup.html` 空态示意（非阻塞）

- [ ] **Step 1: user-guide 补一句**

> 外观设置可开关「聊天动效」（空态背景、入场、标题过渡、发送火花）。系统「减少动态效果」开启时自动关闭。

- [ ] **Step 2: CHANGELOG Added 条（人话一两句）**

- [ ] **Step 3: STATUS 登记 P-CHAT-MOTION 为 Completed（合并后）/ 实施中先 In Progress**

- [ ] **Step 4: 全量验证**

```bash
npm test
npm run build
```

Expected: 全绿；bundle 无 `from 'ogl'` / `from 'motion'` / `from 'gsap'`。

```bash
rg -n "from 'ogl'|from \"ogl\"|from 'gsap'|from 'motion'|framer-motion" src/ui/motion || echo 'clean'
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs(motion): user-guide / CHANGELOG / STATUS 收口 S-CHAT-MOTION

EOF
)"
```

---

## Plan 自检（对照 spec）

| Spec 项 | Task |
|---|---|
| M1 Aurora WebGL2 | T3 |
| M2 BlurText | T4 |
| M3 TextType | T4 |
| M4/M5 Fade + cite | T5 |
| M6 标题 | T6 |
| M7/M8/M9 品牌发送 | T7 |
| prefs + 设置 | T1 |
| NOTICE/许可 | T2 |
| user-guide/CHANGELOG | T8 |
| 无重依赖 | T3–T7 + T8 rg 门禁 |
| 空态卸载 | T4 MessageList |

无 TBD；§8 已在 spec 冻结。
