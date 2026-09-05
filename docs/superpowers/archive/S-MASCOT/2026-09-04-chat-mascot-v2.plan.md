# P-MASCOT-2:聊天吉祥物更可爱灵动

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同一只 blob：闲着连眨+轻晃、单击轻弹（拖动不误触、双击仍复位）、忙态姿态差拉开。

**Architecture:** 手势阈值纯函数；连眨/轻晃/点头/眨眼调度纯函数；`MascotSim` 吃这些量并提供 `pulseTap`；`ChatMascot` 只区分 tap/drag 并喂 `pressing`/`pulseTap`。不改 `deriveMascotFace`、不加五官。

**Tech Stack:** 现有 TypeScript / vitest / Svelte 5 / Canvas 2D。

**关联文档:** [S-MASCOT-2](../specs/2026-09-04-chat-mascot-v2.md)

## Global Constraints

- 注释中文；测试 `it` 中文 `行为 - 条件 - 期望结果`。
- 不加嘴/腮红/瞳孔；不读回复情绪；不改设置/i18n（除非误改）。
- `chatMotionEnabled===false` / reduced-motion：不弹、不闲晃、不连眨。
- 未要求 git commit 则不提交。

---

## 文件结构

```
src/ui/mascot/gesture.ts           [新] 单击 vs 拖动位移阈值
src/ui/mascot/gesture.test.ts      [新]
src/ui/mascot/face-motion.ts       [改] 闲晃、等待摆、说话点头、思考单眼、连眨间隔
src/ui/mascot/face-motion.test.ts  [改]
src/ui/mascot/sim.ts               [改] kinetics、连眨、pulseTap、error 震、接线 talk/wink
src/ui/mascot/sim.test.ts          [改]
src/ui/mascot/ChatMascot.svelte    [改] tap 门闩
```

---

### Task 1: 单击/拖动阈值

**Files:**
- Create: `src/ui/mascot/gesture.ts`
- Test: `src/ui/mascot/gesture.test.ts`

**Interfaces:**
- Produces: `MASCOT_TAP_SLOP = 6`、`isMascotTap(dx: number, dy: number, slop?: number): boolean`

- [ ] **Step 1–4:** TDD 后实现：位移平方和 `< slop²` 为 tap。

- [ ] **Step 5:** 不提交（除非用户要求）

---

### Task 2: 闲着连眨间隔 + 轻晃纯函数

**Files:**
- Modify: `src/ui/mascot/face-motion.ts`
- Test: `src/ui/mascot/face-motion.test.ts`

**Interfaces:**
- Produces:
  - `shouldDoubleBlink(rand: number): boolean` — `rand < 0.25`
  - `nextBlinkDelayMs(kin: { blinkMin: number; blinkMax: number }, rand: number, doubleBlink: boolean): number` — 连眨返回 `120 + rand * 100`（120–220）；否则 `blinkMin + rand * (blinkMax - blinkMin)`
  - `idleSwayRotate(nowMs: number): number` — 约 `4 * sin(t * 0.7)`，绝对值 ≤ 4.05

---

### Task 3: 忙态运动纯函数 + kinetics 可测

**Files:**
- Modify: `face-motion.ts` / `sim.ts`
- Test: `face-motion.test.ts` / `sim.test.ts`

**Interfaces:**
- Produces:
  - `waitingBodyRotate(nowMs: number): number` — 约 `±5°` 慢摆
  - `speakingNod(nowMs: number): number` — 小幅 `offsetY`
  - `thinkingWink(nowMs: number): number` — 0–1，周期约 3s 内有一段 > 0.4
  - `errorShakeRotate(elapsedMs: number): number` — `elapsed < 220` 时 |rotate| 峰值 > 2，之后为 0
  - `export function mascotKinetics(face: MascotFace)` 从 `sim.ts` 导出当前表
- kinetics 目标（相对 v1 加大差）：
  - idle: `breathe: 0.03`，`blinkMin: 6000`，`blinkMax: 12000`
  - waiting: `bounceAmp: 0.35`，`bounceHz: 0.55`
  - thinking: `rotate: -10`，`restOpen: 0.32`，`breathe: 0.005`
  - working: `bounceAmp: 1.6`，`bounceHz: 3.2`，`rotate: 8`
  - speaking: `bounceAmp: 0.9`，`bounceHz: 2.4`
  - listening: `bounceAmp: 0.12`，`bounceHz: 0.7`
  - error: `rotate: -13`，`restOpen: 0.68`
  - stopped: `rotate: 3`，`restOpen: 0.28`，`breathe: 0.002`

断言：`mascotKinetics('thinking').rotate < mascotKinetics('idle').rotate`；`working.bounceHz > waiting.bounceHz`；`stopped.restOpen < idle.restOpen`。

---

### Task 4: MascotSim 接线 + pulseTap

**Files:**
- Modify: `src/ui/mascot/sim.ts`、`sim.test.ts`

**Interfaces:**
- `tick` 增加可选 `tapAmp?: number` 不合适；改为 `pulseTap(amp: number, now: number): void`
- 忙态单击 amp 0.5，idle/listening 1；`animate===false` 时 pulse 立刻忽略
- idle：`idleSwayRotate` 加进 `body.rotate`；连眨走 `shouldDoubleBlink` + `nextBlinkDelayMs`（构造可注入 `rng`）
- waiting：`waitingBodyRotate` 加 rotate
- speaking：`speakingTalkAmount` 叠到 `open.t`；`speakingNod` 进 offsetY
- thinking：左眼 `squashRing` 额外 `thinkingWink`
- error：自切入起算 `errorShakeRotate`
- 指针离开（gaze≈0）idle 仍用 `idleGlance`（已有）

测试：
- `pulseTap(1)` 若干帧 `scaleY < 0.97`，关动效 pulse 后仍 ≈1
- 注入 rng 恒 0：第一次眨完后下次间隔 < 230ms
- 切到 error 后 50ms `|rotate|` 大于 idle 同帧晃
- speaking 两时刻 `open` 不同

---

### Task 5: ChatMascot 手势

**Files:**
- Modify: `src/ui/mascot/ChatMascot.svelte`

- pointerdown：记录 `downX/Y`，`didDrag=false`，`holding=true`，capture；**不要**立刻把位移当拖
- pointermove：若 `!isMascotTap(dx,dy)` 则 `didDrag=true` 并改 left/top
- pointerup：`holding=false`；若 `didDrag` 写比例；若 `!didDrag && animate` 则 `sim.pulseTap(busy ? 0.5 : 1, now)`，其中 busy = waiting|thinking|working|speaking
- 双击复位逻辑保持：清 dragging/holding，不 pulse
- `pressing: holding` 喂 tick（按住压扁）

手测：Sandbox `npm run build` + `link:vault` 仅 Sandbox，Reload app without saving。

---

## 自审

- 闲着连眨/轻晃 → Task 2+4
- 单击/拖/双击 → Task 1+5
- 忙态表 → Task 3+4
- 无五官、无新设置 → 遵守
- speakingTalkAmount 目前未进 sim，本 plan Task 4 补上（v1 缺口）
