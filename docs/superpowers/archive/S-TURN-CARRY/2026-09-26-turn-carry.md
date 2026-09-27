# S-TURN-CARRY 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模型正常收笔、可见正文过短而思考更长时，同一轮再请求一次把正文写出来。

**Architecture:** 判断放在纯函数 `shouldCarryShortOutline`。agent loop 在无工具且即将结束时调用。命中则短正文照常入库，下一次 `llm.chat` 前追加一条不落盘的 system。85% 压缩与历史 `reasoning` 回传都不改。

**Tech Stack:** TypeScript strict、vitest。

**Spec:** [2026-09-26-turn-carry-design.md](2026-09-26-turn-carry-design.md)

**ADR:** [ADR-020](../../adr/2026-09-27-turn-completion-guard.md)

## Global Constraints

- 不改 `AUTO_COMPACT_THRESHOLD_PCT`。不加 50% 触发。不新增剥离历史思考的函数。
- 可见正文按 Unicode 码点计。少于 200 且至少 1，思考过程严格更长，才推。
- 可见正文为空不推，留给 S-LOOP-STABILITY。
- 不看用户原文是不是「继续」。
- 成功的 `write_note` / `edit_note` / `append_note` 之后不推。
- 每轮用户消息最多推一次。提示语固定为：`按你刚写的计划，把正文写出来；不要再重列提纲。`
- 不插入用户气泡。不改默认 50 步，不改 `length` 截断路径。
- 注释中文。`it` 描述中文，格式「行为 - 条件 - 期望」。
- TDD：先失败测试，再实现，再提交。

---

### Task 1: 短正文同一轮再写一次

**Files:**
- Create: `src/core/turn-carry.ts`
- Test: `tests/core/turn-carry.test.ts`
- Modify: `src/core/agent-loop.ts`

**Interfaces:**
- Produces: `shouldCarryShortOutline(input: { visibleChars: number; reasoningChars: number; wroteNote: boolean; alreadyCarried: boolean }): boolean`
- 常量 `SHORT_OUTLINE_MAX_CHARS = 200`
- 常量 `CARRY_SYSTEM = '按你刚写的计划，把正文写出来；不要再重列提纲。'`

- [ ] **Step 1: 写失败测试**

```typescript
import { describe, expect, it } from 'vitest';
import { shouldCarryShortOutline, CARRY_SYSTEM } from '../../src/core/turn-carry';

describe('shouldCarryShortOutline', () => {
	it('shouldCarryShortOutline - 只有标题且思考更长 - true', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 36,
			reasoningChars: 1200,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(true);
		expect(CARRY_SYSTEM).toContain('不要再重列提纲');
	});

	it('shouldCarryShortOutline - 短回答且思考更长、用户不是继续 - true', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 20,
			reasoningChars: 400,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(true);
	});

	it('shouldCarryShortOutline - 可见正文为空 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 0,
			reasoningChars: 500,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(false);
	});

	it('shouldCarryShortOutline - 已写笔记 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 10,
			reasoningChars: 500,
			wroteNote: true,
			alreadyCarried: false,
		})).toBe(false);
	});

	it('shouldCarryShortOutline - 正文已有 200 字 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 200,
			reasoningChars: 800,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(false);
	});

	it('shouldCarryShortOutline - 思考不比正文长 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 40,
			reasoningChars: 40,
			wroteNote: false,
			alreadyCarried: false,
		})).toBe(false);
	});

	it('shouldCarryShortOutline - 已经续过 - false', () => {
		expect(shouldCarryShortOutline({
			visibleChars: 10,
			reasoningChars: 500,
			wroteNote: false,
			alreadyCarried: true,
		})).toBe(false);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/turn-carry.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现并接到循环**

`visibleChars` 用 `[...text].length`。0、大于等于 200、思考不严格大于可见字数、已写笔记、已推过，都返回 false。

在 `agent-loop.ts` 里，当 `toolCalls.length === 0`、尚未因取消或错误跳出、且 `finishReason` 不是 `length` 也不是 `content_filter`（`null` 与 `stop` 都算正常收笔）：若 `shouldCarryShortOutline(...)` 为 true，本步助手文本按现有方式入库，`alreadyCarried = true`，然后 `continue` 进入下一步。不要落到后面的工具执行，也不要 `break`。

下一步调用 `llm.chat` 之前，把 `{ role: 'system', content: CARRY_SYSTEM }` 追加到当次数组末尾，不写入 session。这条只用于这一次请求，发完就丢掉，避免下一轮再带上。

`wroteNote`：本轮工具执行里，工具名是 `write_note`、`edit_note`、`append_note` 且该次没有失败，则置 true。这个标记保留到本轮 `agentLoop` 结束。

不要 `yield` 一条假的 user 消息。不要改 `compact-project.ts`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/turn-carry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/turn-carry.ts tests/core/turn-carry.test.ts src/core/agent-loop.ts
git commit -m "feat: 正文过短而思考更长时，同一轮再写一次"
```

## 自审

- TC-01、TC-02、TC-03 → Task 1。空正文返回 false，与 S-LOOP-STABILITY 的空步不叠成两次续写。
- 50% 压缩与剥离历史思考已从 spec 删除，计划里没有对应任务。
- 不看用户原文，所以「今天天气怎么样」只要可见字短、思考更长，也会推一次。这是 ADR-020 接受的代价，上限一次。
