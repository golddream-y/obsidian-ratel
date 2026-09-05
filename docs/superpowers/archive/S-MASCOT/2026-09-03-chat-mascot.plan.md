# P-MASCOT-1:聊天吉祥物实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 聊天窗消息区内一颗可拖动的色块吉祥物:表情跟 Agent 状态,眼睛跟鼠标,位置按比例落盘;不搬实验室、不叫 GrokBot。

**Architecture:** 纯函数(脸派生 / 坐标 clamp / 视线限幅)与 Canvas 绘制分离;Svelte 只负责挂载、拖动、pointermove 与把 ChatView 已有信号喂给派生函数。眼环点列自绘(每脸 8 点椭圆),换脸用弹簧插值——手法参考 MIT 开源 blob+eyes,不拷贝实验室 25×48 点数据。

**Tech Stack:** TypeScript strict、vitest、Svelte 5、Canvas 2D;无新 npm 依赖。

**关联文档:** [S-MASCOT](../specs/2026-09-03-chat-mascot.md)

## Global Constraints

- 用户可见字符串走 i18n(`zh.ts` / `en.ts` / `types.ts`),禁止硬编码。
- 代码注释中文;标识符英文。
- 新 `.ts` / `.svelte` 必须有文件头 `@file` / `@description` / `@module`。
- 测试 `it(...)` 中文,形态 `行为 - 条件 - 期望结果`。
- 不引入 Flutter/WebView/CDN;不使用「GrokBot」文案。
- 坐标 `chatMascotX/Y` **不进** `CONFIG_UPDATE_WHITELIST`(防 Agent 乱挪)。
- ThinkingOrb 保留;吉祥物不替代工具行/状态条。

---

## 文件结构

```
src/ui/mascot/types.ts                 [新] MascotFace 元组
src/ui/mascot/derive-face.ts           [新] 状态 → 脸
src/ui/mascot/derive-face.test.ts      [新]
src/ui/mascot/layout.ts                [新] 比例坐标 / clamp / 视线
src/ui/mascot/layout.test.ts           [新]
src/ui/mascot/eyes.ts                  [新] 7 脸 × 左右眼 8 点 + lerp
src/ui/mascot/eyes.test.ts             [新]
src/ui/mascot/paint.ts                 [新] 一帧 Canvas 绘制(可单测辅助函数)
src/ui/mascot/ChatMascot.svelte        [新] 拖动 + 绘制循环 + a11y
src/ui/chat/ChatView.svelte            [改] 挂载 + 信号
src/settings.ts                        [改] 三字段 + 外观开关
src/settings/config-whitelist.ts       [改] chatMascotEnabled 布尔白名单
src/i18n/types.ts zh.ts en.ts          [改]
src/prompts/defaults/zh.ts             [改] update_app_config 白名单句补 key
tests/settings/config-whitelist.test.ts [改]
```

---

### Task 1: 脸派生纯函数

**Files:**
- Create: `src/ui/mascot/types.ts`
- Create: `src/ui/mascot/derive-face.ts`
- Test: `src/ui/mascot/derive-face.test.ts`

**Interfaces:**
- Produces: `MASCOT_FACES`、`MascotFace`、`deriveMascotFace(input: MascotFaceInput): MascotFace`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file src/ui/mascot/derive-face.test.ts
 * @description 吉祥物脸派生优先级测试
 * @module ui/mascot/derive-face.test
 */
import { describe, it, expect } from 'vitest';
import { deriveMascotFace } from './derive-face';
import type { MessageSegment } from '../chat/message-stream/types';

const empty: MessageSegment[] = [];

describe('deriveMascotFace', () => {
	it('报错保持激活 - 优先 error - 即使正在跑', () => {
		expect(deriveMascotFace({ isRunning: true, cancelled: false, errorHoldActive: true, segments: empty })).toBe('error');
	});
	it('已停止且不在跑 - cancelled - stopped', () => {
		expect(deriveMascotFace({ isRunning: false, cancelled: true, errorHoldActive: false, segments: empty })).toBe('stopped');
	});
	it('在跑且无段 - waiting', () => {
		expect(deriveMascotFace({ isRunning: true, cancelled: false, errorHoldActive: false, segments: empty })).toBe('waiting');
	});
	it('在跑且末段 think - thinking', () => {
		expect(deriveMascotFace({
			isRunning: true, cancelled: false, errorHoldActive: false,
			segments: [{ type: 'think', text: 'hmm' }],
		})).toBe('thinking');
	});
	it('在跑且末段 tool calling - working', () => {
		expect(deriveMascotFace({
			isRunning: true, cancelled: false, errorHoldActive: false,
			segments: [{ type: 'tool', toolCall: { name: 'grep', displayName: 'g', args: {}, status: 'calling', startAt: 0 } }],
		})).toBe('working');
	});
	it('在跑且末段 text - speaking', () => {
		expect(deriveMascotFace({
			isRunning: true, cancelled: false, errorHoldActive: false,
			segments: [{ type: 'text', text: '你好' }],
		})).toBe('speaking');
	});
	it('不在跑无取消无报错 - idle', () => {
		expect(deriveMascotFace({ isRunning: false, cancelled: false, errorHoldActive: false, segments: empty })).toBe('idle');
	});
	it('报错保持结束且仍在跑 - 回到 waiting/thinking 而非卡 error', () => {
		expect(deriveMascotFace({
			isRunning: true, cancelled: false, errorHoldActive: false,
			segments: [{ type: 'think', text: 'x' }],
		})).toBe('thinking');
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/ui/mascot/derive-face.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 最小实现**

`types.ts`:

```typescript
/**
 * @file src/ui/mascot/types.ts
 * @description 聊天吉祥物脸档枚举
 * @module ui/mascot/types
 */
export const MASCOT_FACES = ['error', 'stopped', 'waiting', 'thinking', 'working', 'speaking', 'idle'] as const;
export type MascotFace = (typeof MASCOT_FACES)[number];
```

`derive-face.ts`:

```typescript
/**
 * @file src/ui/mascot/derive-face.ts
 * @description 由 ChatView 已有信号派生吉祥物脸(S-MASCOT 4.2)
 * @module ui/mascot/derive-face
 */
import type { MessageSegment } from '../chat/message-stream/types';
import type { MascotFace } from './types';

export interface MascotFaceInput {
	isRunning: boolean;
	cancelled: boolean;
	errorHoldActive: boolean;
	segments: MessageSegment[];
}

/**
 * 同帧只返回一档;errorHold 最高,其余按末段判别忙碌子态。
 */
export function deriveMascotFace(input: MascotFaceInput): MascotFace {
	if (input.errorHoldActive) return 'error';
	if (!input.isRunning) return input.cancelled ? 'stopped' : 'idle';
	const last = input.segments[input.segments.length - 1];
	if (!last) return 'waiting';
	if (last.type === 'tool' && last.toolCall.status === 'calling') return 'working';
	if (last.type === 'think') return 'thinking';
	if (last.type === 'text' && last.text.length > 0) return 'speaking';
	if (last.type === 'tool') return 'working';
	return 'waiting';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/ui/mascot/derive-face.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/mascot/types.ts src/ui/mascot/derive-face.ts src/ui/mascot/derive-face.test.ts
git commit -m "$(cat <<'EOF'
feat(mascot): 吉祥物脸由 Agent 信号派生

EOF
)"
```

---

### Task 2: 布局比例与视线限幅

**Files:**
- Create: `src/ui/mascot/layout.ts`
- Test: `src/ui/mascot/layout.test.ts`

**Interfaces:**
- Produces: `MASCOT_SIZE=48`、`MASCOT_INSET=12`、`clampMascotRatio`、`ratioToOffset`、`offsetToRatio`、`computeGaze`

常量:

```typescript
export const MASCOT_SIZE = 48;
export const MASCOT_INSET = 12;
export const DEFAULT_MASCOT_RATIO = { x: 1, y: 1 };
export const GAZE_CLAMP_X = 0.55;
export const GAZE_CLAMP_Y = 0.4;
```

`ratioToOffset(x, y, paneW, paneH)`: 可动盒为 `paneW - SIZE - 2*INSET` × 同高。`left = INSET + x * max(0, boxW)`, `top` 同理。`x/y` 先 `clamp(0,1)`。

`offsetToRatio(left, top, paneW, paneH)`: 反解并 clamp 0–1。

`computeGaze(pointerX, pointerY, mascotCenterX, mascotCenterY, frozen)`: `frozen` 或无指针时 `{x:0,y:0}`;否则 `(dx,dy)` 除以 `SIZE` 再 clamp 到 ±GAZE_CLAMP_*。

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file src/ui/mascot/layout.test.ts
 * @description 吉祥物坐标比例与视线限幅
 * @module ui/mascot/layout.test
 */
import { describe, it, expect } from 'vitest';
import { MASCOT_SIZE, MASCOT_INSET, ratioToOffset, offsetToRatio, computeGaze, clampMascotRatio } from './layout';

describe('吉祥物布局', () => {
	it('默认比例 1,1 - 贴右下 inset - 不越界', () => {
		const { left, top } = ratioToOffset(1, 1, 320, 400);
		expect(left).toBe(320 - MASCOT_SIZE - MASCOT_INSET);
		expect(top).toBe(400 - MASCOT_SIZE - MASCOT_INSET);
	});
	it('比例 0,0 - 贴左上 inset', () => {
		const { left, top } = ratioToOffset(0, 0, 320, 400);
		expect(left).toBe(MASCOT_INSET);
		expect(top).toBe(MASCOT_INSET);
	});
	it('往返 - offset 再 ratio - 回到原比例', () => {
		const r = { x: 0.3, y: 0.7 };
		const o = ratioToOffset(r.x, r.y, 320, 400);
		const back = offsetToRatio(o.left, o.top, 320, 400);
		expect(back.x).toBeCloseTo(0.3, 5);
		expect(back.y).toBeCloseTo(0.7, 5);
	});
	it('非法比例 - clamp 到 0-1', () => {
		expect(clampMascotRatio(-1, 2)).toEqual({ x: 0, y: 1 });
	});
	it('窗比吉祥物还小 - left/top 不小于 inset', () => {
		const { left, top } = ratioToOffset(1, 1, 20, 20);
		expect(left).toBe(MASCOT_INSET);
		expect(top).toBe(MASCOT_INSET);
	});
	it('视线 - 正右 - x 被限幅', () => {
		const g = computeGaze(1000, 24, 24, 24, false);
		expect(g.x).toBeLessThanOrEqual(0.55);
		expect(g.y).toBeCloseTo(0);
	});
	it('拖动冻结 - 视线归零', () => {
		expect(computeGaze(100, 100, 0, 0, true)).toEqual({ x: 0, y: 0 });
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/ui/mascot/layout.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `layout.ts`**(文件头中文;`clampMascotRatio` 用 `Math.min/max`)

- [ ] **Step 4: 测试通过**

- [ ] **Step 5: Commit** `feat(mascot): 位置按窗体比例 clamp,视线限幅`

---

### Task 3: 设置 / i18n / 白名单

**Files:**
- Modify: `src/settings.ts`(接口、DEFAULT、外观 Tab 在 `chatMotionEnabled` 后加 toggle)
- Modify: `src/settings/config-whitelist.ts`(`CONFIG_UPDATE_WHITELIST` + `BOOLEAN_KEYS` 加 `chatMascotEnabled`; **不要**加 X/Y)
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`
- Modify: `src/prompts/defaults/zh.ts` `tool.update_app_config.description` 外观列表补 `chatMascotEnabled`
- Modify: `tests/settings/config-whitelist.test.ts` expected 数组加 `'chatMascotEnabled'`

**Interfaces:**
- Produces: `RatelVaultSettings.chatMascotEnabled: boolean`(默认 `true`);`chatMascotX/Y: number`(默认 `1`)

i18n:

```
'settings.chatMascotEnabled.name': 聊天吉祥物
'settings.chatMascotEnabled.desc': 消息区一颗可拖动的色块,表情跟对话状态,眼睛跟鼠标;关闭聊天装饰动效或系统减少动画时变为静脸
'chat.mascot.aria.idle': Ratel 空闲
'chat.mascot.aria.waiting': Ratel 等待回复
'chat.mascot.aria.thinking': Ratel 正在思考
'chat.mascot.aria.working': Ratel 正在调用工具
'chat.mascot.aria.speaking': Ratel 正在回答
'chat.mascot.aria.error': Ratel 遇到错误
'chat.mascot.aria.stopped': Ratel 已停止
```

en 对应翻译。`aria-*` 用 `Record<MascotFace, StringKey>` 在组件里映射。

- [ ] **Step 1: 改 whitelist 测试 expected,先跑确认缺 key 失败(若当前实现尚未加则 FAIL)**

Run: `npx vitest run tests/settings/config-whitelist.test.ts`

- [ ] **Step 2: 落地 settings + i18n + whitelist + prompt 句**

- [ ] **Step 3: 全绿**

Run: `npx vitest run tests/settings/config-whitelist.test.ts`
Expected: PASS(幽灵 key 守卫要求 DEFAULT 已有三字段)

- [ ] **Step 4: Commit** `feat(mascot): 外观开关与位置落盘字段`

---

### Task 4: 眼环几何与一帧绘制

**Files:**
- Create: `src/ui/mascot/eyes.ts`
- Create: `src/ui/mascot/eyes.test.ts`
- Create: `src/ui/mascot/paint.ts`

**Interfaces:**
- Produces: `EyeRing`(8 个 `{x,y}` 归一化 0–1 脸框);`getEyeRings(face): { left: EyeRing; right: EyeRing }`;`lerpRings(a,b,t)`;`applyGaze(ring, gazeX, gazeY)`(整体平移,仍 clamp 在脸内);`drawMascotFrame(ctx, opts)`

手法:每只眼 8 点闭合多边形(椭圆采样),idle 圆睁、thinking 扁、error 外斜、stopped 下垂、waiting 略小、working 更圆、speaking 略大。点列**自绘**,文件头写:弹簧换脸手法参考 MIT blob-eyes 开源,点列为 Ratel 原创。

测试:
- 每张脸左右环长度均为 8
- `lerpRings` t=0/1 等于端点
- `applyGaze` 冻结 0 时坐标不变;gazeX=1 时点的平均 x 增大

`drawMascotFrame`:
- 填圆角色块 `accent`(参数传入,组件读 CSS `--interactive-accent`)
- 双眼 `eyeFill`(参数,组件读 `--background-primary`)
- 不测像素,测函数不抛、路径闭合(可抽 `ringToPath`)

- [ ] **Step 1–4: RED-GREEN 眼环测试 + paint 不抛**
- [ ] **Step 5: Commit** `feat(mascot): 自绘眼环与换脸插值`

---

### Task 5: ChatMascot 组件 + ChatView 接线

**Files:**
- Create: `src/ui/mascot/ChatMascot.svelte`
- Modify: `src/ui/chat/ChatView.svelte`

**Interfaces:**
- Consumes: Task 1–4 全部导出; `plugin.settings` / `saveSettings`; `isChatMotionEnabled` / `prefersMotionReduced`

**ChatMascot props:**

```typescript
{
  enabled: boolean;
  animate: boolean; // chatMotionOn && !prefersReducedMotion
  face: MascotFace;
  ratioX: number;
  ratioY: number;
  onRatioChange: (x: number, y: number) => void;
  onRatioReset: () => void;
}
```

行为:
- `enabled===false` 不渲染。
- 根: `class="ratel-mascot"` `position:absolute; z-index: 6; width/height: 48px; touch-action:none;`
- `ResizeObserver` 父节点(消息 wrap)算 left/top。
- pointerdown: `setPointerCapture`, `dragging=true`, 冻结视线。
- pointerup: `offsetToRatio` → `onRatioChange`;双击(300ms 内第二次 down)→ `onRatioReset`。
- 父节点 pointermove(由父绑定或组件 `onMount` 在 `el.closest('.ratel-messages-wrap')`):更新 gaze;pointerleave 视线 0。
- rAF: `animate===false` 只画一帧静态(gaze=0, face 仍可切但不眨眼);`animate` 时弹簧 t 追 face、idle 眨眼定时。
- `role="img"` `aria-label={$t(ariaKey[face])}`

**ChatView:**
- `lastAssistant = messages` 从尾扫 `role==='assistant'`。
- `errorHoldActive`: `handleAgentError` 与 tool `failed` 时 `errorHoldUntil = Date.now()+2400`;`$derived(Date.now() < errorHoldUntil)` 不够响应,用 `let errorHoldUntil=0` + `setTimeout` 清零触发更新,或每帧不需要——在 error 时设 flag,2400ms 后 `errorHoldActive=false`。
- `cancelled`: `lastAssistant?.cancelled === true`(stopGeneration 已置)。
- `face = deriveMascotFace({ isRunning, cancelled, errorHoldActive, segments: lastAssistant?.segments ?? [] })`
- 挂在 `.ratel-messages-wrap` **内部**第一层,使默认 (1,1) 落在输入区上方而非挡住发送钮(相对 spec 4.1 的细化,记偏差)。
- `onRatioChange`: `plugin.settings.chatMascotX/Y = ...; void plugin.saveSettings()`
- `onRatioReset`: 设回 `1,1` 并 save
- `{#if $settingsStore.chatMascotEnabled !== false}` 挂载(`settings$` 已有)

样式:无阴影大投影(与产品浮层规范一致),可用 1px `var(--background-modifier-border)`。

- [ ] **Step 1: 实现组件与接线**(无浏览器自动化;逻辑已由 Task 1–2 单测覆盖)
- [ ] **Step 2: `npx vitest run src/ui/mascot tests/settings/config-whitelist.test.ts` 全绿**
- [ ] **Step 3: `npm run build`**
Expected: 成功
- [ ] **Step 4: Commit** `feat(mascot): 消息区可拖吉祥物并跟鼠标与状态脸`

---

### Task 6: Sandbox 手测(不自动归档)

- [ ] **Step 1:** 只链 Sandbox,Reload app without saving
- [ ] **Step 2:** 核对清单
  1. 默认右下消息区、不挡发送
  2. 拖动后重载位置仍在
  3. 双击回角
  4. 鼠标在消息区移动眼睛跟
  5. 发送后 waiting → 思考/工具/说话
  6. 工具失败或红条 → error 约 2.4s
  7. 停止 → stopped
  8. 关「聊天吉祥物」消失
  9. 关「聊天装饰动效」静脸不跟鼠标
- [ ] **Step 3:** 文档:本 plan 不改 README;CHANGELOG 待发版。user-guide 不强制(彩蛋开关在外观)。

---

## 与 spec 的偏差

| spec | plan | 理由 |
|---|---|---|
| 挂在 ChatView 根层 | 挂在 `.ratel-messages-wrap` 内 | 默认 (1,1) 自然在输入壳上方,不挡发送钮 |
| 可移植开源 48 点眼环 | 自绘 8 点/眼 | 手法相同(闭合环+插值),避免拷贝实验室数据与商标脸 |

---

## 自审

**Spec 覆盖:** 4.1 拖/比例/双击 → T2+T5;4.2 脸 → T1;4.3 视线 → T2+T5;4.4 绘制 → T4;4.5 设置闸门 → T3+T5;4.6 a11y → T5 aria。非目标均未列入任务。

**占位符:** 无 TBD。

**类型:** `MascotFace` / `MASCOT_SIZE` 全任务同名。
