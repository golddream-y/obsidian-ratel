# S-CTX-TRIM 上送截断对齐模型窗口 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer 1 历史上限由模型窗口（128k–1M）动态推导，替换写死的 8000；单条工具结果 / 检索块加 32,000 码点硬上限；trimHistory 保护最后一条 user。

**Architecture:** 新增两个纯函数模块（`context-budget.ts` 预算推导、`tool-result-prune.ts` 码点裁剪），`ContextManager.toMessages()` 在 `projectView` 投影后插入单条工具上限，再进重写后的 `trimHistory`（丢更旧轮 → 压 tool 占位，绝不删最后一条 user）。`main.ts` 两处 `new ContextManager` 注入 `tailBudget(getEffectiveChatModelMaxTokens(settings))`。压缩位次（85% 自动压、microcompact、PTL 重试）不动。

**Tech Stack:** TypeScript (strict)、vitest、esbuild。

**Spec:** [2026-08-16-context-trim-vs-compact-design.md](../specs/2026-08-16-context-trim-vs-compact-design.md)

**已落地前置（develop 上 dac0ccd）:** `trimHistory` 已有一版「user 必留」最小修复（lastUserIdx===0 时截 tool 占位）；本 plan Task 3 用完整算法替换它。测试「用户问完后工具结果撑爆预算 - 仍保留该条用户问题」已存在且必须继续通过。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/core/context-budget.ts` | Create | `outputReserve` / `prefixSlack` / `tailBudget` — 窗口 → 历史池预算 |
| `src/core/tool-result-prune.ts` | Create | `pruneOverlongText` — 码点头尾裁 + 上限常量 |
| `src/core/context-manager.ts` | Modify | toMessages 插入工具/检索裁剪；trimHistory 重写；构造第三参必传 |
| `src/main.ts` | Modify | ask / createContext 两处注入 tailBudget |
| `tests/core/context-budget.test.ts` | Create | 预算函数边界 |
| `tests/core/tool-result-prune.test.ts` | Create | 码点裁剪边界（代理对 / Error 豁免在 manager 层） |
| `tests/core/context-manager.test.ts` | Modify | 管线与 trimHistory 行为 |
| `CHANGELOG.md` / `docs/user-guide.md` | Modify | 用户语言记录 |

单位约定（spec 5.1/5.2）：预算用 `estimateTokens`（token）；工具/检索裁剪用 Unicode 码点。两套单位不得混比。

---

### Task 1: context-budget — 窗口推导预算函数

**Files:**
- Create: `src/core/context-budget.ts`
- Test: `tests/core/context-budget.test.ts`

- [ ] **Step 1.1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import { outputReserve, prefixSlack, tailBudget } from '../../src/core/context-budget';
import { presetToTokens } from '../../src/ui/tokens/context-length-presets';

describe('context-budget', () => {
	it('outputReserve - 大窗 10% 夹在 8k–32k', () => {
		// 256k: 256000 * 0.10 = 25600
		expect(outputReserve(256_000)).toBe(25_600);
		// 1M(1048576): 10% = 104857 → 夹到 32000
		expect(outputReserve(1_048_576)).toBe(32_000);
		// 64k: 6400 → 下限 8192
		expect(outputReserve(64_000)).toBe(8_192);
	});

	it('outputReserve - 小窗(<32k)改按 15% 且下限 512', () => {
		expect(outputReserve(4_096)).toBe(614); // max(512, floor(4096*0.15))
		expect(outputReserve(1_024)).toBe(512);
	});

	it('prefixSlack - 大窗固定 24000,小窗 20% 且下限 512', () => {
		expect(prefixSlack(256_000)).toBe(24_000);
		expect(prefixSlack(4_096)).toBe(819); // max(512, floor(4096*0.20))
		expect(prefixSlack(1_024)).toBe(512);
	});

	it('tailBudget - 各预设远大于写死的 8000', () => {
		expect(tailBudget(presetToTokens('128k'))).toBe(91_200); // 128000-12800-24000
		expect(tailBudget(presetToTokens('256k'))).toBe(206_400); // 256000-25600-24000
		expect(tailBudget(presetToTokens('1M'))).toBe(992_576); // 1048576-32000-24000
		expect(tailBudget(presetToTokens('128k'))).toBeGreaterThan(8_000);
		expect(tailBudget(presetToTokens('256k'))).toBeGreaterThan(8_000);
	});

	it('tailBudget - custom 小窗有 1024 下限', () => {
		// 4096 - 614 - 819 = 2663
		expect(tailBudget(4_096)).toBe(2_663);
		// 极端小窗触发下限
		expect(tailBudget(1_024)).toBe(1_024);
	});
});
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `npx vitest run tests/core/context-budget.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/context-budget'`

- [ ] **Step 1.3: 实现**

```typescript
/**
 * @file src/core/context-budget.ts
 * @description 上送历史上限推导 — 由模型窗口计算 Layer 1 预算,替代写死的 8000
 * @module core/context-budget
 */

/**
 * 输出余量:给模型回复留的空间。
 *
 * 关键路径:大窗 10% 夹在 8k–32k;窗 < 32k 时改按 15%,
 * 避免 custom 4k 上 reserve(8k) > 窗口。
 *
 * @param window - 模型上下文窗口上限(token)
 */
export function outputReserve(window: number): number {
	if (window < 32_000) return Math.max(512, Math.floor(window * 0.15));
	return Math.min(32_000, Math.max(8_192, Math.floor(window * 0.10)));
}

/**
 * 前缀预留:系统段 + 记忆 + skill discovery + 检索块 + compact head
 * 都不经 Layer 1,预算必须先扣掉;小窗按 20% 缩放。
 *
 * @param window - 模型上下文窗口上限(token)
 */
export function prefixSlack(window: number): number {
	if (window < 32_000) return Math.max(512, Math.floor(window * 0.20));
	return 24_000;
}

/**
 * Layer 1 历史池预算(projectView tail 的 token 上限)。
 *
 * 256k → 206,400;1M → 992,576;custom 4k → 2,663;下限 1,024。
 *
 * @param window - 模型上下文窗口上限(token),来自 getEffectiveChatModelMaxTokens
 */
export function tailBudget(window: number): number {
	return Math.max(1_024, window - outputReserve(window) - prefixSlack(window));
}
```

- [ ] **Step 1.4: 跑测试确认通过**

Run: `npx vitest run tests/core/context-budget.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 1.5: Commit**

```bash
git add src/core/context-budget.ts tests/core/context-budget.test.ts
git commit -m "feat: 历史上限按模型窗口推导 — 256k 下 206k,替换写死的 8000(S-CTX-TRIM)"
```

---

### Task 2: tool-result-prune — 码点头尾裁

**Files:**
- Create: `src/core/tool-result-prune.ts`
- Test: `tests/core/tool-result-prune.test.ts`

- [ ] **Step 2.1: 写失败测试**

```typescript
import { describe, it, expect } from 'vitest';
import {
	pruneOverlongText,
	TOOL_RESULT_LIMIT_CODEPOINTS,
	PRUNE_HEAD_CODEPOINTS,
	PRUNE_TAIL_CODEPOINTS,
} from '../../src/core/tool-result-prune';

describe('tool-result-prune', () => {
	it('未超限 - 原样返回', () => {
		expect(pruneOverlongText('short')).toBe('short');
	});

	it('恰好等于上限 - 不裁', () => {
		const exact = 'a'.repeat(TOOL_RESULT_LIMIT_CODEPOINTS);
		expect(pruneOverlongText(exact)).toBe(exact);
	});

	it('超限 - 保留头尾并标注省略数', () => {
		const content = 'x'.repeat(TOOL_RESULT_LIMIT_CODEPOINTS + 100);
		const out = pruneOverlongText(content);
		expect(out).toContain('[truncated 100 chars]');
		const head = out.slice(0, PRUNE_HEAD_CODEPOINTS);
		expect(head).toBe('x'.repeat(PRUNE_HEAD_CODEPOINTS));
		expect(out.endsWith('x'.repeat(PRUNE_TAIL_CODEPOINTS))).toBe(true);
	});

	it('自定义小参数 - 头尾与省略数正确', () => {
		// 10 码点,head=4, tail=1 → 省略 5
		expect(pruneOverlongText('abcdefghij', 6, 4, 1)).toBe('abcd\n[truncated 5 chars]\nj');
	});

	it('代理对不被拦腰切开 - emoji 按码点计数', () => {
		// '😀' 是代理对:1 码点 = 2 个 UTF-16 单元。
		// 3 个 😀 = 3 码点,上限 2、头 1、尾 1 → 省略 1
		const out = pruneOverlongText('😀😀😀', 2, 1, 1);
		expect(out).toBe('😀\n[truncated 1 chars]\n😀');
		// 结果不含孤立代理(拆开的 emoji 会变成乱码)
		for (const ch of Array.from(out)) {
			expect(Number.isNaN(ch.codePointAt(0))).toBe(false);
		}
	});

	it('多字节密集文本 - 码点数而非 UTF-16 数判定', () => {
		// 32001 个 '😀' → 64002 个 UTF-16 单元但 32001 码点 → 裁
		const content = '😀'.repeat(TOOL_RESULT_LIMIT_CODEPOINTS + 1);
		const out = pruneOverlongText(content);
		expect(out).toContain(`[truncated 1 chars]`);
		expect(Array.from(out).length).toBeLessThan(TOOL_RESULT_LIMIT_CODEPOINTS + 1);
	});
});
```

- [ ] **Step 2.2: 跑测试确认失败**

Run: `npx vitest run tests/core/tool-result-prune.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/tool-result-prune'`

- [ ] **Step 2.3: 实现**

```typescript
/**
 * @file src/core/tool-result-prune.ts
 * @description 单条工具结果 / 检索块码点裁剪 — 超限保留头尾并标注省略
 * @module core/tool-result-prune
 */

/** 单条工具结果 / 检索块进上送包的码点硬上限 */
export const TOOL_RESULT_LIMIT_CODEPOINTS = 32_000;
/** 超限时保留头部码点数 */
export const PRUNE_HEAD_CODEPOINTS = 24_000;
/** 超限时保留尾部码点数 */
export const PRUNE_TAIL_CODEPOINTS = 6_000;

/**
 * 按 Unicode 码点裁超长文本:超限保留头尾、中间标省略;未超原样返回。
 *
 * 关键路径:
 * - 用 Array.from 按码点展开,禁止按 UTF-16 拦腰切开代理对(emoji 等)。
 * - 纯文本工具,无 Error: 豁免 — 豁免逻辑在 ContextManager 的 tool 场景调用处。
 * - 只作用于上送副本,调用方负责不改 session.messages 原文。
 *
 * @param content - 待裁文本
 * @param limit - 码点上限(默认 32,000)
 * @param headKeep - 保留头部码点数(默认 24,000)
 * @param tailKeep - 保留尾部码点数(默认 6,000)
 * @returns 裁剪后文本;未超限返回原字符串(引用相等,便于调用方跳过拷贝)
 */
export function pruneOverlongText(
	content: string,
	limit: number = TOOL_RESULT_LIMIT_CODEPOINTS,
	headKeep: number = PRUNE_HEAD_CODEPOINTS,
	tailKeep: number = PRUNE_TAIL_CODEPOINTS,
): string {
	// 快路径:UTF-16 length ≤ limit ⇒ 码点数必然 ≤ limit,无需展开
	if (content.length <= limit) return content;
	const chars = Array.from(content);
	if (chars.length <= limit) return content;
	const omitted = chars.length - headKeep - tailKeep;
	const head = chars.slice(0, headKeep).join('');
	const tail = chars.slice(-tailKeep).join('');
	return `${head}\n[truncated ${omitted} chars]\n${tail}`;
}
```

- [ ] **Step 2.4: 跑测试确认通过**

Run: `npx vitest run tests/core/tool-result-prune.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 2.5: Commit**

```bash
git add src/core/tool-result-prune.ts tests/core/tool-result-prune.test.ts
git commit -m "feat: 单条工具结果 32k 码点头尾裁 — 代理对安全,超限标省略(S-CTX-TRIM)"
```

---

### Task 3: ContextManager — 管线插入裁剪 + trimHistory 重写

**Files:**
- Modify: `src/core/context-manager.ts`（imports、toMessages、新增两个私有方法、trimHistory 全量替换、构造第三参必传）
- Test: `tests/core/context-manager.test.ts`（新增 6 条用例；现有用例全部不得回退）

- [ ] **Step 3.1: 写失败测试**

在 `tests/core/context-manager.test.ts` 的 `Layer 1 截断` 区域后追加：

```typescript
	// ==================== S-CTX-TRIM:单条工具/检索上限 ====================

	it('toMessages - keep-recent 超长 tool 全文 - 被 32k 码点裁剪且原文不变', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: '列出所有笔记' },
				{
					role: 'assistant',
					content: '',
					toolCallId: 'c1',
					toolName: 'glob',
					toolArgs: { pattern: '**/*.md' },
				},
				// 33,000 码点:KEEP_RECENT=5 内不会被 microcompact 折叠 → 走单条上限
				{ role: 'tool', content: 'X'.repeat(33_000), toolCallId: 'c1' },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence, 8000);
		await ctx.load('s1');

		const toolMsg = ctx.toMessages().find((m) => m.role === 'tool')!;
		expect(toolMsg.content).toContain('[truncated ');
		expect(toolMsg.content.length).toBeLessThan(33_000);
		// 侧栏事实源不受影响
		expect(ctx.getTranscript()[2]!.content).toBe('X'.repeat(33_000));
	});

	it('toMessages - Error: 开头的 tool 结果 - 不裁剪', async () => {
		const sessions = new Map<string, Session>();
		const errContent = 'Error: 429 rate limited ' + 'x'.repeat(33_000);
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: 'q' },
				{
					role: 'assistant',
					content: '',
					toolCallId: 'c1',
					toolName: 'search_vault',
					toolArgs: { query: 'q' },
				},
				{ role: 'tool', content: errContent, toolCallId: 'c1' },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence, 8000);
		await ctx.load('s1');

		const toolMsg = ctx.toMessages().find((m) => m.role === 'tool')!;
		expect(toolMsg.content).toBe(errContent);
	});

	it('toMessages - 检索块超 32k 码点 - 同套头尾裁', async () => {
		const persistence = createMockPersistence();
		const ctx = createCtx(persistence, 8000);
		await ctx.load('s1');
		ctx.addUserMessage('查一下');
		ctx.replaceSearchIndexBlock([{ path: 'big.md', content: 'y'.repeat(40_000) }]);

		const searchBlock = ctx
			.toMessages()
			.filter((m) => m.role === 'system')
			.find((m) => m.content.includes('big.md'))!;
		expect(searchBlock.content).toContain('[truncated ');
		expect(searchBlock.content.length).toBeLessThan(40_000);
	});

	// ==================== S-CTX-TRIM:trimHistory 重写 ====================

	it('trimHistory - 多轮 user 超预算 - 丢更旧轮且保留最后一条 user', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: 'A'.repeat(100) },
				{ role: 'assistant', content: 'B'.repeat(100) },
				{ role: 'user', content: 'C'.repeat(100) },
				{ role: 'assistant', content: 'D'.repeat(100) },
				{ role: 'user', content: 'E'.repeat(100) },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence, 50);
		await ctx.load('s1');

		const history = ctx.toMessages().filter((m) => m.role !== 'system');
		expect(history.some((m) => m.content === 'E'.repeat(100))).toBe(true);
		expect(history.some((m) => m.content === 'A'.repeat(100))).toBe(false);
	});

	it('trimHistory - u..end 内 tool 撑爆 - tool 压占位且 user 与配对节点保留', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'user', content: '继续整理' },
				{
					role: 'assistant',
					content: '',
					toolCallId: 'c1',
					toolName: 'glob',
					toolArgs: { pattern: '**/*.md' },
				},
				{ role: 'tool', content: 'X'.repeat(2_000), toolCallId: 'c1' },
				{ role: 'assistant', content: 'R'.repeat(100) },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		// 预算 100:user ~10 + tool 500 + asst 25 → 步骤 3 丢不动(只有一轮),步骤 4 压 tool
		const ctx = createCtx(persistence, 100);
		await ctx.load('s1');

		const history = ctx.toMessages().filter((m) => m.role !== 'system');
		// user 必在、消息条数不变(tool 节点保留,正文抽空)
		expect(history.some((m) => m.role === 'user' && m.content === '继续整理')).toBe(true);
		expect(history).toHaveLength(4);
		const toolMsg = history.find((m) => m.role === 'tool')!;
		expect(toolMsg.content).toMatch(/^\[truncated\] chars=\d+$/);
		expect(toolMsg.toolCallId).toBe('c1');
	});

	it('trimHistory - 段内无 user - FIFO 退化且至少留 1 条', async () => {
		const sessions = new Map<string, Session>();
		sessions.set('s1', {
			id: 's1',
			title: '',
			messages: [
				{ role: 'assistant', content: 'A'.repeat(100) },
				{ role: 'assistant', content: 'B'.repeat(100) },
				{ role: 'assistant', content: 'C'.repeat(100) },
			],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
		const persistence = createMockPersistence(sessions);
		const ctx = createCtx(persistence, 30);
		await ctx.load('s1');

		const history = ctx.toMessages().filter((m) => m.role !== 'system');
		expect(history.length).toBeGreaterThanOrEqual(1);
		expect(history.length).toBeLessThan(3);
		// FIFO:从最旧丢,留的是最新的
		expect(history[history.length - 1]!.content).toBe('C'.repeat(100));
	});
```

- [ ] **Step 3.2: 跑测试确认失败**

Run: `npx vitest run tests/core/context-manager.test.ts`
Expected: 新增 6 条 FAIL（`[truncated ` 不存在 / 占位格式不符等）；现有用例 PASS

- [ ] **Step 3.3: 实现**

**3.3a — imports 区（`import { projectView } ...` 之后）加：**

```typescript
import { pruneOverlongText } from './tool-result-prune';
```

**3.3b — 类文档「Layer 1 截断」要点行与构造函数替换**（把 `maxHistoryTokens = 8000` 默认值删掉、第三参改必传；同步修正 JSDoc 与类头第 57 行注释）：

```typescript
	/**
	 * 历史池 token 预算上限。超出时触发 Layer 1 截断(丢更旧轮 / 压 tool 占位)。
	 * 由 tailBudget(getEffectiveChatModelMaxTokens(settings)) 推导,随窗口 128k–1M 缩放。
	 */
	private readonly maxHistoryTokens: number;

	/**
	 * @param persistence - 持久化端口,用于加载/保存 session。
	 * @param deps - 依赖注入(overrides 与 tools 来源);缺省返回空 overrides 与空工具列表。
	 * @param maxHistoryTokens - 历史池 token 上限(必传,来自 tailBudget;测试可直接给小值)。
	 */
	constructor(
		private persistence: Persistence,
		private deps: ContextManagerDeps = {
			getOverrides: () => ({}),
			getTools: () => [],
		},
		maxHistoryTokens: number,
	) {
		this.maxHistoryTokens = maxHistoryTokens;
	}
```

**3.3c — toMessages 中间段替换**（`const { head, tail } = projectView(...)` 到 `messages.push(...)`）：

```typescript
		const { head, tail } = projectView(history, markers);
		// 关键路径(S-CTX-TRIM):单条工具上限打在投影之后 —
		// microcompact 已把旧工具换短占位,这里只裁仍超长的 keep-recent 全文。
		const prunedTail = this.pruneToolContents(tail);
		const trimmedTail = this.trimHistory(prunedTail);
```

以及 push 行（searchResultsMessages 走同一套码点裁，防 RAG 块绕过 Layer 1）：

```typescript
		messages.push(...this.pruneSearchBlocks(this.searchResultsMessages), ...head, ...trimmedTail);
```

**3.3d — 类内新增两个私有方法**（放在 toMessages 之后、getTranscript 之前）：

```typescript
	/**
	 * 上送副本内对超长 tool 正文做码点头尾裁。
	 *
	 * 关键路径:`Error:` 开头的错误不裁(排障需要完整信息);只改副本不改 session.messages。
	 *
	 * @param messages - 投影后的 tail(microcompact 之后)
	 * @returns 裁剪后的消息数组(未超限的消息保持原引用)
	 */
	private pruneToolContents(messages: ChatMessage[]): ChatMessage[] {
		return messages.map((m) => {
			if (m.role !== 'tool' || !m.content || m.content.startsWith('Error:')) return m;
			const pruned = pruneOverlongText(m.content);
			return pruned === m.content ? m : { ...m, content: pruned };
		});
	}

	/**
	 * 检索注入块同一套 32k 码点裁剪 — 避免 RAG 块绕过 Layer 1 撑爆窗口。
	 *
	 * @param messages - searchResultsMessages(system 角色)
	 * @returns 裁剪后的消息数组(未超限的消息保持原引用)
	 */
	private pruneSearchBlocks(messages: ChatMessage[]): ChatMessage[] {
		return messages.map((m) => {
			if (!m.content) return m;
			const pruned = pruneOverlongText(m.content);
			return pruned === m.content ? m : { ...m, content: pruned };
		});
	}
```

**3.3e — trimHistory 整体替换：**

```typescript
	/**
	 * Layer 1 截断:tail 超预算时先丢最后一条 user 之前的更旧轮,再把窗口内 tool 正文压占位。
	 *
	 * 关键路径:
	 * - 最后一条 user 必留 — 工具结果撑爆窗口时宁可压 tool,不可丢当前问题。
	 * - assistant tool_call 与对应 tool 的节点保留(只抽空 tool 正文),不拆配对。
	 * - estimateTokens 逐字符分类计数、严格可加 — 每条单独估算之和 === 全量 join 估算,
	 *   避免 while 里反复 join 全量文本的 O(n²) 扫描(预算 200k+ 时 tail 很大)。
	 * - 截断只影响发给 LLM 的消息列表,不修改 session.messages 原文。
	 *
	 * @param messages - 投影并经单条上限裁剪后的 tail 消息(不含 head 摘要段)
	 * @returns 裁剪后的消息数组(可能比输入短、tool 正文可能被压成占位)
	 */
	private trimHistory(messages: ChatMessage[]): ChatMessage[] {
		if (messages.length <= 1) return messages;

		const tokensPerMsg = messages.map((m) => estimateTokens(m.content));
		let total = tokensPerMsg.reduce((sum, n) => sum + n, 0);
		if (total <= this.maxHistoryTokens) return messages;

		const lastUserIdx = messages.findLastIndex((m) => m.role === 'user');

		// 退化:段内无 user(compact 后边界截断等罕见场景)→ 沿用 FIFO,至少留最后 1 条。
		if (lastUserIdx === -1) {
			let start = 0;
			while (total > this.maxHistoryTokens && messages.length - start > 1) {
				total -= tokensPerMsg[start]!;
				start++;
			}
			return messages.slice(start);
		}

		// 步骤 3:丢最后一条 user 之前的更旧消息(从最旧起),直到不超预算或只剩 u..end。
		let start = 0;
		while (total > this.maxHistoryTokens && start < lastUserIdx) {
			total -= tokensPerMsg[start]!;
			start++;
		}
		if (total <= this.maxHistoryTokens) return messages.slice(start);

		// 步骤 4:u..end 仍超 — 把窗口内 tool 正文压成占位(大者先),不删 user、不拆配对。
		// 上游 pruneToolContents 已做过 32k 码点裁,这里是极端兜底;压完仍超则原样上送,
		// 交由 PTL 重试 / 85% 自动压缩(compact-v2)兜底。
		const out = messages.slice(start).map((m) => ({ ...m }));
		const toolOrder: Array<{ rel: number; n: number }> = [];
		for (let i = start; i < messages.length; i++) {
			if (messages[i]!.role === 'tool' && messages[i]!.content.length > 0) {
				toolOrder.push({ rel: i - start, n: tokensPerMsg[i]! });
			}
		}
		toolOrder.sort((a, b) => b.n - a.n);
		for (const { rel, n } of toolOrder) {
			if (total <= this.maxHistoryTokens) break;
			const msg = out[rel]!;
			const chars = Array.from(msg.content).length;
			out[rel] = { ...msg, content: `[truncated] chars=${chars}` };
			total -= n;
		}
		return out;
	}
```

同时检查全仓 `new ContextManager(` 调用点：`src/main.ts` 两处暂未传第三参会 TS 编译报错 — 这是**预期失败**，Task 4 接线修复；本 Task 先在 `tests` 内跑（vitest 不做全仓类型检查，`npx vitest run` 可通过）。

- [ ] **Step 3.4: 跑测试确认通过**

Run: `npx vitest run tests/core/context-manager.test.ts`
Expected: PASS（含既有 29 条 + 新增 6 条；现有用例零回退）

- [ ] **Step 3.5: Commit**

```bash
git add src/core/context-manager.ts tests/core/context-manager.test.ts
git commit -m "feat: trimHistory 保当前 user、tool 先裁后压占位 — 检索块同套 32k 裁(S-CTX-TRIM)"
```

---

### Task 4: main.ts 接线 + 文档 + 全量验证

**Files:**
- Modify: `src/main.ts:1296`（ask）、`src/main.ts:1436`（createContext）
- Modify: `CHANGELOG.md`（[Unreleased]）
- Modify: `docs/user-guide.md`（FAQ 表）

- [ ] **Step 4.1: main.ts 注入预算**

import 区（`getEffectiveChatModelMaxTokens` 所在行附近）加：

```typescript
import { tailBudget } from './core/context-budget';
```

`ask()` 内（原 1296 行）第三参：

```typescript
		const ctx = new ContextManager(
			this.persistence,
			{
				getOverrides: () => this.settings.promptOverrides,
				getTools: () => this.tools.definitions(),
				// ADR-012:仅 Discovery;Active 指令写入 Session.messages。
				getSkillsDiscovery: () =>
					this.settings.enableSkills
						? this.skillActivator.composeDiscovery(this.settings.promptOverrides)
						: '',
				getSkillsActive: () => '',
			},
			// 关键路径(S-CTX-TRIM):历史上限随窗口推导,替换写死的 8000
			tailBudget(getEffectiveChatModelMaxTokens(this.settings)),
		);
```

`createContext()`（原 1436 行）：

```typescript
	createContext(): ContextManager {
		return new ContextManager(
			this.persistence,
			{
				getOverrides: () => this.settings.promptOverrides,
				getTools: () => this.tools.definitions(),
			},
			tailBudget(getEffectiveChatModelMaxTokens(this.settings)),
		);
	}
```

- [ ] **Step 4.2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无 `new ContextManager` 相关错误（若有遗漏调用点，按同款补 tailBudget）

- [ ] **Step 4.3: CHANGELOG [Unreleased] 补条目**

`### Fixed` 区追加（放「刚发出请求点暂停立即生效」之前，问题最重在前）：

```markdown
- **窗口再大、工具输出再长,你的提问也不会被挤出对话** — 之前历史上限按 32K 时代写死,占用才 1% 时一轮大搜索就可能先砍掉你刚发的问题,模型回「你还没提问」;现在按你设置的模型窗口留足空间
```

`### Changed` 区（在 Fixed 之前新建）追加：

```markdown
- **单条超长工具结果先截短再发给模型** — 一次搜出几千个文件时,发给模型的正文保留头尾要点,聊天气泡里仍是全文;需要中段时模型会自己再查
```

- [ ] **Step 4.4: user-guide FAQ 表追加一行**（表格末尾、「为什么不帮我填 API Key」行之后）

```markdown
| 工具输出特别长会怎样？ | 发给模型的正文截到 3.2 万字符以内（保留头尾要点）；聊天气泡里仍是全文。长任务续跑时最好带上任务原句 |
```

- [ ] **Step 4.5: 全量验证**

Run: `npm test && npm run build`
Expected: 全部测试通过（0 failed）；build 成功产出 `dist/main.js` / `dist/worker.js` / `dist/embedding-worker.js`

- [ ] **Step 4.6: Commit**

```bash
git add src/main.ts CHANGELOG.md docs/user-guide.md
git commit -m "feat: 上送历史上限随模型窗口生效 — ask/compact 两条路径接线(S-CTX-TRIM)"
```

---

## 自审

- **Spec 覆盖:** 目标 1（一把尺子）→ Task 1+4；目标 2（先裁工具）→ Task 2+3；目标 3（user 必留/不拆配对）→ Task 3；目标 4（压缩位次不动）→ 无代码改动，测试「现有 compact 投影、85% 决策、microcompact 单测不回退」由全量 npm test 保证；目标 5（侧栏全文）→ Task 3 测试断言 getTranscript 原文不变。成功标准逐条有测试对应。
- **占位符扫描:** 无 TBD/TODO；所有 step 含完整代码与精确命令。
- **类型一致性:** `pruneOverlongText(content, limit?, headKeep?, tailKeep?)` 四参在 Task 2 定义、Task 3 单默认参调用一致；`tailBudget(window)` Task 1 定义、Task 4 调用一致；占位格式 `[truncated] chars=N`（trimHistory 兜底）与 `[truncated N chars]`（单条裁剪标记行）为两种不同语义，测试各自断言。
- **单位纪律:** 预算路径只用 `estimateTokens`（token）；裁剪路径只用码点。无混比。
- **回退风险:** 旧测试「历史超预算 - 从最旧裁剪,保留最后一条」走新步骤 3 得 `[C,D,E]`（length 3 < 5、末条 E）通过；「用户问完后工具结果撑爆预算」走步骤 4 压 tool 通过；「历史未超预算 - 不裁剪」早退路径不变。

## 执行记录区（执行时填写）

- 分支：feat-p-ctx-trim（worktree）
- 执行方式：subagent-driven-development

### 执行记录 / 偏差说明

- **Task 1 偏差：** 实施时发现 plan 内嵌公式存在 32k 分界悬崖（outputReserve 8,192 下限 + prefixSlack 固定 24,000 导致 32k 窗口预算暴跌）。按 spec「审查修订」段修正：outputReserve 大窗去下限、prefixSlack 大窗改 `min(24_000, 20%)` 随窗口缩放（commit 67ef399）。**结论：Task 1 内嵌代码与测试期望以 spec 修订为准，后续重放勿按本 plan 字面代码。**
- **final review 修复：** trimHistory 步骤 4 出口补 `sanitizeToolMessageOrder`（三出口防御一致）+ 端到端测试「FIFO 丢前缀切散 tool 配对 - 剔除孤立 tool 保留配对完整」锁定防线。
