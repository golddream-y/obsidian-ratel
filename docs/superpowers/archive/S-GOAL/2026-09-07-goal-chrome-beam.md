# P-GOAL-CHROME:目标指示条常显 + Beam/Orb 契约 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 S-GOAL v1.5 面 2/3 动效契约落到聊天 composer:未完成目标跨会话常显;进行中才 Border Beam;只有本场真在跑才出 Thinking Orb;继续 chip 用现成 GlareHover;不装 libraries.dev 的 npm。

**Architecture:** 选条纯函数 `pickGoalStrip` + `goalChromeFromStrip` 可单测;ChatView 只消费返回值绑 `busyQuiet` / `busyOrbKind` / `ratel-beam`;Beam 已有 `src/ui/motion/chrome/border-beam.css`;Orb 已有 `ThinkingOrb` + StatusLine `busyQuiet`。不改 store / runner。

**Tech Stack:** TypeScript / Svelte 5 / 现有 CSS Beam 与 GlareHover / Vitest。无新 npm。

## Global Constraints

- 用户可见字符串走 i18n(`zh.ts` + `en.ts` + `types.ts`),禁止硬编码
- 测试 `it(...)` 中文:`行为 - 条件 - 期望结果`
- 源码注释 / 文件头中文(`@file` `@description` `@module`)
- 禁止 `npm install border-beam|thinking-orbs|liquid-gooey|metal-fx|img-fx` 及任何 React 动效包
- 禁止彩虹 Beam(`colorful`);色走 `--interactive-accent` mono
- 禁止空闲「进行中」转思考球
- Gooey / Liquid Metal / img-fx / CountUp 回合数字 / 改发送钮 Metal:**本 plan 不做**
- 用户气泡 StarBorder 不动;不叠第二道 Beam
- `isChatMotionEnabled` + `prefers-reduced-motion` 关闸则无扫边动画(CSS 已有 reduce 分支)
- 只链 Obsidian Sandbox;`npm run link:vault` 禁止日常主库
- 提交只暂存本 plan 文件清单,禁止 `git add -A`(工作区混有 P-GOAL-1 其他 WIP)
- 工作目录:当前仓库,分支 `feat/p-goal-1`(不要另开 worktree,以免丢掉未提交 WIP)

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/goal/pick-goal-strip.ts` | `pickGoalStrip` + `goalChromeFromStrip` |
| `src/ui/goal/pick-goal-strip.test.ts` | 选条 + chrome 表 |
| `src/ui/chat/ChatView.svelte` | workBar / beam class / chip GlareHover |
| `src/ui/motion/chrome/border-beam.css` | 已有,本 plan 不改彩虹、不改 keyframes |
| `src/ui/motion/chrome/GlareHover.svelte` | 不改组件;chip wrap 用 CSS 覆盖 layout |
| `src/ui/status/StatusLine.svelte` | 已有 `busyQuiet`;本 plan 不改,除非发现闲等仍出 orb |
| `src/i18n/{types,zh,en}.ts` | strip 文案 key 已加则核;缺则补 |
| `docs/user-guide.md` | 状态条一句:跨会话常显 + 进行中/暂停 |

---

### Task 1:Strip chrome 契约 + chip GlareHover(整包)

**Files:**
- Modify: `src/ui/goal/pick-goal-strip.ts`
- Modify: `src/ui/goal/pick-goal-strip.test.ts`
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `docs/user-guide.md`(§10 StatusStrip 一句,若尚未写跨会话/暂停)
- Test: `src/ui/goal/pick-goal-strip.test.ts`

**Interfaces:**
- Consumes: `AgentGoal`;现有 `pickGoalStrip`;`GlareHover`;`isChatMotionEnabled` / `chatMotionOn`
- Produces:

```typescript
export interface GoalChrome {
	beam: boolean;
	orb: boolean;
	quiet: boolean;
}

export function goalChromeFromStrip(kind: GoalStripKind): GoalChrome
```

映射(与 spec v1.5 表逐格一致):

| kind | beam | orb | quiet |
|---|---|---|---|
| `running` | true | true | false |
| `active-here` | true | false | true |
| `active-elsewhere` | true | false | true |
| `paused` | false | false | true |
| `pending` | false | false | true |
| `blocked` | false | false | false |
| `hidden` | false | false | false |

- [ ] **Step 1:写失败测试(chrome 表 + 他会话 active)**

在 `pick-goal-strip.test.ts` 增加(若已有选条用例则保留,只补 chrome):

```typescript
import { pickGoalStrip, goalChromeFromStrip } from './pick-goal-strip';

it('goalChromeFromStrip - running - beam 与 orb 开 quiet 关', () => {
	expect(goalChromeFromStrip('running')).toEqual({ beam: true, orb: true, quiet: false });
});

it('goalChromeFromStrip - active-elsewhere - 有 beam 无 orb', () => {
	expect(goalChromeFromStrip('active-elsewhere')).toEqual({ beam: true, orb: false, quiet: true });
});

it('goalChromeFromStrip - paused - 全关 quiet 开', () => {
	expect(goalChromeFromStrip('paused')).toEqual({ beam: false, orb: false, quiet: true });
});

it('goalChromeFromStrip - blocked - 无 beam 无 orb 非 quiet', () => {
	expect(goalChromeFromStrip('blocked')).toEqual({ beam: false, orb: false, quiet: false });
});
```

- [ ] **Step 2:跑测试确认 RED**

Run: `npx vitest run src/ui/goal/pick-goal-strip.test.ts`

Expected: FAIL — `goalChromeFromStrip` is not a function / is not exported

- [ ] **Step 3:实现 `goalChromeFromStrip` 并让 ChatView 只消费它**

`pick-goal-strip.ts` 增加:

```typescript
export interface GoalChrome {
	beam: boolean;
	orb: boolean;
	quiet: boolean;
}

/**
 * StatusStrip / 输入壳动效开关 — spec v1.5 面 2/3。
 */
export function goalChromeFromStrip(kind: GoalStripKind): GoalChrome {
	switch (kind) {
		case 'running':
			return { beam: true, orb: true, quiet: false };
		case 'active-here':
		case 'active-elsewhere':
			return { beam: true, orb: false, quiet: true };
		case 'paused':
		case 'pending':
			return { beam: true, orb: false, quiet: true } as unknown as GoalChrome; // 禁止:paused/pending beam 必须 false
		default:
			return { beam: false, orb: false, quiet: false };
	}
}
```

**上面 `as unknown` 是反例,禁止照抄。** 正确实现:

```typescript
export function goalChromeFromStrip(kind: GoalStripKind): GoalChrome {
	switch (kind) {
		case 'running':
			return { beam: true, orb: true, quiet: false };
		case 'active-here':
		case 'active-elsewhere':
			return { beam: true, orb: false, quiet: true };
		case 'paused':
		case 'pending':
			return { beam: false, orb: false, quiet: true };
		case 'blocked':
		case 'hidden':
			return { beam: false, orb: false, quiet: false };
	}
}
```

ChatView:

1. `import { pickGoalStrip, goalChromeFromStrip } from '../goal/pick-goal-strip';`
2. `const goalChrome = $derived(goalChromeFromStrip(goalStrip.kind));`
3. 输入壳:

```svelte
class:ratel-input-shell--goal={goalChrome.beam}
class:ratel-input-shell--goal-paused={goalStrip.kind === 'paused'}
class:ratel-beam={chatMotionOn && goalChrome.beam}
```

4. `busyOrbKind`:仅 `goalChrome.orb` 时 `'thinking'`;goal 且 `goalChrome.quiet` 时 `null`(与现有 indexing 等分支并存,不要删索引 orb)
5. `busyQuiet={goalChrome.quiet}`(goal 文案在 workBar 时;非 goal 的 workBar 不得被误标 quiet——仅当 workBar.type 以 `goal-` 开头且 quiet)
6. 继续 chip:**仅** `continue` / `takeover` 扫边;pending 芯片无 Beam。包 GlareHover,闸门与发送钮一致 `chatMotionOn && !isRunning`。**不要改 GlareHover.svelte**(`align-self: flex-end` 是给发送钮的)。在 `.ratel-goal-chip-wrap` 覆盖:

```css
.ratel-goal-chip-wrap :global(.ratel-glare) {
	display: block;
	align-self: stretch;
	width: 100%;
	flex-shrink: 1;
}
```

标记(完整替换现有 chip 块):

```svelte
{#if continueChip.kind !== 'hidden'}
	{@const chipActive =
		continueChip.kind === 'continue' || continueChip.kind === 'takeover'}
	<div class="ratel-goal-chip-wrap">
		<GlareHover enabled={chatMotionOn && !isRunning && chipActive}>
			<button
				type="button"
				class="ratel-goal-chip"
				class:ratel-beam={chatMotionOn && chipActive}
				onclick={() => void handleContinueChip()}
				disabled={isRunning || isCompacting}
			>
				{#if continueChip.kind === 'continue'}
					{tNow('goal.chip.continue', {
						objective: truncateObjective(continueChip.objective ?? ''),
					})}
				{:else if continueChip.kind === 'takeover'}
					{tNow('goal.chip.takeover', {
						objective: truncateObjective(continueChip.objective ?? ''),
					})}
				{:else if continueChip.kind === 'single-pending'}
					{tNow('goal.chip.singlePending', {
						objective: truncateObjective(continueChip.objective ?? ''),
					})}
				{:else if continueChip.kind === 'multi-pending'}
					{tNow('goal.chip.multiPending', { count: continueChip.pendingCount ?? 0 })}
				{/if}
			</button>
		</GlareHover>
	</div>
{/if}
```

`GlareHover` 已在 ChatView import。workBar 文案分支保持现有 `pickGoalStrip` 映射(blocked / running / stopped / elsewhere / paused / pending);不要重写选条优先级。

- [ ] **Step 4:GREEN + 构建**

Run: `npx vitest run src/ui/goal/pick-goal-strip.test.ts`

Expected: PASS

Run: `npm run build`

Expected: exit 0(已有 svelte a11y warning 可忽略)

- [ ] **Step 5:Sandbox 链接(只 Sandbox)**

Run: `npm run link:vault -- "<sandbox>"`

`<sandbox>` 读 gitignore 的 `.cursor/rules/*.local.mdc`「开发预览」路径。禁止链日常主库。

Expected: `main.js` → 当前仓库 `dist/main.js`

- [ ] **Step 6:Commit(只本清单)**

```bash
git add \
  src/ui/goal/pick-goal-strip.ts \
  src/ui/goal/pick-goal-strip.test.ts \
  src/ui/chat/ChatView.svelte \
  src/ui/motion/chrome/border-beam.css \
  src/ui/status/StatusLine.svelte \
  src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts \
  docs/user-guide.md \
  docs/superpowers/plans/2026-09-07-goal-chrome-beam.md \
  docs/superpowers/STATUS.md
git commit -m "$(cat <<'EOF'
feat(goal): 指示条跨会话常显,进行中 Beam、执行中才 Orb

EOF
)"
```

若 `ChatView.svelte` 含未完成的 `/goal` 斜杠 WIP:仍提交该文件(本任务改了 chip/beam,无法拆文件);**不要**把 `goal-store.ts` / `slash-commands.ts` 等塞进这次 commit,除非本任务确实改了它们(不应改)。

`border-beam.css` / i18n / StatusLine 若本任务零 diff 则从 `git add` 去掉,不要空加。

---

## 自审

**Spec coverage(v1.5 面 2/3):** 常显选条=`pickGoalStrip`;Beam/Orb 表=`goalChromeFromStrip`;chip GlareHover=Task 1;非目标 Gooey/Metal/npm=Global Constraints。CountUp 回合=明确跳过。

**Placeholder scan:** 无 TBD。反例 `as unknown` 已标明禁止照抄。

**风险:** GlareHover 默认 `align-self:flex-end` 会挤 chip——必须用 wrap 上 `:global(.ratel-glare)` 覆盖,禁止改发送钮布局。

**偏差:** P-GOAL-1 Task 9 已撤回,本 plan 取代之。
