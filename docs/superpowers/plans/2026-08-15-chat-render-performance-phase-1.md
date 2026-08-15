# P-CHAT-PERF-1 — 流式轻渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 流式回复期间只增量追加安全文本，文本段结束后执行一次富 Markdown 渲染，并把同一帧的贴底请求合并为一次，优先消除 Obsidian 卡死。

**Architecture:** 以纯 TypeScript 状态机决定 `append-light / replace-light / render-rich / none`，`MarkdownView` 只执行状态机动作；运行中助手消息仅末尾文本块标记为 streaming。聊天布局使用可测试的 rAF 合帧器，同一帧最多执行一次贴底写入和一次进度轨度量。

**Tech Stack:** TypeScript strict、Svelte 5 runes、Vitest、jsdom、现有 marked / DOMPurify / Mermaid 管线。

**Spec:** [S-CHAT-PERF](../specs/2026-08-15-chat-render-performance-design.md)

---

## 目标

- 16K 字 / 200 delta 期间不调用完整 Markdown 渲染；文本段完成时只调用一次。
- 流式文本使用同一个 Text 节点追加，保留连续打字、换行和用户选区。
- 工具或思考段开始后，前一文本段立即退出 streaming 并完成富渲染。
- 同一帧的多次 `scrollToBottom()` 只产生一次 rAF 回调。
- 不改消息模型、AgentEvent、持久化、i18n 和最终 Markdown 能力。

## 架构

```text
content / streaming / citeKey
        ↓
StreamingMarkdownState.next()
        ├─ append-light  → Text.appendData()
        ├─ replace-light → replaceChildren(Text)
        ├─ render-rich   → 现有 renderToDom()
        └─ none

ChatView 多事件 scrollToBottom()
        ↓
FrameCoalescer.request()
        ↓ 每帧一次
贴底写入 + nav metrics
```

## 技术栈

- 现有 Svelte 5 组件，不新增运行时依赖。
- 纯状态机和调度器在 Node Vitest 中测试；Text 节点行为使用 jsdom。
- 生产构建继续由 esbuild + esbuild-svelte 完成。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/ui/chat/streaming-markdown-state.ts` | Create | 流式轻渲染状态机与 Text 节点补丁 |
| `tests/ui/chat/streaming-markdown-state.test.ts` | Create | 状态转换、200 delta、DOM 节点身份测试 |
| `src/ui/components/MarkdownView.svelte` | Modify | 执行轻渲染动作；完成时进入现有富渲染 |
| `src/ui/chat/message-stream/group-trace-segments.ts` | Modify | 判定只有末尾 text block 为 streaming |
| `tests/ui/chat/message-stream/group-trace-segments.test.ts` | Modify | 末尾文本块边界回归 |
| `src/ui/chat/message-stream/MessageBubble.svelte` | Modify | 按 block 下标传递 streaming |
| `src/ui/chat/frame-coalescer.ts` | Create | 合并同一帧重复布局请求 |
| `tests/ui/chat/frame-coalescer.test.ts` | Create | request/cancel/再次调度测试 |
| `src/ui/chat/ChatView.svelte` | Modify | 贴底与 nav metrics 共用合帧器 |
| `tests/perf/chat-stream-render-policy.test.ts` | Create | 固定 16K / 200 delta 调用次数基准 |

---

### Task 1: 流式 Markdown 状态机与 Text 节点补丁

**Files:**
- Create: `src/ui/chat/streaming-markdown-state.ts`
- Create: `tests/ui/chat/streaming-markdown-state.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// @vitest-environment jsdom
/**
 * @file tests/ui/chat/streaming-markdown-state.test.ts
 * @description 流式 Markdown 轻渲染状态机与文本节点增量补丁
 * @module tests/ui/chat/streaming-markdown-state
 */
import { describe, expect, it } from 'vitest';
import {
	applyLightTextAction,
	StreamingMarkdownState,
	type MarkdownRenderAction,
} from '../../../src/ui/chat/streaming-markdown-state';

describe('StreamingMarkdownState', () => {
	it('next - 200 个流式增量后结束 - 只产生一次富渲染动作', () => {
		const state = new StreamingMarkdownState();
		let content = '';
		let richCount = 0;
		for (let i = 0; i < 200; i++) {
			content += 'x'.repeat(80);
			const action = state.next({ content, streaming: true, citeKey: '' });
			if (action.kind === 'render-rich') richCount++;
		}
		const final = state.next({ content, streaming: false, citeKey: '' });
		if (final.kind === 'render-rich') richCount++;
		expect(content).toHaveLength(16_000);
		expect(richCount).toBe(1);
		expect(final).toEqual({ kind: 'render-rich', text: content, force: true });
	});

	it('next - 内容保持前缀增长 - 首次替换后只追加新增后缀', () => {
		const state = new StreamingMarkdownState();
		expect(state.next({ content: 'ab', streaming: true, citeKey: '' })).toEqual({
			kind: 'replace-light', text: 'ab',
		});
		expect(state.next({ content: 'abcd', streaming: true, citeKey: '' })).toEqual({
			kind: 'append-light', text: 'cd',
		});
		expect(state.next({ content: 'abcd', streaming: true, citeKey: '' })).toEqual({ kind: 'none' });
	});

	it('next - 内容不再以前值开头 - 回退为轻量整段替换', () => {
		const state = new StreamingMarkdownState();
		state.next({ content: '旧内容', streaming: true, citeKey: '' });
		expect(state.next({ content: '新内容', streaming: true, citeKey: '' })).toEqual({
			kind: 'replace-light', text: '新内容',
		});
	});

	it('next - 静态内容与 citeKey 未变化 - 不重复富渲染', () => {
		const state = new StreamingMarkdownState();
		expect(state.next({ content: '# 标题', streaming: false, citeKey: '1:a.md' }).kind).toBe('render-rich');
		expect(state.next({ content: '# 标题', streaming: false, citeKey: '1:a.md' })).toEqual({ kind: 'none' });
		expect(state.next({ content: '# 标题', streaming: false, citeKey: '1:b.md' }).kind).toBe('render-rich');
	});
});

describe('applyLightTextAction', () => {
	it('append-light - 连续追加 - 复用同一个 Text 节点', () => {
		const host = document.createElement('div');
		let node: Text | null = null;
		node = applyLightTextAction(host, node, { kind: 'replace-light', text: 'ab' });
		const first = node;
		node = applyLightTextAction(host, node, { kind: 'append-light', text: 'cd' });
		expect(node).toBe(first);
		expect(host.textContent).toBe('abcd');
	});

	it('replace-light - 节点已脱离容器 - 安全重建文本节点', () => {
		const host = document.createElement('div');
		const stale = document.createTextNode('stale');
		const action: MarkdownRenderAction = { kind: 'append-light', text: 'fresh' };
		const node = applyLightTextAction(host, stale, action);
		expect(node.parentNode).toBe(host);
		expect(host.textContent).toBe('fresh');
	});
});
```

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `npx vitest run tests/ui/chat/streaming-markdown-state.test.ts`

Expected: FAIL，提示无法解析 `src/ui/chat/streaming-markdown-state.ts`。

- [ ] **Step 3: 写最小实现**

```typescript
/**
 * @file src/ui/chat/streaming-markdown-state.ts
 * @description 决定流式 Markdown 使用轻量追加、轻量替换或最终富渲染
 * @module ui/chat/streaming-markdown-state
 */

export type MarkdownRenderAction =
	| { kind: 'none' }
	| { kind: 'append-light'; text: string }
	| { kind: 'replace-light'; text: string }
	| { kind: 'render-rich'; text: string; force: boolean };

export interface MarkdownRenderInput {
	content: string;
	streaming: boolean;
	citeKey: string;
}

/**
 * 保存已经交给 DOM 的文本和模式，确保流式阶段只返回新增后缀。
 *
 * 设计要点:
 * - 只记录渲染决策所需的最小状态，不持有 DOM 引用。
 * - 非前缀改写降级为整段轻量替换，结束时只触发一次富渲染。
 *
 * @example
 *   const state = new StreamingMarkdownState();
 *   state.next({ content: '回答', streaming: true, citeKey: '' });
 */
export class StreamingMarkdownState {
	private appliedContent = '';
	private appliedCiteKey = '';
	private mode: 'empty' | 'light' | 'rich' = 'empty';

	/**
	 * 根据下一份完整内容返回唯一需要执行的 DOM 动作。
	 *
	 * @param input - 最新完整文本、流式状态与引用键
	 * @returns 本帧应执行的渲染动作
	 * @example
	 *   state.next({ content: '回答继续', streaming: true, citeKey: '' });
	 */
	next(input: MarkdownRenderInput): MarkdownRenderAction {
		const { content, streaming, citeKey } = input;
		if (streaming) {
			if (this.mode === 'light' && content === this.appliedContent) return { kind: 'none' };
			const action: MarkdownRenderAction =
				this.mode === 'light' && content.startsWith(this.appliedContent)
					? { kind: 'append-light', text: content.slice(this.appliedContent.length) }
					: { kind: 'replace-light', text: content };
			this.appliedContent = content;
			this.appliedCiteKey = citeKey;
			this.mode = 'light';
			return action;
		}

		if (
			this.mode === 'rich' &&
			content === this.appliedContent &&
			citeKey === this.appliedCiteKey
		) return { kind: 'none' };

		this.appliedContent = content;
		this.appliedCiteKey = citeKey;
		this.mode = 'rich';
		return { kind: 'render-rich', text: content, force: true };
	}

	/**
	 * 清空组件复用前的渲染状态。
	 *
	 * @returns 无返回值
	 * @example
	 *   state.reset();
	 */
	reset(): void {
		this.appliedContent = '';
		this.appliedCiteKey = '';
		this.mode = 'empty';
	}
}

/**
 * 把轻量动作应用到单一 Text 节点；append 路径不替换已有节点。
 *
 * @param host - Markdown 根容器
 * @param current - 当前活动 Text 节点
 * @param action - 轻量追加或替换动作
 * @returns 仍应持有的 Text 节点
 * @example
 *   applyLightTextAction(host, null, { kind: 'replace-light', text: '回答' });
 */
export function applyLightTextAction(
	host: HTMLElement,
	current: Text | null,
	action: Extract<MarkdownRenderAction, { kind: 'append-light' | 'replace-light' }>,
): Text {
	if (action.kind === 'append-light' && current?.parentNode === host) {
		current.appendData(action.text);
		return current;
	}
	const node = host.ownerDocument.createTextNode(action.text);
	host.replaceChildren(node);
	return node;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/chat/streaming-markdown-state.test.ts`

Expected: PASS，6 tests。

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/streaming-markdown-state.ts tests/ui/chat/streaming-markdown-state.test.ts
git commit -m "perf(chat): 新增流式轻渲染状态机"
```

---

### Task 2: MarkdownView 执行轻量动作并只在结束时富渲染

**Files:**
- Modify: `src/ui/components/MarkdownView.svelte:3-180`
- Test: `tests/ui/chat/streaming-markdown-state.test.ts`

- [ ] **Step 1: 扩展失败测试，锁定空增量与 reset**

在 `tests/ui/chat/streaming-markdown-state.test.ts` 的 `StreamingMarkdownState` describe 中加入：

```typescript
	it('next - 空文本流式帧 - 不创建无意义节点', () => {
		const state = new StreamingMarkdownState();
		expect(state.next({ content: '', streaming: true, citeKey: '' })).toEqual({ kind: 'none' });
	});

	it('reset - 组件上下文切换 - 下一份文本从轻量替换开始', () => {
		const state = new StreamingMarkdownState();
		state.next({ content: '旧会话', streaming: true, citeKey: '' });
		state.reset();
		expect(state.next({ content: '新会话', streaming: true, citeKey: '' })).toEqual({
			kind: 'replace-light', text: '新会话',
		});
	});
```

- [ ] **Step 2: 运行测试确认空文本用例失败**

Run: `npx vitest run tests/ui/chat/streaming-markdown-state.test.ts`

Expected: FAIL，空文本当前返回 `replace-light`。

- [ ] **Step 3: 修正状态机空文本分支**

在 `StreamingMarkdownState.next()` 的 streaming 分支开头加入：

```typescript
			if (content === '' && this.appliedContent === '') {
				this.mode = 'light';
				this.appliedCiteKey = citeKey;
				return { kind: 'none' };
			}
```

- [ ] **Step 4: 把 MarkdownView 的两个渲染 effect 合并为动作执行器**

在 `MarkdownView.svelte` 导入状态机：

```typescript
	import {
		applyLightTextAction,
		StreamingMarkdownState,
		type MarkdownRenderAction,
	} from '../chat/streaming-markdown-state';
```

在 DOM 状态变量区加入：

```typescript
	const renderState = new StreamingMarkdownState();
	let lightTextNode: Text | null = null;
```

在 `renderToDom()` 通过选区保护并写入 `lastRenderedText / lastCiteKey` 后、调用 `renderMarkdownToHtml(text)` 前插入：

```typescript
		lightTextNode = null;
		containerEl.classList.remove('is-streaming-light');
		const html = renderMarkdownToHtml(text);
		containerEl.innerHTML = html;
```

新增动作执行函数：

```typescript
	function applyRenderAction(action: MarkdownRenderAction): void {
		if (!containerEl || action.kind === 'none') return;
		if (action.kind === 'render-rich') {
			renderToDom(action.text, action.force);
			return;
		}
		// 关键路径:流式阶段只写 Text 节点，不运行 marked / highlight / Mermaid / cite enhance。
		cleanupCites?.();
		cleanupCites = null;
		cleanupCiteTips?.();
		cleanupCiteTips = null;
		cleanupMdBlocks?.();
		cleanupMdBlocks = null;
		containerEl.classList.add('is-streaming-light');
		lightTextNode = applyLightTextAction(containerEl, lightTextNode, action);
	}
```

用一个 effect 替换原有两个 content / streaming effect：

```typescript
	$effect(() => {
		const next = { content, streaming, citeKey: citeKey() };
		cancelAnimationFrame(rafId);
		rafId = requestAnimationFrame(() => {
			applyRenderAction(renderState.next(next));
		});
	});
```

在 `.ratel-md` 样式后加入：

```css
	.ratel-md.is-streaming-light {
		white-space: pre-wrap;
	}
```

在 `onDestroy()` 末尾加入：

```typescript
		renderState.reset();
		lightTextNode = null;
```

- [ ] **Step 5: 跑状态机测试与 Svelte 类型检查**

Run: `npx vitest run tests/ui/chat/streaming-markdown-state.test.ts && npm run svelte-check`

Expected: 8 tests PASS；`svelte-check` 0 errors。

- [ ] **Step 6: 提交**

```bash
git add src/ui/components/MarkdownView.svelte src/ui/chat/streaming-markdown-state.ts tests/ui/chat/streaming-markdown-state.test.ts
git commit -m "perf(chat): 流式阶段改为文本节点增量追加"
```

---

### Task 3: 只有末尾文本块保持 streaming

**Files:**
- Modify: `src/ui/chat/message-stream/group-trace-segments.ts`
- Modify: `tests/ui/chat/message-stream/group-trace-segments.test.ts`
- Modify: `src/ui/chat/message-stream/MessageBubble.svelte:53-118`

- [ ] **Step 1: 写失败测试**

修改测试导入并追加用例：

```typescript
import {
	groupTraceSegments,
	isStreamingTextBlock,
} from '../../../../src/ui/chat/message-stream/group-trace-segments';

describe('isStreamingTextBlock', () => {
	it('末尾块判定 - 文本后没有工具 - 只有最后一个 text 为 true', () => {
		const blocks = groupTraceSegments([
			{ type: 'text', text: '第一段' },
			{ type: 'tool', toolCall: { name: 'a', displayName: 'a', args: {}, status: 'done', startAt: 1 } },
			{ type: 'text', text: '第二段' },
		]);
		expect(isStreamingTextBlock(blocks, 0, true)).toBe(false);
		expect(isStreamingTextBlock(blocks, 2, true)).toBe(true);
	});

	it('末尾块判定 - 最后是 trace 或回合已结束 - 所有 text 为 false', () => {
		const blocks = groupTraceSegments([
			{ type: 'text', text: '完成段' },
			{ type: 'think', text: '思考' },
		]);
		expect(isStreamingTextBlock(blocks, 0, true)).toBe(false);
		expect(isStreamingTextBlock(blocks, 0, false)).toBe(false);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/chat/message-stream/group-trace-segments.test.ts`

Expected: FAIL，`isStreamingTextBlock` 未导出。

- [ ] **Step 3: 写最小判定函数**

在 `group-trace-segments.ts` 追加：

```typescript
/**
 * 仅运行中助手消息的最后一个渲染块为 text 时，把它标记为活动流式块。
 *
 * @param blocks - 当前消息渲染块
 * @param blockIndex - 待判定块下标
 * @param assistantStreaming - 当前消息是否为运行中的最后一条助手消息
 * @returns 是否应使用轻量流式渲染
 * @example
 *   isStreamingTextBlock(blocks, 0, true);
 */
export function isStreamingTextBlock(
	blocks: SegmentBlock[],
	blockIndex: number,
	assistantStreaming: boolean,
): boolean {
	if (!assistantStreaming || blockIndex !== blocks.length - 1) return false;
	return blocks[blockIndex]?.kind === 'text';
}
```

- [ ] **Step 4: 修改 MessageBubble 按 block 下标传 streaming**

导入函数：

```typescript
	import { groupTraceSegments, isStreamingTextBlock } from './group-trace-segments';
```

把模板循环和 TextSegment prop 改为：

```svelte
	{#each blocks as block, blockIndex}
		{#if block.kind === 'text'}
			<TextSegment
				text={block.seg.text}
				isUser={msg.role === 'user'}
				streaming={isStreamingTextBlock(blocks, blockIndex, isAssistantStreaming)}
				searchResults={msg.role === 'assistant' ? citeSearchResults : undefined}
				{onOpenPath}
				{motionOn}
				messageId={msg.id}
			/>
		{:else if block.kind === 'trace'}
			<div class="ratel-trace">
				{#each block.items as item}
					{#if item.kind === 'tool'}
						<ToolSegment toolCall={item.seg.toolCall} />
					{:else}
						<ThinkSegment text={item.seg.text} streaming={isAssistantStreaming} />
					{/if}
				{/each}
			</div>
		{/if}
	{/each}
```

这样工具段到来时，前一 TextSegment 的 streaming 会立即变为 false 并触发一次富渲染。

- [ ] **Step 5: 运行目标测试和 Svelte 检查**

Run: `npx vitest run tests/ui/chat/message-stream/group-trace-segments.test.ts tests/ui/chat/streaming-markdown-state.test.ts && npm run svelte-check`

Expected: 目标测试 PASS；`svelte-check` 0 errors。

- [ ] **Step 6: 提交**

```bash
git add src/ui/chat/message-stream/group-trace-segments.ts tests/ui/chat/message-stream/group-trace-segments.test.ts src/ui/chat/message-stream/MessageBubble.svelte
git commit -m "perf(chat): 仅流式渲染末尾文本块"
```

---

### Task 4: 合并同一帧的贴底和进度轨度量

**Files:**
- Create: `src/ui/chat/frame-coalescer.ts`
- Create: `tests/ui/chat/frame-coalescer.test.ts`
- Modify: `src/ui/chat/ChatView.svelte:177-280`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/chat/frame-coalescer.test.ts
 * @description requestAnimationFrame 合帧器的请求、取消与重复调度
 * @module tests/ui/chat/frame-coalescer
 */
import { describe, expect, it, vi } from 'vitest';
import { FrameCoalescer } from '../../../src/ui/chat/frame-coalescer';

describe('FrameCoalescer', () => {
	it('request - 同一帧请求三次 - 任务只执行一次', () => {
		let callback: FrameRequestCallback | null = null;
		const request = vi.fn((cb: FrameRequestCallback) => {
			callback = cb;
			return 7;
		});
		const task = vi.fn();
		const scheduler = new FrameCoalescer(task, request, vi.fn());
		scheduler.request();
		scheduler.request();
		scheduler.request();
		expect(request).toHaveBeenCalledTimes(1);
		(callback as FrameRequestCallback)(0);
		expect(task).toHaveBeenCalledTimes(1);
	});

	it('cancel - 已排队 - 取消且不执行任务', () => {
		const cancel = vi.fn();
		const scheduler = new FrameCoalescer(vi.fn(), () => 9, cancel);
		scheduler.request();
		scheduler.cancel();
		expect(cancel).toHaveBeenCalledWith(9);
	});

	it('request - 上一帧执行后再次请求 - 可排下一帧', () => {
		const callbacks: FrameRequestCallback[] = [];
		const task = vi.fn();
		const scheduler = new FrameCoalescer(task, (cb) => {
			callbacks.push(cb);
			return callbacks.length;
		}, vi.fn());
		scheduler.request();
		callbacks[0]!(0);
		scheduler.request();
		callbacks[1]!(16);
		expect(task).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/chat/frame-coalescer.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 写合帧器实现**

```typescript
/**
 * @file src/ui/chat/frame-coalescer.ts
 * @description 把同一动画帧内的重复布局请求合并为一次回调
 * @module ui/chat/frame-coalescer
 */

/**
 * 每帧最多执行一次 task，并支持组件销毁时取消。
 *
 * 设计要点:
 * - 同一帧内重复请求只保留一次回调。
 * - 组件销毁时显式取消尚未执行的帧任务。
 *
 * @example
 *   const coalescer = new FrameCoalescer(() => updateScroll());
 *   coalescer.request();
 */
export class FrameCoalescer {
	private frameId: number | null = null;

	constructor(
		private readonly task: () => void,
		private readonly requestFrame: (cb: FrameRequestCallback) => number = requestAnimationFrame,
		private readonly cancelFrame: (id: number) => void = cancelAnimationFrame,
	) {}

	/**
	 * 请求下一帧；已有请求时不重复排队。
	 *
	 * @returns 无返回值
	 * @example
	 *   coalescer.request();
	 */
	request(): void {
		if (this.frameId !== null) return;
		this.frameId = this.requestFrame(() => {
			this.frameId = null;
			this.task();
		});
	}

	/**
	 * 取消尚未执行的帧。
	 *
	 * @returns 无返回值
	 * @example
	 *   coalescer.cancel();
	 */
	cancel(): void {
		if (this.frameId === null) return;
		this.cancelFrame(this.frameId);
		this.frameId = null;
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/chat/frame-coalescer.test.ts`

Expected: 3 tests PASS。

- [ ] **Step 5: ChatView 改用单一布局帧**

在 `ChatView.svelte` 导入：

```typescript
	import { FrameCoalescer } from './frame-coalescer';
```

在 `messagesEl` 和 sticky 状态后加入：

```typescript
	let wantsBottomScroll = false;
	const layoutFrame = new FrameCoalescer(() => {
		const el = messagesEl;
		if (!el) return;
		if (wantsBottomScroll && isUserNearBottom) snapScrollToBottom(el);
		wantsBottomScroll = false;
		updateNavMetrics(el);
	});
```

把 `scrollToBottom()` 改为：

```typescript
	const scrollToBottom = () => {
		if (!isUserNearBottom) return;
		wantsBottomScroll = true;
		layoutFrame.request();
	};
```

把 `forceScrollToBottom()` 改为：

```typescript
	function forceScrollToBottom() {
		isUserNearBottom = true;
		wantsBottomScroll = true;
		layoutFrame.request();
	}
```

把“消息变高 / 开关变更” effect 内的 rAF 改为：

```typescript
	$effect(() => {
		void messages;
		void navEnabled;
		if (messagesEl) layoutFrame.request();
	});
```

在现有 `onDestroy()` 清理中加入：

```typescript
		layoutFrame.cancel();
```

- [ ] **Step 6: 运行目标测试、类型检查和构建**

Run: `npx vitest run tests/ui/chat/frame-coalescer.test.ts tests/ui/chat/sticky-scroll.test.ts tests/ui/chat/nav/chat-nav-rail.test.ts && npm run typecheck && npm run build`

Expected: 目标测试 PASS；typecheck 和 build exit 0。

- [ ] **Step 7: 提交**

```bash
git add src/ui/chat/frame-coalescer.ts tests/ui/chat/frame-coalescer.test.ts src/ui/chat/ChatView.svelte
git commit -m "perf(chat): 合并流式贴底布局请求"
```

---

### Task 5: 固化 16K / 200 delta 性能合同并完成阶段验收

**Files:**
- Create: `tests/perf/chat-stream-render-policy.test.ts`
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: 写性能合同测试**

```typescript
// @vitest-environment jsdom
/**
 * @file tests/perf/chat-stream-render-policy.test.ts
 * @description 16K 字 / 200 delta 下轻渲染调用次数与 Text 节点稳定性
 * @module tests/perf/chat-stream-render-policy
 */
import { describe, expect, it } from 'vitest';
import {
	applyLightTextAction,
	StreamingMarkdownState,
} from '../../src/ui/chat/streaming-markdown-state';
import { renderMarkdownToHtml } from '../../src/utils/markdown-renderer';

describe('聊天流式渲染性能合同', () => {
	it('16K / 200 delta - 完整 Markdown 只在结束时渲染一次', () => {
		const host = document.createElement('div');
		const state = new StreamingMarkdownState();
		let node: Text | null = null;
		let richCalls = 0;
		let content = '';

		for (let i = 0; i < 200; i++) {
			content += `${String(i).padStart(3, '0')}:${'x'.repeat(76)}`;
			const action = state.next({ content, streaming: true, citeKey: '' });
			if (action.kind === 'append-light' || action.kind === 'replace-light') {
				node = applyLightTextAction(host, node, action);
			}
		}

		const beforeFinalNode = node;
		const final = state.next({ content, streaming: false, citeKey: '' });
		if (final.kind === 'render-rich') {
			richCalls++;
			host.innerHTML = renderMarkdownToHtml(final.text);
		}

		expect(content).toHaveLength(16_000);
		expect(beforeFinalNode).not.toBeNull();
		expect(richCalls).toBe(1);
		expect(host.textContent?.length).toBeGreaterThan(15_000);
	});
});
```

- [ ] **Step 2: 运行专项与完整测试**

Run: `npx vitest run tests/perf/chat-stream-render-policy.test.ts tests/ui/chat/streaming-markdown-state.test.ts tests/ui/chat/frame-coalescer.test.ts tests/ui/chat/message-stream/group-trace-segments.test.ts`

Expected: 所有专项测试 PASS。

Run: `npm test`

Expected: 全量测试 0 failures。

- [ ] **Step 3: 运行静态检查与生产构建**

Run: `npm run lint && npm run typecheck && npm run build`

Expected: 三条命令均 exit 0。

- [ ] **Step 4: 只链接 Sandbox 并人工复现**

Run: `npm run link:vault -- "<sandbox>"`

Expected: Sandbox 的 `ratel-vault/main.js` 指向当前 worktree `dist/main.js`；不得链接日常主库。

在 Sandbox 执行 **Reload app without saving**，生成至少 16K 字且包含标题、列表、代码块、引用与 Mermaid 的回复，确认：

1. 流式期间文字持续增长，Markdown 格式在文本段结束时成形。
2. 流式期间可滚动、点击停止并切换笔记，Obsidian 不冻结。
3. 工具调用出现时，工具前文本立即完成 Markdown 渲染。
4. 用户向上滚动后不被拉回底部；回到底部后恢复跟随。
5. 结束后引用、复制、Mermaid 和表格正常。

- [ ] **Step 5: 登记阶段完成信息并提交**

在 `docs/superpowers/STATUS.md` 的 `P-CHAT-PERF-1` 行把状态更新为 `✅ Completed`，记录实际分支和测试总数；不要提前修改 P2/P3 状态。

```bash
git add tests/perf/chat-stream-render-policy.test.ts docs/superpowers/STATUS.md
git commit -m "test(chat): 固化流式轻渲染性能合同"
```

---

## 自审

- [ ] Spec §5.2：流式阶段没有 marked / highlight / Mermaid / cite enhance 调用。
- [ ] Spec §5.2：只有末尾文本段 streaming，工具边界会完成前段。
- [ ] Spec §5.6：同一帧最多一次贴底写入和 nav metrics。
- [ ] Spec §6：16K / 200 delta 调用次数有确定性测试。
- [ ] 所有新增 `.ts` 文件有中文文件头、导出类/函数 JSDoc；测试名符合“行为 - 条件 - 期望”。
- [ ] 没有新增用户可见字符串，因此不需要 i18n key。
- [ ] 未修改消息数据模型、持久化、Worker 或构建产物。
- [ ] Sandbox 链接目标已核对，不触碰日常主库。
