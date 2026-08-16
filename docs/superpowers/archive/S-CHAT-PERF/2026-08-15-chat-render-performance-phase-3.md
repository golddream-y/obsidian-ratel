# P-CHAT-PERF-3 — 聊天块级虚拟滚动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把整个聊天区投影为变量高度 RenderUnit，只挂载视口附近 1–2 屏内容，同时保持原生滚动比例、阅读锚点、sticky-to-bottom 和右侧进度轨跳转。

**Architecture:** `RenderUnitProjector` 把消息、Markdown 稳定块、活动尾部、工具/思考段和 compact 分隔投影为稳定 id 单元；`virtual-window.ts` 以实测或估算高度生成前缀布局和可见窗口。`MessageList` 使用顶部/底部 spacer 保持完整滚动高度，通过 ResizeObserver 更新缓存，并在高度变化时补偿用户阅读锚点。

**Tech Stack:** TypeScript strict、Svelte 5、ResizeObserver、原生滚动容器、Vitest、jsdom；不新增虚拟列表依赖。

**Spec:** [S-CHAT-PERF](../specs/2026-08-15-chat-render-performance-design.md)

**Depends on:** `P-CHAT-PERF-1`、`P-CHAT-PERF-2` 已完成并通过 Sandbox 验收。

---

## 目标

- 100 条混合消息只挂载视口及上下 overscan 范围内的 RenderUnit。
- 单条超长助手消息按 Markdown block 拆分，不能作为一个巨型消息 DOM 常驻。
- 图片、Mermaid、工具展开或字体变化后，向上阅读位置不跳。
- 活动流式尾部数据始终更新；sticky 用户保持挂载和跟随，离底用户允许卸载尾部且不被拉回。
- 右侧进度轨比例基于完整虚拟高度，并能跳到尚未挂载的消息。
- 焦点或选择涉及的单元临时保留，交互结束后恢复回收。

## 架构

```text
Message[] + isRunning
        ↓
RenderUnitProjector（稳定 id、逻辑消息首尾、活动 tail）
        ↓
buildVirtualLayout（measured height || estimate）
        ↓
computeVirtualRange（viewport + overscan + retained ids）
        ↓
top spacer + visible RenderUnit + bottom spacer
        ↓
ResizeObserver → height cache → anchor compensation
```

## 技术栈

- 纯 TypeScript 投影与虚拟窗口数学，Node Vitest 可验证。
- Svelte keyed each 只负责挂载窗口内单元。
- 原生 `scrollTop / clientHeight / scrollHeight` 继续作为 sticky 与进度轨事实源。
- 复用 P2 的 `StableMarkdownProjection` 和 `splitStableMarkdownBlocks`。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/ui/chat/message-stream/render-unit-projector.ts` | Create | Message[] → RenderUnit[]，管理活动文本投影缓存 |
| `tests/ui/chat/message-stream/render-unit-projector.test.ts` | Create | 静态长消息、活动尾部、逻辑首尾、降级测试 |
| `src/ui/chat/message-stream/virtual-window.ts` | Create | 高度布局、范围、锚点和测量补偿 |
| `tests/ui/chat/message-stream/virtual-window.test.ts` | Create | 变量高度、overscan、retained、跳转测试 |
| `src/ui/chat/message-stream/MessageBubble.svelte` | Modify | 支持单元 segments、逻辑首尾和 footer 开关 |
| `src/ui/chat/message-stream/TextSegment.svelte` | Modify | 回到单块 MarkdownView，由 projector 提供 stable/tail |
| `src/ui/components/StreamingMarkdownView.svelte` | Delete | 投影职责上移，避免嵌套虚拟化 |
| `src/ui/chat/message-stream/MessageList.svelte` | Modify | spacer、ResizeObserver、窗口挂载和 retained 单元 |
| `src/ui/chat/ChatView.svelte` | Modify | 未挂载消息跳转请求与进度轨协作 |
| `tests/perf/chat-virtual-window-policy.test.ts` | Create | 100 消息节点上界与 16K 单消息拆块合同 |

---

### Task 1: RenderUnit 数据模型与增量投影器

**Files:**
- Create: `src/ui/chat/message-stream/render-unit-projector.ts`
- Create: `tests/ui/chat/message-stream/render-unit-projector.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/chat/message-stream/render-unit-projector.test.ts
 * @description 消息、Markdown 块、工具段和活动尾部的统一 RenderUnit 投影
 * @module tests/ui/chat/message-stream/render-unit-projector
 */
import { describe, expect, it, vi } from 'vitest';
import {
	RenderUnitProjector,
	type MessageRenderUnit,
} from '../../../../src/ui/chat/message-stream/render-unit-projector';
import type { Message } from '../../../../src/ui/chat/message-stream/types';

function assistant(id: string, text: string): Message {
	return { id, role: 'assistant', segments: [{ type: 'text', text }] };
}

describe('RenderUnitProjector', () => {
	it('project - 静态长 Markdown - 按顶层 block 拆为多个稳定单元', () => {
		const projector = new RenderUnitProjector();
		const units = projector.project([assistant('a1', '# 标题\n\n正文\n\n- A\n- B')], false);
		const messageUnits = units.filter((u): u is MessageRenderUnit => u.kind === 'message');
		expect(messageUnits.length).toBeGreaterThan(1);
		expect(messageUnits[0]!.position).toBe('first');
		expect(messageUnits[messageUnits.length - 1]!.position).toBe('last');
		expect(messageUnits[0]!.anchor).toBe(true);
		expect(messageUnits.filter((u) => u.showFooter)).toHaveLength(1);
	});

	it('project - 活动末尾文本 - 稳定块与 tail 使用稳定 id', () => {
		const projector = new RenderUnitProjector();
		let msg = assistant('a1', '第一段\n\n第二');
		const first = projector.project([msg], true).filter((u): u is MessageRenderUnit => u.kind === 'message');
		const stableId = first.find((u) => !u.streaming)!.id;
		msg = assistant('a1', '第一段\n\n第二段继续');
		const second = projector.project([msg], true).filter((u): u is MessageRenderUnit => u.kind === 'message');
		expect(second.find((u) => !u.streaming)!.id).toBe(stableId);
		expect(second.filter((u) => u.streaming)).toHaveLength(1);
	});

	it('project - 文本后出现工具 - 前一文本立即变为静态单元', () => {
		const projector = new RenderUnitProjector();
		const msg: Message = {
			id: 'a1', role: 'assistant', segments: [
				{ type: 'text', text: '完成文本' },
				{ type: 'tool', toolCall: { name: 'x', displayName: 'x', args: {}, status: 'calling', startAt: 1 } },
			],
		};
		const units = projector.project([msg], true).filter((u): u is MessageRenderUnit => u.kind === 'message');
		expect(units.some((u) => u.streaming)).toBe(false);
		expect(units.some((u) => u.segments[0]?.type === 'tool')).toBe(true);
	});

	it('project - compact 与用户消息 - 保持独立逻辑单元', () => {
		const projector = new RenderUnitProjector();
		const messages: Message[] = [
			{ id: 'u1', role: 'user', segments: [{ type: 'text', text: '问题' }] },
			{ id: 'c1', role: 'compact', compactPhase: 'done', segments: [] },
		];
		expect(projector.project(messages, false).map((u) => u.kind)).toEqual(['message', 'compact']);
	});

	it('project - 空 segments 但有错误 - 仍保留一个 footer 单元', () => {
		const projector = new RenderUnitProjector();
		const msg: Message = {
			id: 'a1', role: 'assistant', segments: [],
			chatError: { type: 'runtime', message: '失败' },
		};
		const units = projector.project([msg], false);
		expect(units).toHaveLength(1);
		expect((units[0] as MessageRenderUnit).showFooter).toBe(true);
	});

	it('project - 引用定义跨块依赖 - 静态文本保持单一单元', () => {
		const projector = new RenderUnitProjector();
		const text = '参考 [文档][ref]\n\n[ref]: https://example.com';
		const units = projector.project([assistant('a1', text)], false);
		expect(units).toHaveLength(1);
	});

	it('project - 历史静态文本未变化 - 后续 delta 投影不重复 lexer', () => {
		const split = vi.fn((text: string) => ({
			stableBlocks: [text], tail: '', hasCrossBlockDependency: false,
		}));
		const projector = new RenderUnitProjector(split);
		const history = assistant('history', '历史正文');
		projector.project([history, assistant('live', 'a')], true);
		projector.project([history, assistant('live', 'ab')], true);
		expect(split.mock.calls.filter(([text]) => text === '历史正文')).toHaveLength(1);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/chat/message-stream/render-unit-projector.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 RenderUnitProjector**

```typescript
/**
 * @file src/ui/chat/message-stream/render-unit-projector.ts
 * @description 把完整消息流投影为可虚拟化的稳定渲染单元
 * @module ui/chat/message-stream/render-unit-projector
 * @depends ./types, ../stable-markdown-projection, ../../../utils/markdown-renderer
 */
import { splitStableMarkdownBlocks } from '../../../utils/markdown-renderer';
import {
	StableMarkdownProjection,
	type MarkdownSplitter,
} from '../stable-markdown-projection';
import type { Message, MessageSegment } from './types';

export type MessageUnitPosition = 'only' | 'first' | 'middle' | 'last';

export interface MessageRenderUnit {
	kind: 'message';
	id: string;
	messageId: string;
	messageIndex: number;
	msg: Message;
	segments: MessageSegment[];
	position: MessageUnitPosition;
	anchor: boolean;
	showAttachments: boolean;
	showFooter: boolean;
	streaming: boolean;
}

export interface CompactRenderUnit {
	kind: 'compact';
	id: string;
	messageId: string;
	messageIndex: number;
	phase: Message['compactPhase'];
}

export type RenderUnit = MessageRenderUnit | CompactRenderUnit;

interface MessageUnitDraft {
	id: string;
	segments: MessageSegment[];
	streaming: boolean;
}

interface StaticTextCache {
	text: string;
	blocks: Array<{ id: string; source: string }>;
}

/**
 * 维护活动 text segment 的稳定块缓存，并为静态消息执行一次块投影。
 *
 * 设计要点:
 * - 活动文本复用增量投影，历史静态文本按内容缓存拆分结果。
 * - 投影异常时回退为一条消息一个单元，优先保证内容可见。
 *
 * @example
 *   const projector = new RenderUnitProjector();
 *   const units = projector.project(messages, true);
 */
export class RenderUnitProjector {
	private active = new Map<string, StableMarkdownProjection>();
	private staticText = new Map<string, StaticTextCache>();

	constructor(private readonly splitStatic: MarkdownSplitter = splitStableMarkdownBlocks) {}

	/**
	 * 投影完整消息数组；失败时回退为一条消息一个单元。
	 *
	 * @param messages - UI 消息事实源
	 * @param isRunning - Agent Loop 是否运行中
	 * @returns 稳定 id 的渲染单元
	 * @example
	 *   projector.project(messages, false);
	 */
	project(messages: Message[], isRunning: boolean): RenderUnit[] {
		try {
			return this.projectUnsafe(messages, isRunning);
		} catch {
			this.active.clear();
			this.staticText.clear();
			return messages.map((msg, messageIndex): RenderUnit => msg.role === 'compact'
				? { kind: 'compact', id: `compact:${msg.id}`, messageId: msg.id, messageIndex, phase: msg.compactPhase }
				: {
					kind: 'message', id: `message:${msg.id}`, messageId: msg.id, messageIndex,
					msg, segments: msg.segments, position: 'only', anchor: true,
					showAttachments: true, showFooter: true, streaming: false,
				});
		}
	}

	private projectUnsafe(messages: Message[], isRunning: boolean): RenderUnit[] {
		const units: RenderUnit[] = [];
		const liveKeys = new Set<string>();
		const seenTextKeys = new Set<string>();
		for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
			const msg = messages[messageIndex]!;
			if (msg.role === 'compact') {
				units.push({ kind: 'compact', id: `compact:${msg.id}`, messageId: msg.id, messageIndex, phase: msg.compactPhase });
				continue;
			}
			if (msg.role === 'user') {
				units.push(this.toUnit(msg, messageIndex, {
					id: `message:${msg.id}`, segments: msg.segments, streaming: false,
				}, 0, 1));
				continue;
			}

			const drafts: MessageUnitDraft[] = [];
			let trace: MessageSegment[] = [];
			const flushTrace = () => {
				if (trace.length === 0) return;
				const start = drafts.length;
				drafts.push({ id: `${msg.id}:trace:${start}`, segments: trace, streaming: false });
				trace = [];
			};

			for (let segmentIndex = 0; segmentIndex < msg.segments.length; segmentIndex++) {
				const seg = msg.segments[segmentIndex]!;
				if (seg.type === 'tool' || seg.type === 'think') {
					trace.push(seg);
					continue;
				}
				flushTrace();
				if (seg.type !== 'text') {
					drafts.push({ id: `${msg.id}:seg:${segmentIndex}`, segments: [seg], streaming: false });
					continue;
				}

				const isActive = isRunning &&
					messageIndex === messages.length - 1 &&
					segmentIndex === msg.segments.length - 1;
				const key = `${msg.id}:${segmentIndex}`;
				seenTextKeys.add(key);
				if (isActive) {
					liveKeys.add(key);
					this.staticText.delete(key);
					const projection = this.active.get(key) ?? new StableMarkdownProjection(this.splitStatic);
					this.active.set(key, projection);
					const snapshot = projection.update(seg.text);
					for (const block of snapshot.blocks) {
						drafts.push({ id: `${key}:${block.id}`, segments: [{ type: 'text', text: block.source }], streaming: false });
					}
					if (snapshot.tail) {
						drafts.push({ id: `${key}:tail`, segments: [{ type: 'text', text: snapshot.tail }], streaming: true });
					}
					continue;
				}

				const cachedActive = this.active.get(key);
				let cachedStatic = this.staticText.get(key);
				if (!cachedStatic || cachedStatic.text !== seg.text) {
					const blocks = cachedActive
						? cachedActive.finish(seg.text).blocks.map((block) => ({ id: `${key}:${block.id}`, source: block.source }))
						: this.splitStatic(seg.text, true).stableBlocks.map((source, index) => ({ id: `${key}:static:${index}`, source }));
					cachedStatic = { text: seg.text, blocks };
					this.staticText.set(key, cachedStatic);
				}
				this.active.delete(key);
				for (const block of cachedStatic.blocks) {
					drafts.push({ id: block.id, segments: [{ type: 'text', text: block.source }], streaming: false });
				}
			}
			flushTrace();
			if (drafts.length === 0) {
				drafts.push({ id: `${msg.id}:empty`, segments: [], streaming: false });
			}
			for (let i = 0; i < drafts.length; i++) units.push(this.toUnit(msg, messageIndex, drafts[i]!, i, drafts.length));
		}
		for (const key of this.active.keys()) if (!liveKeys.has(key)) this.active.delete(key);
		for (const key of this.staticText.keys()) if (!seenTextKeys.has(key)) this.staticText.delete(key);
		return units;
	}

	private toUnit(
		msg: Message,
		messageIndex: number,
		draft: MessageUnitDraft,
		index: number,
		total: number,
	): MessageRenderUnit {
		const position: MessageUnitPosition = total === 1 ? 'only' : index === 0 ? 'first' : index === total - 1 ? 'last' : 'middle';
		return {
			kind: 'message', id: draft.id, messageId: msg.id, messageIndex, msg,
			segments: draft.segments, position, anchor: index === 0,
			showAttachments: index === 0, showFooter: index === total - 1,
			streaming: draft.streaming,
		};
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/chat/message-stream/render-unit-projector.test.ts tests/ui/chat/stable-markdown-projection.test.ts tests/utils/markdown-renderer.test.ts`

Expected: 所有测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/message-stream/render-unit-projector.ts tests/ui/chat/message-stream/render-unit-projector.test.ts
git commit -m "feat(chat): 投影统一虚拟渲染单元"
```

---

### Task 2: 变量高度布局、窗口范围与阅读锚点

**Files:**
- Create: `src/ui/chat/message-stream/virtual-window.ts`
- Create: `tests/ui/chat/message-stream/virtual-window.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/ui/chat/message-stream/virtual-window.test.ts
 * @description 变量高度虚拟窗口、overscan、保留单元和高度补偿
 * @module tests/ui/chat/message-stream/virtual-window
 */
import { describe, expect, it } from 'vitest';
import {
	buildVirtualLayout,
	computeVirtualRange,
	compensateMeasuredHeight,
	offsetForUnit,
} from '../../../../src/ui/chat/message-stream/virtual-window';

const items = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}` }));

describe('virtual window', () => {
	it('buildVirtualLayout - 混合实测与估算 - 生成连续前缀位置', () => {
		const layout = buildVirtualLayout(items, new Map([['u0', 120]]), () => 80);
		expect(layout.items[0]).toMatchObject({ top: 0, height: 120, bottom: 120 });
		expect(layout.items[1]).toMatchObject({ top: 120, height: 80, bottom: 200 });
		expect(layout.totalHeight).toBe(8040);
	});

	it('computeVirtualRange - 500px 视口与一屏 overscan - 只返回附近单元', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		const range = computeVirtualRange(layout, 4000, 500, 500, new Set());
		expect(range.start).toBeLessThanOrEqual(40);
		expect(range.end - range.start).toBeLessThanOrEqual(16);
		expect(range.paddingTop + range.paddingBottom).toBeGreaterThan(8000);
	});

	it('computeVirtualRange - 焦点单元在窗口外 - 扩展范围保留该单元', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		const range = computeVirtualRange(layout, 0, 500, 100, new Set(['u20']));
		expect(range.end).toBeGreaterThan(20);
	});

	it('compensateMeasuredHeight - 视口上方单元变高 - scrollTop 同量补偿', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		expect(compensateMeasuredHeight(layout, 'u2', 140, 1000)).toBe(1040);
		expect(compensateMeasuredHeight(layout, 'u20', 140, 1000)).toBe(1000);
	});

	it('offsetForUnit - 未挂载目标 - 仍按完整布局返回位置', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		expect(offsetForUnit(layout, 'u75')).toBe(7500);
		expect(offsetForUnit(layout, 'missing')).toBeNull();
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/chat/message-stream/virtual-window.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现虚拟窗口纯函数**

```typescript
/**
 * @file src/ui/chat/message-stream/virtual-window.ts
 * @description 变量高度渲染单元的前缀布局、可见窗口与测量补偿
 * @module ui/chat/message-stream/virtual-window
 */

export interface VirtualItemLike { id: string }
export interface VirtualLayoutItem extends VirtualItemLike {
	index: number;
	top: number;
	height: number;
	bottom: number;
}
export interface VirtualLayout {
	items: VirtualLayoutItem[];
	byId: Map<string, VirtualLayoutItem>;
	totalHeight: number;
}
export interface VirtualRange {
	start: number;
	end: number;
	paddingTop: number;
	paddingBottom: number;
}

/**
 * 构建完整前缀高度布局；未测量单元使用类型估算值。
 *
 * @param items - 按展示顺序排列的渲染单元
 * @param measured - 已实测的单元高度
 * @param estimate - 未测量单元的高度估算函数
 * @returns 包含前缀位置、id 索引和总高度的布局
 * @example
 *   buildVirtualLayout(items, measured, () => 96);
 */
export function buildVirtualLayout<T extends VirtualItemLike>(
	items: T[],
	measured: ReadonlyMap<string, number>,
	estimate: (item: T) => number,
): VirtualLayout {
	let top = 0;
	const layoutItems = items.map((item, index): VirtualLayoutItem => {
		const height = Math.max(1, measured.get(item.id) ?? estimate(item));
		const out = { id: item.id, index, top, height, bottom: top + height };
		top += height;
		return out;
	});
	return { items: layoutItems, byId: new Map(layoutItems.map((item) => [item.id, item])), totalHeight: top };
}

/**
 * 计算视口、overscan 与临时保留 id 的连续挂载范围。
 *
 * @param layout - 完整变量高度布局
 * @param scrollTop - 当前滚动位置
 * @param viewportHeight - 视口高度
 * @param overscanPx - 视口上下额外挂载距离
 * @param retainedIds - 因焦点或选择而必须暂留的单元 id
 * @returns 连续挂载范围及上下占位高度
 * @example
 *   computeVirtualRange(layout, 1000, 600, 600, new Set());
 */
export function computeVirtualRange(
	layout: VirtualLayout,
	scrollTop: number,
	viewportHeight: number,
	overscanPx: number,
	retainedIds: ReadonlySet<string>,
): VirtualRange {
	if (layout.items.length === 0) return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
	const minY = Math.max(0, scrollTop - overscanPx);
	const maxY = scrollTop + Math.max(1, viewportHeight) + overscanPx;
	let start = layout.items.findIndex((item) => item.bottom > minY);
	if (start < 0) start = layout.items.length - 1;
	let end = start;
	while (end < layout.items.length && layout.items[end]!.top < maxY) end++;
	for (const id of retainedIds) {
		const item = layout.byId.get(id);
		if (!item) continue;
		start = Math.min(start, item.index);
		end = Math.max(end, item.index + 1);
	}
	const paddingTop = layout.items[start]?.top ?? 0;
	const visibleBottom = end > 0 ? layout.items[end - 1]!.bottom : 0;
	return { start, end, paddingTop, paddingBottom: Math.max(0, layout.totalHeight - visibleBottom) };
}

/**
 * 实测高度变化发生在视口上方时补偿 scrollTop，保持阅读锚点。
 *
 * @param layout - 测量前的完整布局
 * @param id - 高度发生变化的单元 id
 * @param newHeight - 新实测高度
 * @param scrollTop - 测量前滚动位置
 * @returns 应用阅读锚点补偿后的滚动位置
 * @example
 *   compensateMeasuredHeight(layout, 'unit-1', 140, 1000);
 */
export function compensateMeasuredHeight(
	layout: VirtualLayout,
	id: string,
	newHeight: number,
	scrollTop: number,
): number {
	const item = layout.byId.get(id);
	if (!item || item.bottom > scrollTop) return scrollTop;
	return scrollTop + (Math.max(1, newHeight) - item.height);
}

/**
 * 返回未挂载单元在完整虚拟布局中的顶部位置。
 *
 * @param layout - 完整变量高度布局
 * @param id - 目标渲染单元 id
 * @returns 单元顶部偏移；不存在时返回 null
 * @example
 *   offsetForUnit(layout, 'unit-1');
 */
export function offsetForUnit(layout: VirtualLayout, id: string): number | null {
	return layout.byId.get(id)?.top ?? null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/chat/message-stream/virtual-window.test.ts`

Expected: 5 tests PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/message-stream/virtual-window.ts tests/ui/chat/message-stream/virtual-window.test.ts
git commit -m "feat(chat): 新增变量高度虚拟窗口模型"
```

---

### Task 3: MessageBubble 支持逻辑消息分片

**Files:**
- Modify: `src/ui/chat/message-stream/MessageBubble.svelte:25-149`
- Modify: `src/ui/chat/message-stream/TextSegment.svelte`
- Delete: `src/ui/components/StreamingMarkdownView.svelte`
- Test: `tests/ui/chat/message-stream/render-unit-projector.test.ts`

- [ ] **Step 1: 扩展 projector 失败测试，锁定附件与 footer 只出现一次**

```typescript
	it('project - 多块消息 - 附件只在首块且错误/引用 footer 只在末块', () => {
		const projector = new RenderUnitProjector();
		const msg = assistant('a1', '第一段\n\n第二段');
		msg.attachments = [{ fileName: 'a.png', mimeType: 'image/png', base64: 'AA==' }];
		msg.cancelled = true;
		const units = projector.project([msg], false).filter((u): u is MessageRenderUnit => u.kind === 'message');
		expect(units.filter((u) => u.showAttachments)).toHaveLength(1);
		expect(units.filter((u) => u.showFooter)).toHaveLength(1);
		expect(units[0]!.showAttachments).toBe(true);
		expect(units[units.length - 1]!.showFooter).toBe(true);
	});
```

- [ ] **Step 2: 运行 projector 回归测试**

Run: `npx vitest run tests/ui/chat/message-stream/render-unit-projector.test.ts`

Expected: PASS，附件与 footer 各只有一个承载单元。

- [ ] **Step 3: 扩展 MessageBubble props**

把 props 增加为：

```typescript
		segments = msg.segments,
		position = 'only',
		anchor = true,
		showAttachments = true,
		showFooter = true,
		streaming = false,
```

对应类型：

```typescript
		segments?: Message['segments'];
		position?: 'only' | 'first' | 'middle' | 'last';
		anchor?: boolean;
		showAttachments?: boolean;
		showFooter?: boolean;
		streaming?: boolean;
```

把 blocks 改为：

```typescript
	const blocks = $derived(groupTraceSegments(segments));
```

根节点增加：

```svelte
	class:ratel-msg-unit-first={position === 'first'}
	class:ratel-msg-unit-middle={position === 'middle'}
	class:ratel-msg-unit-last={position === 'last'}
	data-msg-id={anchor ? msg.id : undefined}
```

附件条件改为 `showAttachments && msg.attachments && msg.attachments.length > 0`。TextSegment 的 streaming 改为传入的 `streaming`，因为 projector 已保证活动 tail 是独立单元。

把三个现有条件分别改为：

```svelte
	{#if showFooter && showCiteChips}
		<SearchResults
			results={msg.searchResults!}
			reranked={msg.searchReranked ?? false}
			{onOpenPath}
			{motionOn}
			messageId={msg.id}
		/>
	{/if}

	{#if showFooter && msg.chatError}
		<div class="ratel-err">
			<div class="ratel-err-icon">⚠</div>
			<div class="ratel-err-body">
				<div class="ratel-err-msg">{msg.chatError.message}</div>
				{#if msg.chatError.suggestion}
					<div class="ratel-err-sug">{msg.chatError.suggestion}</div>
				{/if}
			</div>
		</div>
	{/if}

	{#if showFooter && msg.cancelled}
		<div class="ratel-cancelled">
			<span class="ratel-cancelled-dot"></span>
			{$t('chat.error.stopped')}
		</div>
	{/if}
```

FadeIn 只允许 `position === 'only' || position === 'first'`：

```typescript
	const fadeInPlay = $derived(motionOn && fadePlay && (position === 'only' || position === 'first'));
```

- [ ] **Step 4: TextSegment 回到单块 MarkdownView 并删除中间组件**

`TextSegment.svelte` 导入恢复为：

```typescript
	import MarkdownView from '../../components/MarkdownView.svelte';
```

助手分支使用 `<MarkdownView>`；其 `streaming` 只会在 projector 的 tail 单元为 true。

删除：

```bash
git rm src/ui/components/StreamingMarkdownView.svelte
```

- [ ] **Step 5: 保持 MessageBubble 自身无负 margin**

不在 MessageBubble 增加负 margin。虚拟列表 wrapper 在 Task 4 使用可测量的 `padding-bottom` 表达“同消息 10px、跨消息 20px”，避免 margin 不进入 ResizeObserver 高度。

- [ ] **Step 6: 运行测试、Svelte 检查与构建**

Run: `npx vitest run tests/ui/chat/message-stream/render-unit-projector.test.ts tests/ui/chat/message-stream/group-trace-segments.test.ts && npm run svelte-check && npm run build`

Expected: 测试 PASS；Svelte 0 errors；build exit 0。

- [ ] **Step 7: 提交**

```bash
git add src/ui/chat/message-stream/MessageBubble.svelte src/ui/chat/message-stream/TextSegment.svelte src/ui/chat/message-stream/render-unit-projector.ts tests/ui/chat/message-stream/render-unit-projector.test.ts
git add -u src/ui/components/StreamingMarkdownView.svelte
git commit -m "refactor(chat): 支持逻辑消息块级渲染"
```

---

### Task 4: MessageList 接入虚拟窗口、测量与 retained 单元

**Files:**
- Modify: `src/ui/chat/message-stream/MessageList.svelte:1-216`
- Test: `tests/ui/chat/message-stream/virtual-window.test.ts`

- [ ] **Step 1: 扩展失败测试，锁定 selection/focus 保留范围**

在 `virtual-window.test.ts` 追加：

```typescript
	it('computeVirtualRange - 两个选择端点 - 挂载两端之间连续范围', () => {
		const layout = buildVirtualLayout(items, new Map(), () => 100);
		const range = computeVirtualRange(layout, 4000, 500, 100, new Set(['u10', 'u60']));
		expect(range.start).toBeLessThanOrEqual(10);
		expect(range.end).toBeGreaterThan(60);
	});
```

- [ ] **Step 2: 运行 retained 范围回归测试**

Run: `npx vitest run tests/ui/chat/message-stream/virtual-window.test.ts`

Expected: PASS，范围同时覆盖 `u10` 与 `u60`。

- [ ] **Step 3: 在 MessageList 建立 projector、layout 与 range**

加入导入：

```typescript
	import { tick } from 'svelte';
	import { RenderUnitProjector, type RenderUnit } from './render-unit-projector';
	import {
		buildVirtualLayout,
		computeVirtualRange,
		compensateMeasuredHeight,
		offsetForUnit,
	} from './virtual-window';
```

加入状态：

```typescript
	const projector = new RenderUnitProjector();
	let measured = $state(new Map<string, number>());
	let scrollTop = $state(0);
	let viewportHeight = $state(600);
	let retainedIds = $state(new Set<string>());
	let units = $state<RenderUnit[]>([]);
	$effect(() => {
		units = projector.project(messages, isRunning);
	});
	const estimateUnitHeight = (unit: RenderUnit): number => {
		if (unit.kind === 'compact') return 54;
		const gap = unit.position === 'only' || unit.position === 'last' ? 20 : 10;
		if (unit.streaming) return 72 + gap;
		const first = unit.segments[0];
		if (first?.type === 'tool' || first?.type === 'think') return 64 + gap;
		if (first?.type === 'text') return Math.max(48, Math.min(480, 32 + first.text.length * 0.35)) + gap;
		return 72 + gap;
	};
	const layout = $derived(buildVirtualLayout(units, measured, estimateUnitHeight));
	const range = $derived(computeVirtualRange(
		layout,
		scrollTop,
		viewportHeight,
		Math.max(400, viewportHeight * 1.5),
		retainedIds,
	));
	const visibleUnits = $derived(units.slice(range.start, range.end));
```

- [ ] **Step 4: 实现 ResizeObserver action 与锚点补偿**

```typescript
	function measureUnit(node: HTMLElement, id: string) {
		const apply = (height: number) => {
			const previous = measured.get(id);
			if (!Number.isFinite(height) || height <= 0 || (previous !== undefined && Math.abs(previous - height) < 0.5)) return;
			const el = containerRef;
			const nearBottom = !!el && el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
			const corrected = compensateMeasuredHeight(layout, id, height, scrollTop);
			const next = new Map(measured);
			next.set(id, height);
			measured = next;
			if (el && !nearBottom && corrected !== scrollTop) {
				el.scrollTop = corrected;
				scrollTop = corrected;
			}
		};
		apply(node.getBoundingClientRect().height);
		if (typeof ResizeObserver === 'undefined') return {};
		const observer = new ResizeObserver(() => apply(node.getBoundingClientRect().height));
		observer.observe(node);
		return { destroy: () => observer.disconnect() };
	}
```

- [ ] **Step 5: 实现 focus/selection retained 集合**

```typescript
	function unitIdFromNode(node: Node | null): string | null {
		const el = node instanceof Element ? node : node?.parentElement;
		return el?.closest<HTMLElement>('[data-render-unit-id]')?.dataset.renderUnitId ?? null;
	}

	$effect(() => {
		const updateRetained = () => {
			const next = new Set<string>();
			const focused = unitIdFromNode(document.activeElement);
			if (focused) next.add(focused);
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
				const range = selection.getRangeAt(0);
				const start = unitIdFromNode(range.startContainer);
				const end = unitIdFromNode(range.endContainer);
				if (start) next.add(start);
				if (end) next.add(end);
			}
			retainedIds = next;
		};
		document.addEventListener('focusin', updateRetained);
		document.addEventListener('focusout', updateRetained);
		document.addEventListener('selectionchange', updateRetained);
		return () => {
			document.removeEventListener('focusin', updateRetained);
			document.removeEventListener('focusout', updateRetained);
			document.removeEventListener('selectionchange', updateRetained);
		};
	});
```

- [ ] **Step 6: 用 spacer + visibleUnits 替换全量 each**

根滚动事件改为同时更新本地窗口：

```svelte
<div
	class="ratel-messages"
	bind:this={containerRef}
	onscroll={() => {
		if (!containerRef) return;
		scrollTop = containerRef.scrollTop;
		viewportHeight = containerRef.clientHeight || 600;
		onScroll?.(containerRef);
	}}
>
```

用以下结构替换全量 `{#each messages}`：

```svelte
	<div class="ratel-virtual-spacer" style:height={`${range.paddingTop}px`}></div>
	{#each visibleUnits as unit (unit.id)}
		<div
			class="ratel-render-unit"
			data-render-unit-id={unit.id}
			data-unit-position={unit.kind === 'compact' ? 'compact' : unit.position}
			use:measureUnit={unit.id}
		>
			{#if unit.kind === 'compact'}
				<div class="ratel-compact-divider" data-phase={unit.phase ?? 'done'}>
					{$t(compactLabelKey(unit.phase))}
				</div>
			{:else}
				<MessageBubble
					msg={unit.msg}
					segments={unit.segments}
					position={unit.position}
					anchor={unit.anchor}
					showAttachments={unit.showAttachments}
					showFooter={unit.showFooter}
					streaming={unit.streaming}
					isLast={unit.messageIndex === messages.length - 1}
					{isRunning}
					{onOpenPath}
					navFlash={unit.messageId === highlightId}
					{citeSearchFallback}
					fadePlay={computeFadePlay(unit.messageId, enteredIds, motionOn)}
				/>
			{/if}
		</div>
	{/each}
	<div class="ratel-virtual-spacer" style:height={`${range.paddingBottom}px`}></div>
```

保留 EmptyStage 和 busy orb；busy orb 放在底部 spacer 之后并始终挂载。

CSS 改为：

```css
	.ratel-messages {
		display: block;
	}
	.ratel-render-unit {
		display: flex;
		flex-direction: column;
		padding-bottom: 10px;
		box-sizing: border-box;
	}
	.ratel-render-unit[data-unit-position='only'],
	.ratel-render-unit[data-unit-position='last'],
	.ratel-render-unit[data-unit-position='compact'] {
		padding-bottom: 20px;
	}
	.ratel-virtual-spacer {
		width: 1px;
		pointer-events: none;
	}
```

- [ ] **Step 7: 初始化和会话切换时清理测量缓存**

在现有 `if (sessionId !== trackedSessionId)` 分支中、赋值 `trackedSessionId = sessionId` 之前加入：

```typescript
		measured = new Map();
		scrollTop = 0;
		retainedIds = new Set();
```

容器绑定后读取一次高度：

```typescript
	$effect(() => {
		if (!containerRef) return;
		viewportHeight = containerRef.clientHeight || 600;
	});
```

- [ ] **Step 8: 运行目标测试、Svelte 检查和构建**

Run: `npx vitest run tests/ui/chat/message-stream/virtual-window.test.ts tests/ui/chat/message-stream/render-unit-projector.test.ts && npm run svelte-check && npm run build`

Expected: 测试 PASS；Svelte 0 errors；build exit 0。

- [ ] **Step 9: 提交**

```bash
git add src/ui/chat/message-stream/MessageList.svelte src/ui/chat/message-stream/virtual-window.ts tests/ui/chat/message-stream/virtual-window.test.ts
git commit -m "feat(chat): 接入块级虚拟消息窗口"
```

---

### Task 5: 右侧进度轨跳转未挂载消息

**Files:**
- Modify: `src/ui/chat/ChatView.svelte:177-280,1474-1495`
- Modify: `src/ui/chat/message-stream/MessageList.svelte`
- Modify: `tests/ui/chat/message-stream/virtual-window.test.ts`

- [ ] **Step 1: 新增跳转请求类型与 offset 查找测试**

在 `render-unit-projector.ts` 导出：

```typescript
export interface VirtualJumpRequest {
	messageId: string;
	token: number;
}
```

在 `virtual-window.test.ts` 追加：

```typescript
	it('offsetForUnit - 同消息多个单元 - 首单元 id 可作为消息锚点', () => {
		const layout = buildVirtualLayout([
			{ id: 'a:first' }, { id: 'a:middle' }, { id: 'a:last' },
		], new Map(), () => 100);
		expect(offsetForUnit(layout, 'a:first')).toBe(0);
	});
```

- [ ] **Step 2: MessageList 接收 jumpRequest 并定位逻辑消息首单元**

props 增加：

```typescript
		jumpRequest = null,
```

类型增加：

```typescript
		jumpRequest?: VirtualJumpRequest | null;
```

加入 effect：

```typescript
	let handledJumpToken = $state(-1);
	$effect(() => {
		const request = jumpRequest;
		if (!request || request.token === handledJumpToken || !containerRef) return;
		handledJumpToken = request.token;
		const target = units.find((unit) => unit.messageId === request.messageId &&
			(unit.kind === 'compact' || unit.anchor));
		if (!target) return;
		const top = offsetForUnit(layout, target.id);
		if (top === null) return;
		containerRef.scrollTop = top;
		scrollTop = top;
		void tick().then(() => {
			const node = containerRef?.querySelector(`[data-msg-id="${CSS.escape(request.messageId)}"]`);
			node?.scrollIntoView({ block: 'start' });
		});
	});
```

- [ ] **Step 3: ChatView 改为发送虚拟跳转请求**

状态区加入：

```typescript
	let navJumpRequest = $state<VirtualJumpRequest | null>(null);
	let navJumpToken = 0;
```

把 `jumpToMessage()` 中 DOM query 与早退替换为：

```typescript
		isUserNearBottom = false;
		navJumpRequest = { messageId: id, token: ++navJumpToken };
		navHighlightId = id;
```

`navHighlightId = id` 之后的现有 1000ms timer 代码保持不变。给 MessageList 增加 prop：

```svelte
				jumpRequest={navJumpRequest}
```

导入 `VirtualJumpRequest` 类型。`seekByRatio()` 继续直接设置原生 `scrollTop`，因为 spacer 已使 `scrollHeight` 等于完整虚拟高度。

- [ ] **Step 4: 运行 nav、窗口测试和构建**

Run: `npx vitest run tests/ui/chat/nav/chat-nav-rail.test.ts tests/ui/chat/message-stream/virtual-window.test.ts tests/ui/chat/message-stream/render-unit-projector.test.ts tests/ui/chat/sticky-scroll.test.ts && npm run typecheck && npm run build`

Expected: 测试 PASS；typecheck/build exit 0。

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/ChatView.svelte src/ui/chat/message-stream/MessageList.svelte src/ui/chat/message-stream/render-unit-projector.ts tests/ui/chat/message-stream/virtual-window.test.ts
git commit -m "feat(chat): 进度轨跳转虚拟消息锚点"
```

---

### Task 6: 节点上界性能合同、完整验证与状态登记

**Files:**
- Create: `tests/perf/chat-virtual-window-policy.test.ts`
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: 写性能合同测试**

```typescript
/**
 * @file tests/perf/chat-virtual-window-policy.test.ts
 * @description 长会话虚拟窗口节点上界与单条长消息拆块合同
 * @module tests/perf/chat-virtual-window-policy
 */
import { describe, expect, it } from 'vitest';
import { RenderUnitProjector } from '../../src/ui/chat/message-stream/render-unit-projector';
import { buildVirtualLayout, computeVirtualRange } from '../../src/ui/chat/message-stream/virtual-window';
import type { Message } from '../../src/ui/chat/message-stream/types';

describe('聊天虚拟窗口性能合同', () => {
	it('100 条混合消息 - 600px 视口只挂载有限 RenderUnit', () => {
		const messages: Message[] = Array.from({ length: 100 }, (_, i) => ({
			id: `m${i}`,
			role: i % 2 === 0 ? 'user' : 'assistant',
			segments: [{ type: 'text', text: `消息 ${i}\n\n${'x'.repeat(200)}` }],
		}));
		const units = new RenderUnitProjector().project(messages, false);
		const layout = buildVirtualLayout(units, new Map(), () => 100);
		const range = computeVirtualRange(layout, 4000, 600, 900, new Set());
		expect(range.end - range.start).toBeLessThanOrEqual(26);
		expect(units.length).toBeGreaterThan(100);
	});

	it('单条 16K 多段助手消息 - 拆成多个虚拟块而非一个巨型单元', () => {
		const text = Array.from({ length: 200 }, (_, i) => `段落 ${i} ${'x'.repeat(68)}`).join('\n\n');
		const msg: Message = { id: 'long', role: 'assistant', segments: [{ type: 'text', text }] };
		const units = new RenderUnitProjector().project([msg], false);
		expect(text.length).toBeGreaterThanOrEqual(15_000);
		expect(units.length).toBeGreaterThan(100);
	});
});
```

- [ ] **Step 2: 运行三阶段专项与完整测试**

Run: `npx vitest run tests/perf/chat-stream-render-policy.test.ts tests/perf/chat-stable-block-policy.test.ts tests/perf/chat-virtual-window-policy.test.ts tests/ui/chat/message-stream/render-unit-projector.test.ts tests/ui/chat/message-stream/virtual-window.test.ts`

Expected: 所有性能合同 PASS。

Run: `npm test && npm run lint && npm run typecheck && npm run build`

Expected: 全部 exit 0，0 failures。

- [ ] **Step 3: 只链接 Sandbox 并验收长会话**

Run: `npm run link:vault -- "<sandbox>"`

Reload app without saving 后确认：

1. 打开至少 100 条消息的会话，滚动、停止与切换笔记保持响应。
2. DevTools 中 `.ratel-render-unit` 数量随视口变化但保持有限，不等于完整 RenderUnit 数量。
3. 快速拖动右侧进度轨到顶部、中部和底部，位置连续且不跳回。
4. 点击尚未挂载的历史 user 锚点，目标消息挂载并高亮。
5. 展开工具、加载 Mermaid/图片后，向上阅读位置不跳。
6. 流式期间贴底时活动尾部持续可见；用户上滑后不会自动拉回，回到底部时立即显示最新尾部。
7. 选中文字或聚焦按钮后轻微滚动，相关单元不被回收；结束交互后恢复虚拟化。

- [ ] **Step 4: 更新 STATUS 并提交**

把 `P-CHAT-PERF-3` 更新为 `✅ Completed`，记录实际分支、测试总数和 Sandbox 结果；spec 在三个 plan 全部完成、合并和清理前仍保持 Active。

```bash
git add tests/perf/chat-virtual-window-policy.test.ts docs/superpowers/STATUS.md
git commit -m "test(chat): 固化块级虚拟滚动性能合同"
```

---

## 自审

- [ ] Spec §5.4：虚拟化单位包含静态 Markdown 块、活动 tail、工具/思考和 compact 分隔。
- [ ] Spec §5.4：历史静态长消息也拆块；跨块引用依赖保持单一单元。
- [ ] Spec §5.4：窗口外使用 spacer，原生 scrollHeight 表示完整虚拟高度。
- [ ] Spec §5.4：ResizeObserver 高度变化在离底阅读时补偿 scrollTop。
- [ ] Spec §5.4：焦点与选择端点进入 retainedIds，交互结束后回收；离底时不为活动尾部扩展整段范围。
- [ ] Spec §5.6：sticky、seek ratio、未挂载锚点跳转均覆盖。
- [ ] Spec §6：100 消息节点上界与单条 16K 拆块有确定性测试。
- [ ] P1/P2 性能合同继续通过，没有重新引入每 delta 全量渲染。
- [ ] 无新增依赖、消息持久化字段、Worker 协议或用户可见字符串。
- [ ] Sandbox 只链接开发预览库，不触碰日常主库。
