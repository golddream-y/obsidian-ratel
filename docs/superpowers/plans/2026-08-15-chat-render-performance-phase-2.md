# P-CHAT-PERF-2 — 稳定 Markdown 块冻结 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在流式轻渲染基础上，把边界明确的 Markdown 块只富渲染一次并冻结，活动尾部继续使用轻量文本，结束时只处理剩余尾部。

**Architecture:** 复用现有 marked lexer 将尾部拆成 token；流式期间永久保留最后一个语义 token 为活动尾部，只有其前方 token 可以晋升。`StableMarkdownProjection` 仅在新换行或围栏标记出现时检查尾部，使用源码偏移生成稳定 block id；跨块引用定义存在时整段降级为一个块。

**Tech Stack:** TypeScript strict、marked 18、Svelte 5、Vitest、jsdom、现有 `MarkdownView` 富渲染管线。

**Spec:** [S-CHAT-PERF](../specs/2026-08-15-chat-render-performance-design.md)

**Depends on:** `P-CHAT-PERF-1` 已完成并通过 Sandbox 验收。

---

## 目标

- 已稳定段落、标题、列表、表格和闭合围栏只生成一次富 DOM。
- 最后一个语义 token 永远留在活动尾部，避免猜测模型下一行是否继续当前块。
- 未闭合围栏、引用定义等跨块依赖不提前冻结。
- 工具边界、取消、异常和正常结束只富渲染剩余尾部，不重绘已冻结块。
- 16K 长回复的解析次数与候选块边界相关，不与 200 个 delta 数量相关。

## 架构

```text
新增 delta
   ↓
StableMarkdownProjection
   ├─ 无换行/围栏候选 → 只追加 tail，不调用 lexer
   └─ 有候选边界      → splitStableMarkdownBlocks(tail)
                              ├─ stableBlocks[] → keyed MarkdownView（冻结）
                              └─ tail           → P1 轻渲染

streaming=false
   ↓
finish() → 只完成剩余 tail
```

## 技术栈

- 使用现有 `markedInstance.lexer()`，不引入第二套 Markdown parser。
- 投影算法是纯 TypeScript；Svelte 组件只持有 snapshot 并 keyed 渲染。
- 每个稳定块仍复用 `MarkdownView`，因此 DOMPurify、代码高亮、Mermaid、引用和富块按钮保持同源。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/utils/markdown-renderer.ts` | Modify | 导出稳定 token 拆分函数 |
| `tests/utils/markdown-renderer.test.ts` | Modify | token 边界、围栏、列表、表格、引用定义测试 |
| `src/ui/chat/stable-markdown-projection.ts` | Create | 增量尾部、稳定块 id、finalize 与异常重置 |
| `tests/ui/chat/stable-markdown-projection.test.ts` | Create | 增量、冻结、重置、解析频率测试 |
| `src/ui/components/StreamingMarkdownView.svelte` | Create | keyed 稳定块 + 活动轻量尾部 |
| `src/ui/chat/message-stream/TextSegment.svelte` | Modify | 助手文本统一走 StreamingMarkdownView |
| `src/ui/chat/message-stream/MessageBubble.svelte` | Modify | 为同消息的不同文本块传稳定 streamKey |
| `tests/perf/chat-stable-block-policy.test.ts` | Create | 16K 多块回复的渲染次数合同 |

---

### Task 1: marked token 稳定块拆分

**Files:**
- Modify: `src/utils/markdown-renderer.ts:71-218`
- Modify: `tests/utils/markdown-renderer.test.ts`

- [ ] **Step 1: 写失败测试**

在测试导入中加入 `splitStableMarkdownBlocks`，并追加：

```typescript
describe('splitStableMarkdownBlocks', () => {
	it('拆分 - 两个段落 - 冻结第一段并保留最后一段', () => {
		const input = '第一段。\n\n第二段正在写';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.stableBlocks.join('') + result.tail).toBe(input);
		expect(result.stableBlocks).toEqual(['第一段。\n\n']);
		expect(result.tail).toBe('第二段正在写');
	});

	it('拆分 - 未闭合围栏 - 不提前冻结围栏内容', () => {
		const input = '```ts\nconst x = 1;\n';
		expect(splitStableMarkdownBlocks(input, false)).toEqual({
			stableBlocks: [], tail: input, hasCrossBlockDependency: false,
		});
	});

	it('拆分 - 闭合围栏后出现新段落 - 围栏成为稳定块', () => {
		const input = '```ts\nconst x = 1;\n```\n\n后文';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.stableBlocks).toHaveLength(1);
		expect(result.stableBlocks[0]).toContain('```ts');
		expect(result.tail).toBe('后文');
	});

	it('拆分 - GFM 表格后出现段落 - 表格整体冻结', () => {
		const input = '| A | B |\n|---|---|\n| 1 | 2 |\n\n后文';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.stableBlocks).toHaveLength(1);
		expect(result.stableBlocks[0]).toContain('|---|---|');
		expect(result.tail).toBe('后文');
	});

	it('拆分 - 宽松列表继续 - 不把同一 list token 拆开', () => {
		const input = '- A\n\n- B\n\n后文';
		const result = splitStableMarkdownBlocks(input, false);
		expect(result.stableBlocks).toHaveLength(1);
		expect(result.stableBlocks[0]).toContain('- A');
		expect(result.stableBlocks[0]).toContain('- B');
	});

	it('拆分 - Markdown 引用定义 - 流式不拆且结束时只生成一个块', () => {
		const input = '参考 [文档][ref]。\n\n[ref]: https://example.com';
		expect(splitStableMarkdownBlocks(input, false)).toEqual({
			stableBlocks: [], tail: input, hasCrossBlockDependency: true,
		});
		expect(splitStableMarkdownBlocks(input, true)).toEqual({
			stableBlocks: [input], tail: '', hasCrossBlockDependency: true,
		});
	});

	it('拆分 - 未解析引用使用但定义尚未到达 - 也不提前冻结', () => {
		const input = '参考 [文档][ref]。\n\n下一段正在写';
		expect(splitStableMarkdownBlocks(input, false)).toEqual({
			stableBlocks: [], tail: input, hasCrossBlockDependency: true,
		});
	});

	it('拆分 - finalize 普通文本 - 返回所有 token 且源码可重建', () => {
		const input = '# 标题\n\n正文\n\n- A\n- B';
		const result = splitStableMarkdownBlocks(input, true);
		expect(result.stableBlocks.join('') + result.tail).toBe(input);
		expect(result.tail).toBe('');
		expect(result.stableBlocks.length).toBeGreaterThan(1);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/utils/markdown-renderer.test.ts`

Expected: FAIL，`splitStableMarkdownBlocks` 未导出。

- [ ] **Step 3: 在 markdown-renderer.ts 实现拆分函数**

在 `areAllCodeBlocksClosed` 之前加入：

```typescript
export interface StableMarkdownSplit {
	stableBlocks: string[];
	tail: string;
	hasCrossBlockDependency: boolean;
}

/**
 * 按 marked lexer 的顶层 token 切出稳定前缀，最后一个语义 token 永远留作活动尾部。
 *
 * 关键路径:引用定义会改变前文链接解析，检测到 def token 时整段不拆。
 *
 * @param text - 尚未冻结的 Markdown 尾部
 * @param finalize - 是否结束流式并完成全部尾部
 * @returns 稳定块、活动尾部和跨块依赖标记
 * @example
 *   splitStableMarkdownBlocks('第一段\n\n第二段', false);
 */
export function splitStableMarkdownBlocks(
	text: string,
	finalize: boolean,
): StableMarkdownSplit {
	if (!text) return { stableBlocks: [], tail: '', hasCrossBlockDependency: false };

	const tokens = markedInstance.lexer(text);
	// 关键路径:定义可能尚未流到；非数字 shortcut/reference link 也必须阻止前文冻结。
	const hasReferenceUse = /(^|[^!])\[(?!\d+\])([^\]\n]+)\](?!\s*\()/m.test(text);
	const hasCrossBlockDependency =
		hasReferenceUse || tokens.some((token) => token.type === 'def');
	if (hasCrossBlockDependency) {
		return finalize
			? { stableBlocks: [text], tail: '', hasCrossBlockDependency: true }
			: { stableBlocks: [], tail: text, hasCrossBlockDependency: true };
	}

	const semanticIndexes = tokens
		.map((token, index) => token.type === 'space' ? -1 : index)
		.filter((index) => index >= 0);
	if (!finalize && semanticIndexes.length < 2) {
		return { stableBlocks: [], tail: text, hasCrossBlockDependency: false };
	}

	const cut = finalize ? tokens.length : semanticIndexes[semanticIndexes.length - 1]!;
	const stableTokens = tokens.slice(0, cut);
	const stableBlocks: string[] = [];
	let leadingSpace = '';
	for (const token of stableTokens) {
		if (token.type === 'space') {
			if (stableBlocks.length > 0) {
				stableBlocks[stableBlocks.length - 1] += token.raw;
			} else {
				leadingSpace += token.raw;
			}
			continue;
		}
		stableBlocks.push(leadingSpace + token.raw);
		leadingSpace = '';
	}
	if (leadingSpace && stableBlocks.length > 0) {
		stableBlocks[stableBlocks.length - 1] += leadingSpace;
	}
	if (finalize && stableBlocks.length === 0) {
		return { stableBlocks: [text], tail: '', hasCrossBlockDependency: false };
	}

	const stableText = stableBlocks.join('');
	// 修复:lexer raw 无法无损覆盖源码时保持轻量尾部，禁止错误截断。
	if (!text.startsWith(stableText)) {
		return { stableBlocks: [], tail: text, hasCrossBlockDependency: false };
	}
	return {
		stableBlocks,
		tail: text.slice(stableText.length),
		hasCrossBlockDependency: false,
	};
}
```

- [ ] **Step 4: 运行 renderer 测试确认通过**

Run: `npx vitest run tests/utils/markdown-renderer.test.ts`

Expected: 原有测试与新增 7 tests 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/utils/markdown-renderer.ts tests/utils/markdown-renderer.test.ts
git commit -m "feat(chat): 识别可冻结 Markdown 稳定块"
```

---

### Task 2: 增量稳定块投影与源码偏移 id

**Files:**
- Create: `src/ui/chat/stable-markdown-projection.ts`
- Create: `tests/ui/chat/stable-markdown-projection.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/chat/stable-markdown-projection.test.ts
 * @description 流式尾部提升为稳定 Markdown 块的增量投影
 * @module tests/ui/chat/stable-markdown-projection
 */
import { describe, expect, it, vi } from 'vitest';
import {
	StableMarkdownProjection,
	type MarkdownSplitter,
} from '../../../src/ui/chat/stable-markdown-projection';

describe('StableMarkdownProjection', () => {
	it('update - 新段落出现 - 冻结前段且 block id 保持稳定', () => {
		const projection = new StableMarkdownProjection();
		let snapshot = projection.update('第一段。\n\n第二');
		expect(snapshot.blocks).toHaveLength(1);
		const firstId = snapshot.blocks[0]!.id;
		snapshot = projection.update('第一段。\n\n第二段继续');
		expect(snapshot.blocks[0]!.id).toBe(firstId);
		expect(snapshot.tail).toBe('第二段继续');
	});

	it('update - 纯单行 200 次追加 - 不调用 splitter', () => {
		const splitter: MarkdownSplitter = vi.fn(() => ({
			stableBlocks: [], tail: '', hasCrossBlockDependency: false,
		}));
		const projection = new StableMarkdownProjection(splitter);
		let content = '';
		for (let i = 0; i < 200; i++) {
			content += 'x'.repeat(80);
			projection.update(content);
		}
		expect(content).toHaveLength(16_000);
		expect(splitter).not.toHaveBeenCalled();
	});

	it('finish - 已有稳定块 - 只完成剩余尾部', () => {
		const projection = new StableMarkdownProjection();
		projection.update('第一段。\n\n第二');
		const before = projection.snapshot().blocks[0];
		const final = projection.finish('第一段。\n\n第二段。');
		expect(final.tail).toBe('');
		expect(final.blocks[0]).toEqual(before);
		expect(final.blocks.map((b) => b.source).join('')).toBe('第一段。\n\n第二段。');
	});

	it('update - 内容不再保持前缀 - 清空旧块并从新文本重建', () => {
		const projection = new StableMarkdownProjection();
		projection.update('旧一。\n\n旧二');
		const reset = projection.update('新内容');
		expect(reset.blocks).toEqual([]);
		expect(reset.tail).toBe('新内容');
	});

	it('update - 未解析引用使用 - 定义到达前不冻结前文', () => {
		const projection = new StableMarkdownProjection();
		const snapshot = projection.update('参考 [文档][ref]。\n\n下一段');
		expect(snapshot.blocks).toEqual([]);
		expect(snapshot.tail).toContain('[文档][ref]');
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/chat/stable-markdown-projection.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 写投影实现**

```typescript
/**
 * @file src/ui/chat/stable-markdown-projection.ts
 * @description 管理流式 Markdown 的稳定块、活动尾部与源码偏移 id
 * @module ui/chat/stable-markdown-projection
 * @depends ../../utils/markdown-renderer
 */
import {
	splitStableMarkdownBlocks,
	type StableMarkdownSplit,
} from '../../utils/markdown-renderer';

export interface StableMarkdownBlock {
	id: string;
	start: number;
	end: number;
	source: string;
}

export interface StableMarkdownSnapshot {
	blocks: StableMarkdownBlock[];
	tail: string;
}

export type MarkdownSplitter = (text: string, finalize: boolean) => StableMarkdownSplit;

/**
 * 增量维护稳定 Markdown 块；已生成块永不因后续正常 delta 改写。
 *
 * 设计要点:
 * - 仅分析尚未冻结的尾部，避免每次 delta 重做全量 lexer。
 * - 使用源码偏移生成稳定 id，保证 keyed DOM 节点能够复用。
 *
 * @example
 *   const projection = new StableMarkdownProjection();
 *   projection.update('第一段。\n\n第二');
 */
export class StableMarkdownProjection {
	private fullText = '';
	private tail = '';
	private consumed = 0;
	private blocks: StableMarkdownBlock[] = [];

	constructor(private readonly split: MarkdownSplitter = splitStableMarkdownBlocks) {}

	/**
	 * 接收最新完整文本，只在新增换行或围栏候选时分析尾部。
	 *
	 * @param nextText - 当前 text segment 的最新完整文本
	 * @returns 稳定块与活动尾部快照
	 * @example
	 *   projection.update('第一段。\n\n第二');
	 */
	update(nextText: string): StableMarkdownSnapshot {
		if (!nextText.startsWith(this.fullText)) this.reset();
		const delta = nextText.slice(this.fullText.length);
		this.fullText = nextText;
		this.tail += delta;
		if (!/[\n`~]/.test(delta)) return this.snapshot();
		this.promote(this.split(this.tail, false));
		return this.snapshot();
	}

	/**
	 * 完成本段，只切剩余尾部，不重新处理已冻结块。
	 *
	 * @param nextText - text segment 的最终完整文本
	 * @returns 尾部完成后的稳定块快照
	 * @example
	 *   projection.finish('第一段。\n\n第二段。');
	 */
	finish(nextText: string): StableMarkdownSnapshot {
		this.update(nextText);
		this.promote(this.split(this.tail, true));
		return this.snapshot();
	}

	/**
	 * 返回不可变快照，供 Svelte keyed each 使用。
	 *
	 * @returns 当前稳定块数组副本与活动尾部
	 * @example
	 *   const snapshot = projection.snapshot();
	 */
	snapshot(): StableMarkdownSnapshot {
		return { blocks: this.blocks.slice(), tail: this.tail };
	}

	/**
	 * 清理会话切换或非前缀改写产生的旧投影。
	 *
	 * @returns 无返回值
	 * @example
	 *   projection.reset();
	 */
	reset(): void {
		this.fullText = '';
		this.tail = '';
		this.consumed = 0;
		this.blocks = [];
	}

	private promote(result: StableMarkdownSplit): void {
		for (const source of result.stableBlocks) {
			const start = this.consumed;
			const end = start + source.length;
			this.blocks.push({ id: `md:${start}:${end}`, start, end, source });
			this.consumed = end;
		}
		this.tail = result.tail;
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/chat/stable-markdown-projection.test.ts tests/utils/markdown-renderer.test.ts`

Expected: 所有测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/stable-markdown-projection.ts tests/ui/chat/stable-markdown-projection.test.ts
git commit -m "feat(chat): 增量投影 Markdown 稳定块"
```

---

### Task 3: keyed 稳定块组件与 TextSegment 接入

**Files:**
- Create: `src/ui/components/StreamingMarkdownView.svelte`
- Modify: `src/ui/chat/message-stream/TextSegment.svelte`
- Test: `tests/ui/chat/stable-markdown-projection.test.ts`

- [ ] **Step 1: 扩展失败测试，验证工具边界 finish 不重建旧块**

在 `stable-markdown-projection.test.ts` 追加：

```typescript
	it('finish - 两次调用相同终态 - 不追加重复块', () => {
		const projection = new StableMarkdownProjection();
		const first = projection.finish('第一段。\n\n第二段。');
		const second = projection.finish('第一段。\n\n第二段。');
		expect(second.blocks).toEqual(first.blocks);
	});
```

- [ ] **Step 2: 运行测试确认重复 finish 失败**

Run: `npx vitest run tests/ui/chat/stable-markdown-projection.test.ts`

Expected: FAIL，第二次 finish 重复处理空尾部或重复追加。

- [ ] **Step 3: 让 finish 幂等**

加入 `finished` 字段，并用以下完整方法替换 `update()`、`finish()` 与 `reset()`：

```typescript
	private finished = false;

	/**
	 * 接收最新完整文本，只在新增换行或围栏候选时分析尾部。
	 *
	 * @param nextText - 当前 text segment 的最新完整文本
	 * @returns 稳定块与活动尾部快照
	 * @example
	 *   projection.update('第一段。\n\n第二');
	 */
	update(nextText: string): StableMarkdownSnapshot {
		if (!nextText.startsWith(this.fullText)) this.reset();
		if (nextText !== this.fullText) this.finished = false;
		const delta = nextText.slice(this.fullText.length);
		this.fullText = nextText;
		this.tail += delta;
		if (!/[\n`~]/.test(delta)) return this.snapshot();
		this.promote(this.split(this.tail, false));
		return this.snapshot();
	}

	/**
	 * 完成本段，只切剩余尾部，不重新处理已冻结块。
	 *
	 * @param nextText - text segment 的最终完整文本
	 * @returns 尾部完成后的稳定块快照
	 * @example
	 *   projection.finish('第一段。\n\n第二段。');
	 */
	finish(nextText: string): StableMarkdownSnapshot {
		this.update(nextText);
		if (this.finished) return this.snapshot();
		this.promote(this.split(this.tail, true));
		this.finished = true;
		return this.snapshot();
	}

	/**
	 * 清理会话切换或非前缀改写产生的旧投影。
	 *
	 * @returns 无返回值
	 * @example
	 *   projection.reset();
	 */
	reset(): void {
		this.fullText = '';
		this.tail = '';
		this.consumed = 0;
		this.blocks = [];
		this.finished = false;
	}
```

- [ ] **Step 4: 新建 StreamingMarkdownView.svelte**

```svelte
<!--
	@file src/ui/components/StreamingMarkdownView.svelte
	@description 已稳定 Markdown 块 keyed 富渲染，活动尾部复用轻量 MarkdownView
	@module ui/components/StreamingMarkdownView
	@depends ./MarkdownView, ../chat/stable-markdown-projection
-->
<script lang="ts">
	import MarkdownView from './MarkdownView.svelte';
	import {
		StableMarkdownProjection,
		type StableMarkdownSnapshot,
	} from '../chat/stable-markdown-projection';

	let {
		content,
		streaming = false,
		searchResults,
		onOpenPath,
		motionOn = false,
		messageId = '',
		streamKey = messageId,
	}: {
		content: string;
		streaming?: boolean;
		searchResults?: Array<{ docId: string; score: number; path: string; index: number }>;
		onOpenPath?: (path: string) => void;
		motionOn?: boolean;
		messageId?: string;
		streamKey?: string;
	} = $props();

	let projection = new StableMarkdownProjection();
	let snapshot = $state<StableMarkdownSnapshot>({ blocks: [], tail: '' });
	let trackedStreamKey = $state('');
	let participatedInStream = $state(false);

	$effect(() => {
		const nextText = content;
		const nextStreaming = streaming;
		const nextStreamKey = streamKey;
		if (trackedStreamKey !== nextStreamKey) {
			trackedStreamKey = nextStreamKey;
			projection = new StableMarkdownProjection();
			snapshot = { blocks: [], tail: '' };
			participatedInStream = false;
		}
		if (nextStreaming) {
			participatedInStream = true;
			snapshot = projection.update(nextText);
		} else if (participatedInStream) {
			snapshot = projection.finish(nextText);
		}
	});
</script>

{#if participatedInStream}
	{#each snapshot.blocks as block (block.id)}
		<div class="ratel-md-stable" data-ratel-stream-block={block.id}>
			<MarkdownView
				content={block.source}
				streaming={false}
				{searchResults}
				{onOpenPath}
				{motionOn}
				{messageId}
			/>
		</div>
	{/each}
	{#if snapshot.tail}
		<div class="ratel-md-active-tail">
			<MarkdownView
				content={snapshot.tail}
				streaming={true}
				{searchResults}
				{onOpenPath}
				{motionOn}
				{messageId}
			/>
		</div>
	{/if}
{:else}
	<MarkdownView
		{content}
		streaming={false}
		{searchResults}
		{onOpenPath}
		{motionOn}
		{messageId}
	/>
{/if}
```

- [ ] **Step 5: TextSegment 的助手分支改用 StreamingMarkdownView**

把导入改为：

```typescript
	import StreamingMarkdownView from '../../components/StreamingMarkdownView.svelte';
```

给 TextSegment 增加可选 prop `streamKey = messageId`，助手分支改用 `<StreamingMarkdownView>`；用户消息继续使用纯文本分支。

用以下 props 定义替换 `TextSegment.svelte` 的 props：

```typescript
	let {
		text,
		isUser = false,
		streaming = false,
		searchResults,
		onOpenPath,
		motionOn = false,
		messageId = '',
		streamKey = messageId,
	}: {
		text: string;
		isUser?: boolean;
		streaming?: boolean;
		searchResults?: Array<{ docId: string; score: number; path: string; index: number }>;
		onOpenPath?: (path: string) => void;
		motionOn?: boolean;
		messageId?: string;
		streamKey?: string;
	} = $props();
```

助手模板完整替换为：

```svelte
{:else}
	<div class="ratel-text-segment ratel-text-assistant">
		<StreamingMarkdownView
			content={text}
			{streaming}
			{searchResults}
			{onOpenPath}
			{motionOn}
			{messageId}
			{streamKey}
		/>
	</div>
{/if}
```

在 `MessageBubble.svelte` 的 TextSegment 调用中加入：

```svelte
				streamKey={`${msg.id}:${blockIndex}`}
```

这里复用 P1 已加入的 `blockIndex`，保证同一助手消息中“工具前文本”和“工具后文本”不会共享投影实例。

- [ ] **Step 6: 运行测试、Svelte 检查和构建**

Run: `npx vitest run tests/ui/chat/stable-markdown-projection.test.ts tests/utils/markdown-renderer.test.ts tests/ui/chat/streaming-markdown-state.test.ts && npm run svelte-check && npm run build`

Expected: 测试 PASS；Svelte 0 errors；build exit 0。

- [ ] **Step 7: 提交**

```bash
git add src/ui/components/StreamingMarkdownView.svelte src/ui/chat/message-stream/TextSegment.svelte src/ui/chat/message-stream/MessageBubble.svelte src/ui/chat/stable-markdown-projection.ts tests/ui/chat/stable-markdown-projection.test.ts
git commit -m "feat(chat): 流式冻结已完成 Markdown 块"
```

---

### Task 4: 稳定块性能合同与跨块语义回归

**Files:**
- Create: `tests/perf/chat-stable-block-policy.test.ts`
- Modify: `tests/utils/markdown-renderer.test.ts`

- [ ] **Step 1: 写性能合同测试**

```typescript
// @vitest-environment jsdom
/**
 * @file tests/perf/chat-stable-block-policy.test.ts
 * @description 稳定块渲染次数只随块数量增长，不随 delta 数量增长
 * @module tests/perf/chat-stable-block-policy
 */
import { describe, expect, it } from 'vitest';
import { StableMarkdownProjection } from '../../src/ui/chat/stable-markdown-projection';
import { renderMarkdownToHtml } from '../../src/utils/markdown-renderer';

describe('稳定 Markdown 块性能合同', () => {
	it('16K / 200 delta - 富渲染次数不超过最终块数', () => {
		const projection = new StableMarkdownProjection();
		let content = '';
		let renderedBlocks = 0;
		let seenBlocks = 0;

		for (let i = 0; i < 200; i++) {
			content += 'x'.repeat(78);
			if ((i + 1) % 10 === 0) content += '\n\n';
			const snapshot = projection.update(content);
			for (const block of snapshot.blocks.slice(seenBlocks)) {
				renderMarkdownToHtml(block.source);
				renderedBlocks++;
			}
			seenBlocks = snapshot.blocks.length;
		}

		const final = projection.finish(content);
		for (const block of final.blocks.slice(seenBlocks)) {
			renderMarkdownToHtml(block.source);
			renderedBlocks++;
		}

		expect(content.length).toBeGreaterThanOrEqual(15_000);
		expect(final.tail).toBe('');
		expect(renderedBlocks).toBe(final.blocks.length);
		expect(renderedBlocks).toBe(final.blocks.length);
		expect(renderedBlocks).toBeLessThanOrEqual(20);
	});
});
```

- [ ] **Step 2: 补静态语义对照测试**

在 `markdown-renderer.test.ts` 追加：

```typescript
	it('拆分 - 普通块分别渲染 - 可见文本顺序与整段一致', () => {
		const input = '# 标题\n\n正文。\n\n- A\n- B';
		const split = splitStableMarkdownBlocks(input, true);
		const fullDoc = new DOMParser().parseFromString(renderMarkdownToHtml(input), 'text/html');
		const blockDoc = new DOMParser().parseFromString(
			split.stableBlocks.map(renderMarkdownToHtml).join(''),
			'text/html',
		);
		expect(blockDoc.body.textContent).toBe(fullDoc.body.textContent);
	});
```

- [ ] **Step 3: 运行专项测试**

Run: `npx vitest run tests/perf/chat-stable-block-policy.test.ts tests/ui/chat/stable-markdown-projection.test.ts tests/utils/markdown-renderer.test.ts`

Expected: 所有专项测试 PASS。

- [ ] **Step 4: 提交**

```bash
git add tests/perf/chat-stable-block-policy.test.ts tests/utils/markdown-renderer.test.ts
git commit -m "test(chat): 固化稳定块渲染性能合同"
```

---

### Task 5: 完整验证、Sandbox 节点身份检查与状态登记

**Files:**
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: 跑完整自动验证**

Run: `npm test && npm run lint && npm run typecheck && npm run build`

Expected: 全部 exit 0，0 test failures。

- [ ] **Step 2: 只链接 Sandbox**

Run: `npm run link:vault -- "<sandbox>"`

Expected: 只更新 Sandbox 链接，不触碰日常主库。

- [ ] **Step 3: Sandbox 验收稳定块**

Reload app without saving 后生成包含“段落 → 列表 → 代码围栏 → Mermaid → 后续段落”的长回复，确认：

1. 活动尾部连续增长，已经完成的块提前呈现 Markdown。
2. 未闭合围栏保持轻量文本，闭合且后续块开始后才提升。
3. 工具出现时前一文本段完成，工具后新文本建立新的活动尾部。
4. 引用、复制和 Mermaid 对每个稳定块正常工作。
5. 在 DevTools 选中一个 `[data-ratel-stream-block]` 节点，继续生成后确认该节点仍是同一 DOM 实例。
6. 停止生成后不发生整条助手消息闪白或全量 DOM 替换。

- [ ] **Step 4: 更新 STATUS 并提交**

把 `P-CHAT-PERF-2` 更新为 `✅ Completed`，记录实际分支、测试总数和 Sandbox 结果；P3 保持 Pending。

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs(status): 完成稳定 Markdown 块冻结"
```

---

## 自审

- [ ] Spec §5.3：检测器只扫描活动尾部，正常 delta 不扫描已冻结源码。
- [ ] Spec §5.3：最后一个语义 token 不提前冻结；未闭合围栏保持 tail。
- [ ] Spec §5.3：引用定义存在时流式不拆，finish 后单块渲染。
- [ ] Spec §5.3：结束时只完成 tail，不重新渲染旧 stable blocks。
- [ ] Spec §6：16K 多块性能合同和 DOM id 稳定性均有验证。
- [ ] P1 轻渲染仍是所有无法安全拆分内容的降级路径。
- [ ] 无新增依赖、用户字符串、消息字段或持久化迁移。
- [ ] 新文件与新增 public 方法具备中文文件头和 JSDoc。
