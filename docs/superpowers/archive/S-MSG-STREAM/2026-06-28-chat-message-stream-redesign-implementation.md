# Chat 消息流重构 + Think 块 + Token 校准 + 模型探测实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Chat 消息模型从 `content + toolCalls` 双数组重构为 `segments` 判别联合(保留事件时序),端到端支持 think 块(DeepSeek reasoning_content),工具详情可展开,token 三层校准(本地估算→流式→API 真值),模型 context length 动态探测,UI 目录按职责归拢,agent-loop 旁路逻辑外迁。

**Architecture:** `segment-appender.ts` 封装段追加/合并;`token-estimator.ts` 中英混合权重估算;`probe-model.ts` 测试连接 + 映射表回退;`search-result-mapper.ts` 扁平化搜索结果;`Collapsible.svelte` 通用折叠容器(think/tool 段共用);ChatView.svelte 瘦身为 ~200 行编排层;agent-loop 透传 `reasoning`/`usage`,search.result 改用 mapper。

**Tech Stack:** TypeScript(strict)、Svelte 5($state/$props/mount)、vitest、esbuild、Obsidian PluginSettingTab。

**所属 Spec:** [S-MSG-STREAM](../specs/2026-06-28-chat-message-stream-redesign-design.md)

**UI 参考:** [chat-ui-mockup.html](../../../.superpowers/brainstorm/chat-ui-mockup.html) — 可交互示例,反映 segments 渲染、think/tool 折叠、token source 指示器、模型探测按钮。

---

## Spec 范围缺口说明

Spec 第 2.3 节与"修改文件"列表引用 `src/adapters/llm-anthropic.ts`,但**该文件在代码库中不存在**(仅有 `llm-deepseek.ts`)。Spec"新增文件"列表也未包含创建它。本 plan 的处理:

- **实施:** 端口层 `ChatDelta` 加 `reasoning` / `usage` 字段(provider 无关),DeepSeek 适配器解析 `reasoning_content` 与 `usage`,agent-loop 透传。
- **不实施:** Claude 适配器创建与 thinking block 解析(文件不存在,属于独立工作)。
- **预留:** `reasoning` / `usage` 字段已为未来 Claude 适配器就绪,后续创建 `llm-anthropic.ts` 时直接使用。

---

## 文件结构

### 新建(12 个)

| 文件 | 职责 |
|------|------|
| `src/ui/chat/message-stream/types.ts` | `MessageSegment` 判别联合、`ToolCallEntry`、`Message` |
| `src/ui/chat/message-stream/segment-appender.ts` | 段追加/合并/工具结果回填/失败标记 |
| `src/ui/chat/message-stream/MessageList.svelte` | 渲染 `Message[]` |
| `src/ui/chat/message-stream/MessageBubble.svelte` | 单条消息,委托各 Segment 组件 |
| `src/ui/chat/message-stream/TextSegment.svelte` | 文本段(MarkdownView) |
| `src/ui/chat/message-stream/ThinkSegment.svelte` | think 段(可折叠,流式展开) |
| `src/ui/chat/message-stream/ToolSegment.svelte` | 工具段(可折叠,displayName + 详情) |
| `src/ui/chat/message-stream/SearchResults.svelte` | 搜索结果引用列表 |
| `src/ui/tokens/token-estimator.ts` | 中英混合权重 token 估算 |
| `src/ui/tokens/probe-model.ts` | 测试连接 + 内置映射表推断 context length |
| `src/ui/components/Collapsible.svelte` | 通用折叠容器(slot + prop 控制样式) |
| `src/core/search-result-mapper.ts` | search_vault 原始结果扁平化 |

### 迁移(git mv,15 个)

| 原路径 | 新路径 |
|--------|--------|
| `src/ui/ChatView.svelte` | `src/ui/chat/ChatView.svelte` |
| `src/ui/ChatView.ts` | `src/ui/chat/ChatView.ts` |
| `src/ui/AttachmentStrip.svelte` | `src/ui/chat/input/AttachmentStrip.svelte` |
| `src/ui/SlashMenu.svelte` | `src/ui/chat/input/SlashMenu.svelte` |
| `src/ui/attachment-utils.ts` | `src/ui/chat/input/attachment-utils.ts` |
| `src/ui/slash-commands.ts` | `src/ui/chat/input/slash-commands.ts` |
| `src/ui/chat-error.ts` | `src/ui/chat/chat-error.ts` |
| `src/ui/chat-send-gate.ts` | `src/ui/chat/chat-send-gate.ts` |
| `src/ui/compact-confirm.ts` | `src/ui/chat/compact-confirm.ts` |
| `src/ui/format-tool-display.ts` | `src/ui/chat/format-tool-display.ts` |
| `src/ui/StatusLine.svelte` | `src/ui/status/StatusLine.svelte` |
| `src/ui/StatusDrawer.svelte` | `src/ui/status/StatusDrawer.svelte` |
| `src/ui/MarkdownView.svelte` | `src/ui/components/MarkdownView.svelte` |
| `src/ui/confirm-modal.ts` | `src/ui/components/confirm-modal.ts` |
| `src/ui/secret-hint.ts` | `src/ui/components/secret-hint.ts` |

### 修改(8 个)

| 文件 | 改动 |
|------|------|
| `src/types.ts` | `AgentEvent.message.delta` 加 `reasoning`;`message.end` 加 `promptTokens`/`completionTokens` |
| `src/ports/llm.ts` | `ChatDelta` 加 `reasoning` 与 `usage` 字段 |
| `src/adapters/llm-deepseek.ts` | 解析 `reasoning_content` 与 `usage`,末尾 yield usage delta |
| `src/core/agent-loop.ts` | 透传 `reasoning`/`usage`,search.result 改用 `mapSearchResults` |
| `src/core/context-manager.ts` | `tokenCount`/`trimHistory`/`getContextUsage` 用 `estimateTokens` 替代 `length/4` |
| `src/user-feedback/user-status.ts` | `ContextUsage` 加可选 `source` 字段(estimate/streaming/api) |
| `src/settings.ts` | `chatModelMaxTokens` 默认值 32000→0;模型配置区加"测试连接"按钮 |
| `src/main.ts` | 更新 ChatView import 路径 |

### 测试(7 个)

| 文件 | 覆盖点 |
|------|--------|
| `tests/ui/chat/message-stream/segment-appender.test.ts` | text/think 合并、tool 不合并、attachToolResult、markToolFailed |
| `tests/ui/tokens/token-estimator.test.ts` | 纯英文、纯中文、中英混合、空串、纯符号 |
| `tests/ui/tokens/probe-model.test.ts` | 连接成功+映射命中、连接失败、映射未命中 |
| `tests/core/search-result-mapper.test.ts` | 正常结果、缺 metadata.path、reranked 字段存在/缺失 |
| `tests/adapters/llm-deepseek.test.ts` | 新增:reasoning_content 解析、usage 解析、无 reasoning 字段 |
| `tests/core/agent-loop.test.ts` | 新增:reasoning 透传、usage 透传到 message.end、search.result 用 mapper |
| `tests/core/context-manager-usage.test.ts` | 新增:estimateTokens 替代 length/4 |

---

## 执行顺序与依赖

```
Phase A 纯逻辑(可独立测试)
  Task 1 token-estimator ──┐
  Task 2 search-result-mapper┤
  Task 3 msg-stream types  ─┤
  Task 4 segment-appender  ─┤(依赖 Task 3)
                            │
Phase B 端口/适配器/agent-loop(依赖 A)
  Task 5 ChatDelta+AgentEvent┤(依赖 Task 1)
  Task 6 DeepSeek reasoning  ┤(依赖 Task 5)
  Task 7 agent-loop 透传     ┤(依赖 Task 2,5)
                            │
Phase C UI 目录归拢(机械迁移,依赖无)
  Task 8 git mv + import 修正┤
                            │
Phase D 消息流组件(依赖 A,C)
  Task 9 Collapsible        ┤
  Task 10 TextSegment+Search┤(依赖 Task 8,9)
  Task 11 ThinkSegment      ┤(依赖 Task 9)
  Task 12 ToolSegment       ┤(依赖 Task 9)
  Task 13 MessageBubble+List┤(依赖 Task 10,11,12)
                            │
Phase E ChatView 重构(依赖 B,D)
  Task 14 ChatView segments ┤
                            │
Phase F Token 校准接线(依赖 E)
  Task 15 context-manager   ┤(依赖 Task 1)
  Task 16 user-status source┤
  Task 17 ChatView 3 层校准 ┤(依赖 Task 14,15,16)
                            │
Phase G 模型探测(依赖 A)
  Task 18 probe-model       ┤(依赖 Task 1)
  Task 19 settings 按钮     ┤(依赖 Task 18)
                            │
Phase H 验证
  Task 20 全量构建+测试+STATUS
```

**分支:** `feat/s-msg-stream`

---

## Task 1: Token 估算器

**Files:**
- Create: `src/ui/tokens/token-estimator.ts`
- Test: `tests/ui/tokens/token-estimator.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/ui/tokens/token-estimator.test.ts
/**
 * @file tests/ui/tokens/token-estimator.test.ts
 * @description token-estimator 单元测试 — 中英混合权重估算
 */
import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../../src/ui/tokens/token-estimator';

describe('estimateTokens', () => {
	it('estimateTokens - 空字符串 - 返回 0', () => {
		expect(estimateTokens('')).toBe(0);
	});

	it('estimateTokens - 纯英文 - 约 4 字符/token', () => {
		// "hello world" = 11 字符 ASCII,11/4 = 2.75 → ceil = 3
		expect(estimateTokens('hello world')).toBe(3);
	});

	it('estimateTokens - 纯中文 - 约 1.5 字符/token', () => {
		// 6 个 CJK,6/1.5 = 4
		expect(estimateTokens('你好世界测试')).toBe(4);
	});

	it('estimateTokens - 中英混合 - 分权重求和', () => {
		// "hello 你好" = 6 ASCII + 2 CJK,6/4 + 2/1.5 = 1.5 + 1.33 = 2.83 → ceil = 3
		expect(estimateTokens('hello 你好')).toBe(3);
	});

	it('estimateTokens - 纯符号 - 约 3 字符/token', () => {
		// 3 个非 ASCII 非 CJK 字符(emoji 等),3/3 = 1
		expect(estimateTokens('🎉🎊🎈')).toBe(1);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/tokens/token-estimator.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写最小实现**

```typescript
// src/ui/tokens/token-estimator.ts
/**
 * @file src/ui/tokens/token-estimator.ts
 * @description 中英混合 token 估算 — 比纯 length/4 更准,不引入第三方库
 * @module ui/tokens/token-estimator
 */

/**
 * 中英混合 token 估算。
 *
 * 权重依据:
 * - ASCII Latin:平均 ~4 字符/token(英文单词 + 空格 + 标点)
 * - CJK 中文:平均 ~1.5 字符/token(BPE 分词后中文 token 密度高)
 * - 数字与符号:~3 字符/token
 *
 * 仍为估算,真值靠 message.end 的 API usage 校准。
 *
 * @param text - 待估算文本
 * @returns 估算 token 数(向上取整)
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	let asciiCount = 0;
	let cjkCount = 0;
	let otherCount = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		if (code < 0x80) asciiCount++;
		else if (code >= 0x4e00 && code <= 0x9fff) cjkCount++;
		else otherCount++;
	}
	return Math.ceil(asciiCount / 4 + cjkCount / 1.5 + otherCount / 3);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/tokens/token-estimator.test.ts`
Expected: PASS — 5 个用例全过

- [ ] **Step 5: 提交**

```bash
git add src/ui/tokens/token-estimator.ts tests/ui/tokens/token-estimator.test.ts
git commit -m "feat(tokens): 新增中英混合 token 估算器

替代 text.length/4 粗估,中文按 1.5 字符/token、英文按 4 字符/token、
符号按 3 字符/token 分权重求和。供 context-manager 与 ChatView 共用,
真值仍由 API usage 校准。"
```

---

## Task 2: search-result-mapper

**Files:**
- Create: `src/core/search-result-mapper.ts`
- Test: `tests/core/search-result-mapper.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/core/search-result-mapper.test.ts
/**
 * @file tests/core/search-result-mapper.test.ts
 * @description search-result-mapper 单元测试 — 扁平化 search_vault 结果
 */
import { describe, it, expect } from 'vitest';
import { mapSearchResults } from '../../src/core/search-result-mapper';

describe('mapSearchResults', () => {
	it('mapSearchResults - 正常结果 - 扁平化为 path + reranked=false', () => {
		const raw = [
			{ docId: 'd1', score: 0.9, metadata: { path: 'a.md' }, index: 0 },
			{ docId: 'd2', score: 0.8, metadata: { path: 'b.md' }, index: 1 },
		];
		const result = mapSearchResults(raw);
		expect(result).not.toBeNull();
		expect(result!.results).toHaveLength(2);
		expect(result!.results[0]).toEqual({ docId: 'd1', score: 0.9, path: 'a.md', index: 0 });
		expect(result!.reranked).toBe(false);
	});

	it('mapSearchResults - 含 reranked=true - 推断 reranked=true', () => {
		const raw = [
			{ docId: 'd1', score: 0.9, metadata: { path: 'a.md' }, index: 0, reranked: true },
		];
		const result = mapSearchResults(raw);
		expect(result!.reranked).toBe(true);
	});

	it('mapSearchResults - 缺 metadata.path - 过滤掉该条', () => {
		const raw = [
			{ docId: 'd1', score: 0.9, metadata: { path: 'a.md' }, index: 0 },
			{ docId: 'd2', score: 0.8, metadata: {}, index: 1 },
		];
		const result = mapSearchResults(raw);
		expect(result!.results).toHaveLength(1);
		expect(result!.results[0]!.docId).toBe('d1');
	});

	it('mapSearchResults - 全部缺 path - 返回 null', () => {
		const raw = [{ docId: 'd1', score: 0.9, metadata: {}, index: 0 }];
		const result = mapSearchResults(raw);
		expect(result).toBeNull();
	});

	it('mapSearchResults - 非数组输入 - 返回 null', () => {
		expect(mapSearchResults(null)).toBeNull();
		expect(mapSearchResults('not array')).toBeNull();
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/search-result-mapper.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写最小实现**

```typescript
// src/core/search-result-mapper.ts
/**
 * @file src/core/search-result-mapper.ts
 * @description 把 search_vault 工具的原始结果扁平化为 search.result 事件 payload
 * @module core/search-result-mapper
 */

/** 扁平化后的单条搜索结果(UI 友好,无嵌套 metadata) */
export interface SearchResultItem {
	docId: string;
	score: number;
	path: string;
	index: number;
}

/** search_vault 原始结果的条目形状(含嵌套 metadata) */
interface RawSearchResult {
	docId: string;
	score: number;
	metadata: { path?: string };
	index: number;
	reranked?: boolean;
}

/**
 * 把 search_vault 工具的原始结果扁平化为 AgentEvent.search.result 的 payload。
 *
 * 从 metadata.path 提取 path,避免 UI 层再嵌套解析 metadata。
 * 从结果推断是否经过 Rerank;无 reranked 字段时降级 false。
 *
 * @param rawResults - search_vault 工具返回的原始结果(期望数组)
 * @returns `{ results, reranked }`;若输入非数组或过滤后为空,返回 null
 */
export function mapSearchResults(
	rawResults: unknown,
): { results: SearchResultItem[]; reranked: boolean } | null {
	if (!Array.isArray(rawResults)) return null;

	const raw = rawResults as RawSearchResult[];
	const results = raw
		.filter((r) => r && r.metadata && typeof r.metadata.path === 'string')
		.map((r) => ({
			docId: r.docId,
			score: r.score,
			path: r.metadata.path as string,
			index: r.index,
		}));

	if (results.length === 0) return null;

	const reranked = raw.some((r) => r.reranked === true);
	return { results, reranked };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/search-result-mapper.test.ts`
Expected: PASS — 5 个用例全过

- [ ] **Step 5: 提交**

```bash
git add src/core/search-result-mapper.ts tests/core/search-result-mapper.test.ts
git commit -m "feat(core): 新增 search-result-mapper 扁平化搜索结果

从 agent-loop 外迁 search_vault 结果扁平化逻辑,从 metadata.path 提取 path,
推断 reranked 标记。agent-loop 后续改用此模块,保持核心循环精简。"
```

---

## Task 3: 消息流类型定义

**Files:**
- Create: `src/ui/chat/message-stream/types.ts`

- [ ] **Step 1: 写类型文件**

```typescript
// src/ui/chat/message-stream/types.ts
/**
 * @file src/ui/chat/message-stream/types.ts
 * @description 消息流数据模型 — segments 判别联合 + ToolCallEntry + Message
 * @module ui/chat/message-stream/types
 * @depends ../../chat-error(类型)
 */

import type { DiagError } from '../../chat-error';

/**
 * 工具调用条目 — UI 渲染单元。
 * displayName 预格式化(如 "list_files Formatting/"),startAt 用于时序展示。
 */
export interface ToolCallEntry {
	name: string;
	displayName: string;
	args: unknown;
	status: 'calling' | 'done' | 'failed';
	result?: unknown;
	errorMessage?: string;
	startAt: number;
}

/**
 * 助手消息的有序段 — 保留事件时序,支持"文本 → 工具 → 文本 → 工具"完全交替。
 * 判别联合:type 字段做 discriminator,Svelte 模板用 {#if} 分支渲染。
 *
 * - `text`:普通文本段(可被流式追加合并)
 * - `think`:思考过程段(DeepSeek reasoning_content,可折叠)
 * - `tool`:工具调用段(每次 tool.call 独立一段,可折叠详情)
 * - `image`:图片段(本次仅预留接口,不实现渲染逻辑)
 * - `citation`:引用段(本次仅预留接口,不实现自动抽取)
 */
export type MessageSegment =
	| { type: 'text'; text: string }
	| { type: 'think'; text: string }
	| { type: 'tool'; toolCall: ToolCallEntry }
	| { type: 'image'; mimeType: string; base64: string }
	| { type: 'citation'; docId: string; path: string; snippet: string };

/**
 * 统一消息 — user / assistant 都用 segments,告别 content + toolCalls 双数组。
 */
export interface Message {
	role: 'user' | 'assistant';
	segments: MessageSegment[];
	chatError?: DiagError;
	cancelled?: boolean;
	searchResults?: Array<{ docId: string; score: number; path: string; index: number }>;
	searchReranked?: boolean;
	attachments?: Array<{ fileName: string; mimeType: string; base64: string }>;
	/** message.end 收到的 API 真值,用于校准 token 统计 */
	tokenUsage?: { promptTokens: number; completionTokens: number };
}
```

- [ ] **Step 2: 类型检查确认编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 无新增错误(类型文件无运行时逻辑)

- [ ] **Step 3: 提交**

```bash
git add src/ui/chat/message-stream/types.ts
git commit -m "feat(msg-stream): 新增 segments 判别联合消息模型

定义 MessageSegment(text/think/tool/image/citation)、ToolCallEntry、
Message 接口。取代 content+toolCalls 双数组,保留事件时序,
支持文本→工具→文本交替渲染。"
```

---

## Task 4: segment-appender

**Files:**
- Create: `src/ui/chat/message-stream/segment-appender.ts`
- Test: `tests/ui/chat/message-stream/segment-appender.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/ui/chat/message-stream/segment-appender.test.ts
/**
 * @file tests/ui/chat/message-stream/segment-appender.test.ts
 * @description segment-appender 单元测试 — 段追加/合并/工具结果回填
 */
import { describe, it, expect } from 'vitest';
import {
	appendText,
	appendThink,
	appendToolCall,
	attachToolResult,
	markToolFailed,
} from '../../../../src/ui/chat/message-stream/segment-appender';
import type { Message } from '../../../../src/ui/chat/message-stream/types';

function newAssistantMsg(): Message {
	return { role: 'assistant', segments: [] };
}

describe('segment-appender', () => {
	it('appendText - 相邻 text 段自动合并', () => {
		const msg = newAssistantMsg();
		appendText(msg, 'Hello');
		appendText(msg, ' world');
		expect(msg.segments).toHaveLength(1);
		expect(msg.segments[0]).toEqual({ type: 'text', text: 'Hello world' });
	});

	it('appendText - 不同类型段之间新建 text 段', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'read_note', displayName: 'read_note a.md', args: {},
			status: 'calling', startAt: 1,
		});
		appendText(msg, 'Done');
		expect(msg.segments).toHaveLength(2);
		expect(msg.segments[1]).toEqual({ type: 'text', text: 'Done' });
	});

	it('appendThink - 相邻 think 段自动合并', () => {
		const msg = newAssistantMsg();
		appendThink(msg, '思考1');
		appendThink(msg, '思考2');
		expect(msg.segments).toHaveLength(1);
		expect(msg.segments[0]).toEqual({ type: 'think', text: '思考1思考2' });
	});

	it('appendToolCall - 不合并,每次 push 新段', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'list_files', displayName: 'list_files A', args: {},
			status: 'calling', startAt: 1,
		});
		appendToolCall(msg, {
			name: 'list_files', displayName: 'list_files B', args: {},
			status: 'calling', startAt: 2,
		});
		expect(msg.segments).toHaveLength(2);
		expect(msg.segments[0]!.type).toBe('tool');
		expect(msg.segments[1]!.type).toBe('tool');
	});

	it('attachToolResult - 回填到最近 calling 的同名工具段', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'read_note', displayName: 'read_note a.md', args: {},
			status: 'calling', startAt: 1,
		});
		appendToolCall(msg, {
			name: 'read_note', displayName: 'read_note b.md', args: {},
			status: 'calling', startAt: 2,
		});
		attachToolResult(msg, 'read_note', ['content']);
		// 回填到最近的(b.md)
		const lastTool = msg.segments[1] as { type: 'tool'; toolCall: { status: string; result: unknown } };
		expect(lastTool.toolCall.status).toBe('done');
		expect(lastTool.toolCall.result).toEqual(['content']);
		// 第一个仍是 calling
		const firstTool = msg.segments[0] as { type: 'tool'; toolCall: { status: string } };
		expect(firstTool.toolCall.status).toBe('calling');
	});

	it('attachToolResult - 无匹配段时降级追加已完成工具段', () => {
		const msg = newAssistantMsg();
		attachToolResult(msg, 'read_note', 'result');
		expect(msg.segments).toHaveLength(1);
		const seg = msg.segments[0] as { type: 'tool'; toolCall: { status: string; result: unknown; name: string } };
		expect(seg.toolCall.status).toBe('done');
		expect(seg.toolCall.result).toBe('result');
	});

	it('markToolFailed - 标记最近 calling 同名工具段为 failed', () => {
		const msg = newAssistantMsg();
		appendToolCall(msg, {
			name: 'write_note', displayName: 'write_note x.md', args: {},
			status: 'calling', startAt: 1,
		});
		markToolFailed(msg, 'write_note', '路径越界');
		const seg = msg.segments[0] as { type: 'tool'; toolCall: { status: string; errorMessage: string } };
		expect(seg.toolCall.status).toBe('failed');
		expect(seg.toolCall.errorMessage).toBe('路径越界');
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/chat/message-stream/segment-appender.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写最小实现**

```typescript
// src/ui/chat/message-stream/segment-appender.ts
/**
 * @file src/ui/chat/message-stream/segment-appender.ts
 * @description segments 追加/合并/工具结果回填/失败标记 — ChatView 不再直接操作 segments 数组
 * @module ui/chat/message-stream/segment-appender
 * @depends ./types
 */

import type { Message, MessageSegment, ToolCallEntry } from './types';

/**
 * 向 message.segments 追加文本段 — 相邻 text 段自动合并(流式 delta 场景)。
 */
export function appendText(msg: Message, text: string): void {
	const last = msg.segments[msg.segments.length - 1];
	if (last && last.type === 'text') {
		last.text += text;
	} else {
		msg.segments.push({ type: 'text', text });
	}
}

/**
 * 向 message.segments 追加 think 段 — 相邻 think 段自动合并。
 */
export function appendThink(msg: Message, text: string): void {
	const last = msg.segments[msg.segments.length - 1];
	if (last && last.type === 'think') {
		last.text += text;
	} else {
		msg.segments.push({ type: 'think', text });
	}
}

/**
 * 向 message.segments 追加工具调用段 — 不合并,每个 tool.call 一个独立段。
 */
export function appendToolCall(msg: Message, tc: ToolCallEntry): void {
	msg.segments.push({ type: 'tool', toolCall: tc });
}

/**
 * 把工具调用结果回填到最近一个 status='calling' 的同名工具段。
 * 若未找到匹配段(异常时序),降级为追加一个已完成的工具段。
 */
export function attachToolResult(msg: Message, name: string, result: unknown): void {
	for (let i = msg.segments.length - 1; i >= 0; i--) {
		const seg = msg.segments[i]!;
		if (seg.type === 'tool' && seg.toolCall.name === name && seg.toolCall.status === 'calling') {
			seg.toolCall.result = result;
			seg.toolCall.status = 'done';
			return;
		}
	}
	// 降级:未找到匹配段,追加已完成的工具段
	msg.segments.push({
		type: 'tool',
		toolCall: {
			name,
			displayName: name,
			args: {},
			status: 'done',
			result,
			startAt: Date.now(),
		},
	});
}

/**
 * 标记工具段失败 — 用于 TOOL_ERROR / TOOL_DENIED / INDEX_NOT_READY 错误。
 * 标记最近一个 calling 状态的同名工具段;无匹配时不操作(错误降级到 chatError)。
 */
export function markToolFailed(msg: Message, name: string, errorMessage: string): void {
	for (let i = msg.segments.length - 1; i >= 0; i--) {
		const seg = msg.segments[i]!;
		if (seg.type === 'tool' && seg.toolCall.name === name && seg.toolCall.status === 'calling') {
			seg.toolCall.status = 'failed';
			seg.toolCall.errorMessage = errorMessage;
			return;
		}
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/chat/message-stream/segment-appender.test.ts`
Expected: PASS — 7 个用例全过

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/message-stream/segment-appender.ts tests/ui/chat/message-stream/segment-appender.test.ts
git commit -m "feat(msg-stream): 新增 segment-appender 段追加器

封装 text/think 段相邻合并、tool 段独立追加、工具结果回填与失败标记。
ChatView 不再直接操作 segments 数组,统一走此模块。"
```

---

## Task 5: 扩展 ChatDelta 与 AgentEvent 类型

**Files:**
- Modify: `src/ports/llm.ts:71-75`(ChatDelta 接口)
- Modify: `src/types.ts:29-31`(AgentEvent message.delta / message.end)

- [ ] **Step 1: 扩展 ChatDelta**

在 `src/ports/llm.ts` 的 `ChatDelta` 接口加 `reasoning` 与 `usage` 字段:

```typescript
export interface ChatDelta {
	text: string;
	/** 思考过程文本(DeepSeek reasoning_content / Claude thinking),与 text 互斥 */
	reasoning?: string;
	toolCall?: ToolCall;
	finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
	/** API 真值 token 统计(流末尾出现一次) */
	usage?: { promptTokens: number; completionTokens: number };
}
```

- [ ] **Step 2: 扩展 AgentEvent**

在 `src/types.ts` 修改 `message.delta` 与 `message.end`:

```typescript
export type AgentEvent =
	| { type: 'message.start'; payload: { role: 'user' | 'assistant' } }
	| { type: 'message.delta'; payload: { text: string; reasoning?: string } }
	| {
			type: 'message.end';
			payload: {
				tokens: number;
				promptTokens?: number;
				completionTokens?: number;
			};
	  }
	| { type: 'tool.call'; payload: { name: string; args: unknown } }
	| { type: 'tool.result'; payload: { name: string; result: unknown } }
	| {
			type: 'search.result';
			payload: {
				results: Array<{
					docId: string;
					score: number;
					path: string;
					index: number;
				}>;
				reranked: boolean;
			};
	  }
	| { type: 'subagent.spawn'; payload: { role: string; task: string } }
	| { type: 'subagent.done'; payload: { role: string; result: unknown } }
	| { type: 'hook.fired'; payload: { phase: string; tool: string } }
	| { type: 'error'; payload: { code: string; message: string } };
```

- [ ] **Step 3: 类型检查确认编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 无新增错误(新增字段均为可选,向后兼容)

- [ ] **Step 4: 运行现有测试确认无回归**

Run: `npx vitest run tests/core/agent-loop.test.ts tests/adapters/llm-deepseek.test.ts`
Expected: PASS — 新字段可选,不破坏现有调用方

- [ ] **Step 5: 提交**

```bash
git add src/ports/llm.ts src/types.ts
git commit -m "feat(ports): ChatDelta 加 reasoning/usage,AgentEvent 加对应字段

ChatDelta 新增 reasoning(思考过程)与 usage(API 真值 token)可选字段。
AgentEvent.message.delta 加 reasoning,message.end 加 promptTokens/
completionTokens。均为可选字段,向后兼容。"
```

---

## Task 6: DeepSeek 适配器解析 reasoning_content 与 usage

**Files:**
- Modify: `src/adapters/llm-deepseek.ts`(processSSEEvent + 流末尾 yield usage)
- Test: `tests/adapters/llm-deepseek.test.ts`(新增用例)

- [ ] **Step 1: 写失败测试**

在 `tests/adapters/llm-deepseek.test.ts` 末尾 `describe` 块内追加:

```typescript
	it('parses reasoning_content from deepseek-reasoner', async () => {
		const sseText = buildSseText([
			'{"choices":[{"delta":{"reasoning_content":"思考中"}}]}',
			'{"choices":[{"delta":{"reasoning_content":"继续"}}]}',
			'{"choices":[{"delta":{"content":"答案"}}]}',
			'[DONE]',
		]);

		mockRequestUrl.mockResolvedValueOnce({ status: 200, text: sseText });

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-reasoner',
		});

		const deltas: Array<{ text?: string; reasoning?: string }> = [];
		for await (const delta of llm.chat({ messages: [{ role: 'user', content: 'Hi' }] })) {
			if (delta.reasoning) deltas.push({ reasoning: delta.reasoning });
			if (delta.text) deltas.push({ text: delta.text });
		}

		expect(deltas).toEqual([
			{ reasoning: '思考中' },
			{ reasoning: '继续' },
			{ text: '答案' },
		]);
	});

	it('parses usage from stream end', async () => {
		const sseText = buildSseText([
			'{"choices":[{"delta":{"content":"hi"}}]}',
			'{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
			'[DONE]',
		]);

		mockRequestUrl.mockResolvedValueOnce({ status: 200, text: sseText });

		const llm = new DeepSeekLLM({
			apiBase: 'https://api.deepseek.com',
			apiKey: 'sk-test',
			model: 'deepseek-chat',
		});

		let usageDelta: { promptTokens: number; completionTokens: number } | undefined;
		for await (const delta of llm.chat({ messages: [{ role: 'user', content: 'Hi' }] })) {
			if (delta.usage) usageDelta = delta.usage;
		}

		expect(usageDelta).toEqual({ promptTokens: 10, completionTokens: 5 });
	});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/adapters/llm-deepseek.test.ts`
Expected: 两个新用例 FAIL(适配器未解析 reasoning_content / usage)

- [ ] **Step 3: 修改 processSSEEvent 解析 reasoning_content 与 usage**

在 `src/adapters/llm-deepseek.ts` 的 `processSSEEvent` 方法内,修改 JSON 解析与 delta 收集:

```typescript
private processSSEEvent(
	raw: string,
	toolCallAccumulators: Map<number, { id: string; name: string; arguments: string }>,
): { deltas: ChatDelta[]; finishReason: string | null; usage?: { promptTokens: number; completionTokens: number } } {
	const deltas: ChatDelta[] = [];
	let finishReason: string | null = null;
	let usage: { promptTokens: number; completionTokens: number } | undefined;
	const lines = raw.split('\n');
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.startsWith('data: ')) continue;

		const data = trimmed.slice(6);
		if (data === '[DONE]') return { deltas, finishReason, usage };

		try {
			const parsed = JSON.parse(data) as {
				choices?: Array<{
					delta?: {
						content?: string;
						reasoning_content?: string;
						tool_calls?: OpenAIToolCallChunk[];
					};
					finish_reason?: string | null;
				}>;
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
					total_tokens?: number;
				};
			};

			const choice = parsed.choices?.[0];
			if (!choice) {
				// 关键路径:usage 可能在无 choices 的末尾 chunk 中出现
				if (parsed.usage) {
					usage = {
						promptTokens: parsed.usage.prompt_tokens ?? 0,
						completionTokens: parsed.usage.completion_tokens ?? 0,
					};
				}
				continue;
			}

			if (choice.delta?.content) {
				deltas.push({ text: choice.delta.content });
			}
			// 关键路径:DeepSeek reasoner 的思考过程,yield 为 reasoning delta(text 留空)
			if (choice.delta?.reasoning_content) {
				deltas.push({ text: '', reasoning: choice.delta.reasoning_content });
			}

			if (choice.delta?.tool_calls) {
				for (const tc of choice.delta.tool_calls) {
					const existing = toolCallAccumulators.get(tc.index);
					if (existing) {
						if (tc.function?.arguments) {
							existing.arguments += tc.function.arguments;
						}
					} else {
						toolCallAccumulators.set(tc.index, {
							id: tc.id ?? '',
							name: tc.function?.name ?? '',
							arguments: tc.function?.arguments ?? '',
						});
					}
				}
			}

			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}

			// 关键路径:usage 可能在最后一个带 choices 的 chunk 中出现
			if (parsed.usage) {
				usage = {
					promptTokens: parsed.usage.prompt_tokens ?? 0,
					completionTokens: parsed.usage.completion_tokens ?? 0,
				};
			}
		} catch {
			// 修复:协议偶发返回非法 JSON,跳过单条以保证流继续。
		}
	}
	return { deltas, finishReason, usage };
}
```

- [ ] **Step 4: 修改 chat() 主循环捕获 usage 并在末尾 yield**

在 `src/adapters/llm-deepseek.ts` 的 `chat()` 方法中,修改循环与末尾部分:

```typescript
// 关键路径:usage 在流末尾出现,processSSEEvent 捕获后在此 yield
let capturedUsage: { promptTokens: number; completionTokens: number } | undefined;

for await (const chunk of stream as unknown as AsyncIterable<Buffer | string>) {
	buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
	let newlineIdx: number;
	while ((newlineIdx = buffer.indexOf('\n\n')) !== -1) {
		const rawEvent = buffer.slice(0, newlineIdx);
		buffer = buffer.slice(newlineIdx + 2);
		const result = this.processSSEEvent(rawEvent, toolCallAccumulators);
		if (result.finishReason) finishReason = result.finishReason;
		if (result.usage) capturedUsage = result.usage;
		yield* result.deltas;
	}
}

// 处理尾部残留
if (buffer.trim()) {
	const result = this.processSSEEvent(buffer, toolCallAccumulators);
	if (result.finishReason) finishReason = result.finishReason;
	if (result.usage) capturedUsage = result.usage;
	yield* result.deltas;
}

// 收尾:把累积的工具调用一次性 yield 出去
for (const [, tc] of toolCallAccumulators) {
	let args: Record<string, unknown> = {};
	try {
		args = JSON.parse(tc.arguments) as Record<string, unknown>;
	} catch {
		args = { raw: tc.arguments };
	}
	const toolCall: ToolCall = { id: tc.id, name: tc.name, args };
	yield { text: '', toolCall };
}

// 关键路径:流末尾 yield usage,供 agent-loop 透传到 message.end
if (capturedUsage) {
	yield { text: '', usage: capturedUsage };
}

if (finishReason) {
	yield { text: '', finishReason: finishReason as ChatDelta['finishReason'] };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/adapters/llm-deepseek.test.ts`
Expected: PASS — 含 2 个新用例全部通过

- [ ] **Step 6: 提交**

```bash
git add src/adapters/llm-deepseek.ts tests/adapters/llm-deepseek.test.ts
git commit -m "feat(deepseek): 解析 reasoning_content 与 usage

DeepSeek reasoner 模型的 reasoning_content yield 为 ChatDelta.reasoning,
流末尾的 usage(prompt_tokens/completion_tokens)yield 为 ChatDelta.usage。
供 agent-loop 透传到 UI 渲染 think 段与校准 token。"
```

---

## Task 7: agent-loop 透传 reasoning/usage + 改用 mapSearchResults

**Files:**
- Modify: `src/core/agent-loop.ts`(delta 循环 L120-136 + message.end L292 + search.result L230-256)
- Test: `tests/core/agent-loop.test.ts`(新增用例)

- [ ] **Step 1: 写失败测试**

在 `tests/core/agent-loop.test.ts` 的 `describe('agentLoop', ...)` 块内追加:

```typescript
	it('passes reasoning deltas through as message.delta.reasoning', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([
			[
				{ text: '', reasoning: '思考中' },
				{ text: '答案' },
			],
		]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' }, ctx, llm, tools, hooks,
		)) {
			events.push(event);
		}

		const reasoningDeltas = events.filter(
			(e): e is Extract<AgentEvent, { type: 'message.delta' }> =>
				e.type === 'message.delta' && 'reasoning' in e.payload && !!e.payload.reasoning,
		);
		expect(reasoningDeltas).toHaveLength(1);
		expect(reasoningDeltas[0]!.payload.reasoning).toBe('思考中');
	});

	it('passes usage through to message.end', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		const llm = createMockLLM([
			[
				{ text: 'hi' },
				{ text: '', usage: { promptTokens: 10, completionTokens: 5 } },
			],
		]);
		const tools = new ToolRegistry();
		const hooks = new HookRegistry();

		const events: AgentEvent[] = [];
		for await (const event of agentLoop(
			{ sessionId: 's1', message: 'Hi' }, ctx, llm, tools, hooks,
		)) {
			events.push(event);
		}

		const endEvent = events.find((e) => e.type === 'message.end') as
			Extract<AgentEvent, { type: 'message.end' }> | undefined;
		expect(endEvent).toBeDefined();
		expect(endEvent!.payload.promptTokens).toBe(10);
		expect(endEvent!.payload.completionTokens).toBe(5);
	});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/agent-loop.test.ts`
Expected: 两个新用例 FAIL(agent-loop 未透传 reasoning / usage)

- [ ] **Step 3: 修改 agent-loop delta 循环透传 reasoning 与捕获 usage**

在 `src/core/agent-loop.ts` 顶部加 import:

```typescript
import { mapSearchResults } from './search-result-mapper';
```

在 `agentLoop` 函数内,修改 delta 循环(当前 L120-136)与局部变量声明:

```typescript
let accumulatedText = '';
const toolCalls: ToolCall[] = [];
let finishReason: string | null = null;
let streamAborted = false;
// 关键路径:保存流末尾的 API 真值 token,finally 阶段 yield 到 message.end
let lastUsage: { promptTokens: number; completionTokens: number } | undefined;
```

delta 循环改为:

```typescript
for await (const delta of stream) {
	if (signal?.aborted) {
		streamAborted = true;
		break;
	}
	if (delta.text) {
		accumulatedText += delta.text;
		yield { type: 'message.delta', payload: { text: delta.text } };
	}
	// 关键路径:透传思考过程为 message.delta.reasoning
	if (delta.reasoning) {
		yield { type: 'message.delta', payload: { text: '', reasoning: delta.reasoning } };
	}
	if (delta.toolCall) {
		toolCalls.push(delta.toolCall);
	}
	if (delta.finishReason) {
		finishReason = delta.finishReason;
	}
	// 关键路径:捕获 API 真值 token,finally 阶段 yield
	if (delta.usage) {
		lastUsage = delta.usage;
	}
}
```

- [ ] **Step 4: 修改 search.result 改用 mapSearchResults**

把 agent-loop 中 L230-256 的 search_vault 结果扁平化代码替换为:

```typescript
// 关键路径:search_vault 返回后用 mapSearchResults 扁平化(逻辑外迁到 search-result-mapper)
if (tc.name === 'search_vault') {
	const mapped = mapSearchResults(result);
	if (mapped) {
		yield { type: 'search.result', payload: mapped };
	}
}
```

- [ ] **Step 5: 修改 message.end yield 透传 usage**

把 finally 块的 message.end(L292)改为:

```typescript
yield {
	type: 'message.end',
	payload: {
		tokens: ctx.tokenCount(),
		promptTokens: lastUsage?.promptTokens,
		completionTokens: lastUsage?.completionTokens,
	},
};
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/core/agent-loop.test.ts`
Expected: PASS — 含 2 个新用例全部通过

- [ ] **Step 7: 提交**

```bash
git add src/core/agent-loop.ts tests/core/agent-loop.test.ts
git commit -m "feat(agent-loop): 透传 reasoning/usage,search.result 改用 mapper

delta 循环透传 ChatDelta.reasoning 为 message.delta.reasoning,
捕获 usage 在 finally 阶段 yield 到 message.end.promptTokens/
completionTokens。search_vault 结果扁平化改用 mapSearchResults,
保持核心循环精简。"
```

---

## Task 8: UI 目录归拢(git mv + import 修正)

**Files:**
- 迁移:15 个文件(见文件结构表)
- Modify: `src/main.ts`(ChatView import 路径)
- Modify: 所有相互引用的 .svelte / .ts 文件的 import 路径

- [ ] **Step 1: 创建目录并 git mv 文件**

```bash
cd /Users/golddream/code/git-public/Ratel-CLI
mkdir -p src/ui/chat/message-stream src/ui/chat/input src/ui/status src/ui/tokens src/ui/components
git mv src/ui/ChatView.svelte src/ui/chat/ChatView.svelte
git mv src/ui/ChatView.ts src/ui/chat/ChatView.ts
git mv src/ui/AttachmentStrip.svelte src/ui/chat/input/AttachmentStrip.svelte
git mv src/ui/SlashMenu.svelte src/ui/chat/input/SlashMenu.svelte
git mv src/ui/attachment-utils.ts src/ui/chat/input/attachment-utils.ts
git mv src/ui/slash-commands.ts src/ui/chat/input/slash-commands.ts
git mv src/ui/chat-error.ts src/ui/chat/chat-error.ts
git mv src/ui/chat-send-gate.ts src/ui/chat/chat-send-gate.ts
git mv src/ui/compact-confirm.ts src/ui/chat/compact-confirm.ts
git mv src/ui/format-tool-display.ts src/ui/chat/format-tool-display.ts
git mv src/ui/StatusLine.svelte src/ui/status/StatusLine.svelte
git mv src/ui/StatusDrawer.svelte src/ui/status/StatusDrawer.svelte
git mv src/ui/MarkdownView.svelte src/ui/components/MarkdownView.svelte
git mv src/ui/confirm-modal.ts src/ui/components/confirm-modal.ts
git mv src/ui/secret-hint.ts src/ui/components/secret-hint.ts
```

- [ ] **Step 2: 更新 main.ts 的 ChatView import 路径**

在 `src/main.ts` 第 64 行:

```typescript
import { ChatView, VIEW_TYPE_CHAT } from './ui/chat/ChatView';
```

- [ ] **Step 3: 更新迁移文件内的 import 路径**

逐文件修正 import。以下是需要修改的 import 与新路径(用 Grep 找到所有旧路径引用):

**`src/ui/chat/ChatView.svelte`** 顶部 import 改为:
```typescript
import StatusLine from '../status/StatusLine.svelte';
import StatusDrawer from '../status/StatusDrawer.svelte';
import SlashMenu from './input/SlashMenu.svelte';
import AttachmentStrip from './input/AttachmentStrip.svelte';
import MarkdownView from '../components/MarkdownView.svelte';
import { filterCommands, type SlashCommand } from './input/slash-commands';
import { validateAttachment, estimateImageTokens } from './input/attachment-utils';
import { evaluateChatSendGate } from './chat-send-gate';
import { hasChatApiKey } from '../../secrets/ratel-secrets';
import { formatChatError, type DiagError } from './chat-error';
import { showCompactConfirm } from './compact-confirm';
import { devLogger } from '../../logging/dev-logger';
import { formatToolDisplayName } from './format-tool-display';
import type RatelVaultPlugin from '../../main';
import { get } from 'svelte/store';
```

**`src/ui/chat/ChatView.ts`** import 改为:
```typescript
import ChatViewComponent from './ChatView.svelte';
import type RatelVaultPlugin from '../../main';
```

**`src/ui/chat/input/SlashMenu.svelte`** import 改为:
```typescript
import { filterCommands, type SlashCommand } from './slash-commands';
```

**`src/ui/chat/input/AttachmentStrip.svelte`** — 检查 import 是否引用旧路径同伴文件,若有则改为 `./attachment-utils`。

**`src/ui/status/StatusLine.svelte`** 与 **`src/ui/status/StatusDrawer.svelte`** — 检查对 `../chat-error`、`../format-tool-display` 的引用,改为 `../chat/chat-error`、`../chat/format-tool-display`。

**`src/ui/components/secret-hint.ts`** — 检查对 `../../secrets/ratel-secrets` 的引用(深度从 1 变 2)。

- [ ] **Step 4: 全文搜索遗漏的旧路径引用**

Run: `npx tsc -noEmit -skipLibCheck 2>&1 | head -40`
Expected: 列出所有 broken import,逐个修正直到编译通过

- [ ] **Step 5: svelte-check 确认 Svelte 文件编译通过**

Run: `npx svelte-check --tsconfig tsconfig.json`
Expected: 0 errors(仅可能有 warning,可接受)

- [ ] **Step 6: 全量构建确认**

Run: `npm run build`
Expected: 成功产出 `dist/main.js`、`dist/worker.js`、`dist/embedding-worker.js`

- [ ] **Step 7: 运行全量测试确认无回归**

Run: `npm test`
Expected: 全部 PASS(测试文件的 import 路径也需同步修正,见 Step 4 的 tsc 输出)

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "refactor(ui): UI 目录按职责归拢为 chat/status/tokens/components

15 个文件 git mv 到子系统目录(chat/ chat/input/ chat/message-stream/
status/ tokens/ components/),更新所有 import 路径。ChatView.svelte
迁到 chat/,为后续 segments 重构与新组件下沉做准备。diagnostics/ 保持
现状不动。"
```

---

## Task 9: Collapsible 通用折叠组件

**Files:**
- Create: `src/ui/components/Collapsible.svelte`

- [ ] **Step 1: 写组件**

```svelte
<!-- src/ui/components/Collapsible.svelte -->
<!--
	@file src/ui/components/Collapsible.svelte
	@description 通用折叠容器 — think / tool 段共用,slot 内容 + prop 控制样式
	@module ui/components/Collapsible
-->
<script lang="ts">
	/**
	 * Collapsible 折叠容器 props。
	 *
	 * @param title - 折叠条标题文本
	 * @param icon - 标题前缀图标(如 ✓ ✗ 💭)
	 * @param iconClass - 图标样式类(done/failed/calling/think)
	 * @param defaultExpanded - 初始是否展开(流式 think 段传 true)
	 * @param accentColor - 左边框颜色 CSS 变量(如 var(--text-warning))
	 */
	let {
		title,
		icon = '',
		iconClass = '',
		defaultExpanded = false,
		accentColor = 'var(--background-modifier-border)',
		children,
	}: {
		title: string;
		icon?: string;
		iconClass?: string;
		defaultExpanded?: boolean;
		accentColor?: string;
		children: import('svelte').Snippet;
	} = $props();

	let expanded = $state(defaultExpanded);

	function toggle() {
		expanded = !expanded;
	}
</script>

<div class="ratel-collapsible" style="--ratel-accent: {accentColor}">
	<button class="ratel-collapsible-hdr" onclick={toggle} aria-expanded={expanded}>
		{#if icon}
			<span class="ratel-collapsible-icon {iconClass}">{icon}</span>
		{/if}
		<span class="ratel-collapsible-title">{title}</span>
		<span class="ratel-collapsible-arrow" class:ratel-collapsible-arrow-collapsed={!expanded}>▼</span>
	</button>
	{#if expanded}
		<div class="ratel-collapsible-body">
			{@render children()}
		</div>
	{/if}
</div>

<style>
	.ratel-collapsible {
		border-left: 2px solid var(--ratel-accent);
		border-radius: 4px;
		background: color-mix(in srgb, var(--ratel-accent) 10%, transparent);
		margin-bottom: 6px;
	}

	.ratel-collapsible-hdr {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 6px 10px;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
		user-select: none;
		text-align: left;
	}

	.ratel-collapsible-icon {
		flex-shrink: 0;
		font-size: 11px;
		width: 12px;
		text-align: center;
	}

	.ratel-collapsible-icon.done { color: var(--text-success); }
	.ratel-collapsible-icon.failed { color: var(--text-error); }
	.ratel-collapsible-icon.think { color: var(--text-warning); }

	.ratel-collapsible-title {
		flex: 1;
		font-size: 12px;
		font-family: var(--font-monospace);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ratel-collapsible-arrow {
		font-size: 10px;
		opacity: 0.6;
		transition: transform 0.2s;
	}

	.ratel-collapsible-arrow-collapsed {
		transform: rotate(-90deg);
	}

	.ratel-collapsible-body {
		padding: 8px 10px;
		font-size: 11.5px;
		line-height: 1.5;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-collapsible-arrow { transition: none; }
	}
</style>
```

- [ ] **Step 2: svelte-check 确认编译通过**

Run: `npx svelte-check --tsconfig tsconfig.json`
Expected: 0 errors

- [ ] **Step 3: 提交**

```bash
git add src/ui/components/Collapsible.svelte
git commit -m "feat(components): 新增 Collapsible 通用折叠容器

通过 slot + prop 控制样式,供 ThinkSegment 与 ToolSegment 共用。
支持图标、标题、左边框颜色、初始展开状态。"
```

---

## Task 10: TextSegment + SearchResults 组件

**Files:**
- Create: `src/ui/chat/message-stream/TextSegment.svelte`
- Create: `src/ui/chat/message-stream/SearchResults.svelte`

- [ ] **Step 1: 写 TextSegment**

```svelte
<!-- src/ui/chat/message-stream/TextSegment.svelte -->
<!--
	@file src/ui/chat/message-stream/TextSegment.svelte
	@description 文本段渲染 — 助手文本走 MarkdownView,用户文本走纯文本
	@module ui/chat/message-stream/TextSegment
-->
<script lang="ts">
	import MarkdownView from '../components/MarkdownView.svelte';

	let {
		text,
		isUser = false,
		streaming = false,
	}: {
		text: string;
		isUser?: boolean;
		streaming?: boolean;
	} = $props();
</script>

{#if isUser}
	<div class="ratel-text-segment ratel-text-user">{text}</div>
{:else}
	<MarkdownView content={text} {streaming} />
{/if}

<style>
	.ratel-text-segment {
		font-size: 13.5px;
		line-height: 1.5;
	}

	.ratel-text-user {
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
```

- [ ] **Step 2: 写 SearchResults**

```svelte
<!-- src/ui/chat/message-stream/SearchResults.svelte -->
<!--
	@file src/ui/chat/message-stream/SearchResults.svelte
	@description 搜索结果引用列表 — search.result 事件触发渲染
	@module ui/chat/message-stream/SearchResults
-->
<script lang="ts">
	let {
		results,
		reranked = false,
	}: {
		results: Array<{ docId: string; score: number; path: string; index: number }>;
		reranked?: boolean;
	} = $props();
</script>

{#if results.length > 0}
	<div class="ratel-search">
		<div class="ratel-search-hdr">
			<span class="ratel-search-icon">🔍</span>
			搜索结果
			{#if reranked}
				<span class="ratel-search-badge">✨ 精排</span>
			{/if}
		</div>
		{#each results as r}
			<div class="ratel-search-row">
				<span class="ratel-search-idx">[{r.index}]</span>
				<span class="ratel-search-path">{r.path}</span>
				<span class="ratel-search-score">{r.score.toFixed(3)}</span>
			</div>
		{/each}
	</div>
{/if}

<style>
	.ratel-search {
		margin-bottom: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--background-tertiary);
		font-size: 12px;
	}

	.ratel-search-hdr {
		font-weight: 600;
		margin-bottom: 4px;
		color: var(--text-muted);
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.ratel-search-icon { font-size: 0.9em; }

	.ratel-search-badge {
		margin-left: 4px;
		padding: 1px 6px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--text-warning) 12%, transparent);
		color: var(--text-warning);
		font-size: 10px;
		font-weight: 500;
	}

	.ratel-search-row {
		display: flex;
		gap: 6px;
		align-items: center;
		padding: 2px 0;
	}

	.ratel-search-idx {
		font-family: var(--font-monospace);
		font-weight: 600;
		color: var(--text-muted);
		min-width: 24px;
		flex-shrink: 0;
	}

	.ratel-search-path {
		flex: 1;
		font-family: var(--font-monospace);
		font-size: 11px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-normal);
	}

	.ratel-search-score {
		font-family: var(--font-monospace);
		color: var(--text-faint);
		font-size: 10px;
		flex-shrink: 0;
	}
</style>
```

- [ ] **Step 3: svelte-check 确认编译通过**

Run: `npx svelte-check --tsconfig tsconfig.json`
Expected: 0 errors

- [ ] **Step 4: 提交**

```bash
git add src/ui/chat/message-stream/TextSegment.svelte src/ui/chat/message-stream/SearchResults.svelte
git commit -m "feat(msg-stream): 新增 TextSegment 与 SearchResults 组件

TextSegment 助手文本走 MarkdownView,用户文本走纯文本。
SearchResults 渲染 search.result 事件的引用列表,支持精排徽章。"
```

---

## Task 11: ThinkSegment 组件

**Files:**
- Create: `src/ui/chat/message-stream/ThinkSegment.svelte`

- [ ] **Step 1: 写 ThinkSegment**

```svelte
<!-- src/ui/chat/message-stream/ThinkSegment.svelte -->
<!--
	@file src/ui/chat/message-stream/ThinkSegment.svelte
	@description think 段渲染 — 可折叠思考过程,流式中默认展开,结束后折叠
	@module ui/chat/message-stream/ThinkSegment
	@depends ../components/Collapsible.svelte
-->
<script lang="ts">
	import Collapsible from '../components/Collapsible.svelte';

	let {
		text,
		streaming = false,
	}: {
		text: string;
		/** 流式中为 true,默认展开;流式结束后外部改为 false,触发折叠 */
		streaming?: boolean;
	} = $props();

	// 关键路径:流式中默认展开,结束后折叠(用户仍可手动展开)
	let expanded = $state(streaming);

	// 关键路径:streaming 从 true→false 时自动折叠
	$effect(() => {
		if (!streaming) {
			expanded = false;
		}
	});
</script>

<Collapsible
	title={streaming ? `思考过程…(${text.length} 字)` : `思考过程 (${text.length} 字)`}
	icon="💭"
	iconClass="think"
	accentColor="var(--text-warning)"
	defaultExpanded={expanded}
>
	<div class="ratel-think-content" class:ratel-think-streaming={streaming}>
		{text}
	</div>
</Collapsible>

<style>
	.ratel-think-content {
		font-size: 12px;
		color: var(--text-muted);
		white-space: pre-wrap;
		word-break: break-word;
		font-family: var(--font-monospace);
	}

	.ratel-think-streaming {
		color: var(--text-normal);
	}

	.ratel-think-streaming::after {
		content: '▋';
		animation: ratel-think-blink 1s infinite;
		color: var(--text-warning);
	}

	@keyframes ratel-think-blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-think-streaming::after { animation: none; }
	}
</style>
```

- [ ] **Step 2: svelte-check 确认编译通过**

Run: `npx svelte-check --tsconfig tsconfig.json`
Expected: 0 errors

- [ ] **Step 3: 提交**

```bash
git add src/ui/chat/message-stream/ThinkSegment.svelte
git commit -m "feat(msg-stream): 新增 ThinkSegment 可折叠思考段

流式中默认展开并显示光标,结束后自动折叠。用户可手动展开。
复用 Collapsible 通用组件,左边框用 --text-warning。"
```

---

## Task 12: ToolSegment 组件

**Files:**
- Create: `src/ui/chat/message-stream/ToolSegment.svelte`

- [ ] **Step 1: 写 ToolSegment**

```svelte
<!-- src/ui/chat/message-stream/ToolSegment.svelte -->
<!--
	@file src/ui/chat/message-stream/ToolSegment.svelte
	@description 工具段渲染 — 可折叠,折叠态显示 displayName + 结果摘要,展开态显示 args/result
	@module ui/chat/message-stream/ToolSegment
	@depends ../components/Collapsible.svelte
-->
<script lang="ts">
	import Collapsible from '../components/Collapsible.svelte';
	import type { ToolCallEntry } from './types';

	let { toolCall }: { toolCall: ToolCallEntry } = $props();

	// 关键路径:calling 状态默认展开(让用户看到正在执行),done/failed 默认折叠
	let defaultExpanded = toolCall.status === 'calling';

	function formatResult(result: unknown): string {
		if (Array.isArray(result)) return `找到 ${result.length} 项`;
		if (typeof result === 'string') return result.length > 60 ? result.slice(0, 60) + '…' : result;
		if (result && typeof result === 'object') {
			const json = JSON.stringify(result);
			return json.length > 60 ? json.slice(0, 60) + '…' : json;
		}
		return String(result);
	}

	function icon(): string {
		if (toolCall.status === 'calling') return '';
		if (toolCall.status === 'failed') return '✗';
		return '✓';
	}

	function iconClass(): string {
		if (toolCall.status === 'failed') return 'failed';
		if (toolCall.status === 'done') return 'done';
		return '';
	}

	function accent(): string {
		if (toolCall.status === 'failed') return 'var(--text-error)';
		if (toolCall.status === 'done') return 'var(--text-success)';
		return 'var(--text-warning)';
	}

	function title(): string {
		const summary = toolCall.status === 'failed'
			? toolCall.errorMessage ?? '失败'
			: toolCall.status === 'done' && toolCall.result != null
				? `— ${formatResult(toolCall.result)}`
				: '';
		return `${toolCall.displayName} ${summary}`.trim();
	}

	function prettyArgs(): string {
		try {
			return JSON.stringify(toolCall.args, null, 2);
		} catch {
			return String(toolCall.args);
		}
	}

	function prettyResult(): string {
		if (toolCall.result == null) return '(无结果)';
		try {
			return JSON.stringify(toolCall.result, null, 2);
		} catch {
			return String(toolCall.result);
		}
	}
</script>

<Collapsible
	title={title()}
	icon={icon()}
	iconClass={iconClass()}
	accentColor={accent()}
	{defaultExpanded}
>
	{#if toolCall.status === 'calling'}
		<div class="ratel-tool-calling">
			<span class="ratel-tool-dot"></span>
			执行中…
		</div>
	{/if}
	<div class="ratel-tool-section">
		<div class="ratel-tool-label">参数</div>
		<pre class="ratel-tool-pre">{prettyArgs()}</pre>
	</div>
	{#if toolCall.result != null}
		<div class="ratel-tool-section">
			<div class="ratel-tool-label">结果</div>
			<pre class="ratel-tool-pre">{prettyResult()}</pre>
		</div>
	{/if}
	{#if toolCall.status === 'failed' && toolCall.errorMessage}
		<div class="ratel-tool-err">{toolCall.errorMessage}</div>
	{/if}
</Collapsible>

<style>
	.ratel-tool-calling {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-warning);
		font-size: 11px;
		margin-bottom: 6px;
	}

	.ratel-tool-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-warning);
		animation: ratel-tool-pulse 1.2s infinite;
		flex-shrink: 0;
	}

	@keyframes ratel-tool-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.ratel-tool-section {
		margin-bottom: 8px;
	}

	.ratel-tool-section:last-child {
		margin-bottom: 0;
	}

	.ratel-tool-label {
		font-size: 10px;
		color: var(--text-faint);
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 4px;
	}

	.ratel-tool-pre {
		margin: 0;
		font-family: var(--font-monospace);
		font-size: 11px;
		color: var(--text-muted);
		white-space: pre-wrap;
		word-break: break-all;
	}

	.ratel-tool-err {
		margin-top: 6px;
		padding: 4px 6px;
		border-radius: 4px;
		background: color-mix(in srgb, var(--text-error) 10%, transparent);
		color: var(--text-error);
		font-size: 11px;
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-tool-dot { animation: none; }
	}
</style>
```

- [ ] **Step 2: svelte-check 确认编译通过**

Run: `npx svelte-check --tsconfig tsconfig.json`
Expected: 0 errors

- [ ] **Step 3: 提交**

```bash
git add src/ui/chat/message-stream/ToolSegment.svelte
git commit -m "feat(msg-stream): 新增 ToolSegment 可折叠工具段

折叠态显示 ✓/✗ + displayName + 结果摘要,展开态显示格式化 args/result。
calling 状态默认展开并显示 pulse 动画,done/failed 默认折叠。
复用 Collapsible 通用组件,左边框按状态区分颜色。"
```

---

## Task 13: MessageBubble + MessageList 组件

**Files:**
- Create: `src/ui/chat/message-stream/MessageBubble.svelte`
- Create: `src/ui/chat/message-stream/MessageList.svelte`

- [ ] **Step 1: 写 MessageBubble**

```svelte
<!-- src/ui/chat/message-stream/MessageBubble.svelte -->
<!--
	@file src/ui/chat/message-stream/MessageBubble.svelte
	@description 单条消息渲染 — 按 segments 顺序委托各 Segment 组件
	@module ui/chat/message-stream/MessageBubble
	@depends ./TextSegment, ./ThinkSegment, ./ToolSegment, ./SearchResults
-->
<script lang="ts">
	import type { Message } from './types';
	import TextSegment from './TextSegment.svelte';
	import ThinkSegment from './ThinkSegment.svelte';
	import ToolSegment from './ToolSegment.svelte';
	import SearchResults from './SearchResults.svelte';

	let {
		msg,
		isLast,
		isRunning,
	}: {
		msg: Message;
		isLast: boolean;
		isRunning: boolean;
	} = $props();

	// 关键路径:最后一条助手消息在 running 时,think 段为流式
	function thinkStreaming(): boolean {
		return isLast && isRunning && msg.role === 'assistant';
	}
</script>

<div class="ratel-msg" class:ratel-msg-user={msg.role === 'user'} class:ratel-msg-assistant={msg.role === 'assistant'}>
	{#if msg.attachments && msg.attachments.length > 0}
		<div class="ratel-msg-imgs">
			{#each msg.attachments as att}
				<img class="ratel-msg-img" src="data:{att.mimeType};base64,{att.base64}" alt={att.fileName} title={att.fileName} />
			{/each}
		</div>
	{/if}

	{#each msg.segments as seg}
		{#if seg.type === 'text'}
			<TextSegment text={seg.text} isUser={msg.role === 'user'} streaming={isLast && isRunning && msg.role === 'assistant'} />
		{:else if seg.type === 'think'}
			<ThinkSegment text={seg.text} streaming={thinkStreaming()} />
		{:else if seg.type === 'tool'}
			<ToolSegment toolCall={seg.toolCall} />
		{/if}
	{/each}

	{#if msg.searchResults && msg.searchResults.length > 0}
		<SearchResults results={msg.searchResults} reranked={msg.searchReranked ?? false} />
	{/if}

	{#if msg.chatError}
		<div class="ratel-err">
			<div class="ratel-err-msg">{msg.chatError.message}</div>
			{#if msg.chatError.suggestion}
				<div class="ratel-err-sug">{msg.chatError.suggestion}</div>
			{/if}
		</div>
	{/if}

	{#if msg.cancelled}
		<div class="ratel-cancelled">已停止生成</div>
	{/if}
</div>

<style>
	.ratel-msg {
		max-width: 88%;
	}

	.ratel-msg-user {
		align-self: flex-end;
		padding: 10px 13px;
		border-radius: 8px;
		background: var(--background-tertiary);
	}

	.ratel-msg-assistant {
		align-self: flex-start;
		padding: 0;
		background: transparent;
	}

	.ratel-msg-imgs {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-bottom: 8px;
	}

	.ratel-msg-img {
		width: 96px;
		height: 96px;
		object-fit: cover;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
	}

	.ratel-err {
		margin-top: 8px;
		padding: 8px 10px;
		border-radius: 6px;
		background: color-mix(in srgb, var(--text-error) 10%, transparent);
		color: var(--text-error);
		font-size: 11.5px;
		line-height: 1.4;
	}

	.ratel-err-msg { font-weight: 600; }
	.ratel-err-sug { margin-top: 4px; color: var(--text-muted); }

	.ratel-cancelled {
		margin-top: 8px;
		font-size: 11.5px;
		color: var(--text-muted);
		font-style: italic;
	}
</style>
```

- [ ] **Step 2: 写 MessageList**

```svelte
<!-- src/ui/chat/message-stream/MessageList.svelte -->
<!--
	@file src/ui/chat/message-stream/MessageList.svelte
	@description 消息流渲染 — 遍历 Message[] 委托 MessageBubble,含思考指示器
	@module ui/chat/message-stream/MessageList
	@depends ./MessageBubble, ./types
-->
<script lang="ts">
	import type { Message } from './types';
	import MessageBubble from './MessageBubble.svelte';

	let {
		messages,
		isRunning,
	}: {
		messages: Message[];
		isRunning: boolean;
	} = $props();

	// 关键路径:思考指示器 — 仅在 LLM 空窗期(无内容且无 calling 工具)显示。
	function showThinking(): boolean {
		if (!isRunning || messages.length === 0) return false;
		const last = messages[messages.length - 1]!;
		if (last.role !== 'assistant') return false;
		// segments 为空,或全部为空 text 段
		const hasContent = last.segments.some(
			(s) => s.type === 'text' && s.text !== '' || s.type === 'think' && s.text !== '' || s.type === 'tool',
		);
		if (hasContent) return false;
		// 有 calling 状态的工具段时不显示(tool 段自身有 pulse)
		const hasCallingTool = last.segments.some(
			(s) => s.type === 'tool' && s.toolCall.status === 'calling',
		);
		return !hasCallingTool;
	}
</script>

<div class="ratel-messages" bind:this={undefined}>
	{#each messages as msg, i}
		<MessageBubble {msg} isLast={i === messages.length - 1} {isRunning} />
	{/each}
	{#if showThinking()}
		<div class="ratel-typing">
			<span class="ratel-typing-dot"></span>
			思考中…
		</div>
	{/if}
</div>

<style>
	.ratel-messages {
		flex: 1;
		overflow-y: auto;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.ratel-typing {
		color: var(--text-warning);
		font-size: 12px;
		padding: 4px 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.ratel-typing-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--text-warning);
		animation: ratel-pulse 1.2s infinite;
		flex-shrink: 0;
	}

	@keyframes ratel-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (prefers-reduced-motion: reduce) {
		.ratel-typing-dot { animation: none; }
	}
</style>
```

- [ ] **Step 3: svelte-check 确认编译通过**

Run: `npx svelte-check --tsconfig tsconfig.json`
Expected: 0 errors

- [ ] **Step 4: 提交**

```bash
git add src/ui/chat/message-stream/MessageBubble.svelte src/ui/chat/message-stream/MessageList.svelte
git commit -m "feat(msg-stream): 新增 MessageBubble 与 MessageList 组件

MessageBubble 按 segments 顺序委托 TextSegment/ThinkSegment/ToolSegment
渲染,含附件预览、搜索结果、错误与取消状态。MessageList 遍历 Message[]
并显示空窗期思考指示器。"
```

---

## Task 14: ChatView.svelte 重构为 segments 编排层

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`(全面重构:事件循环 + 模板)

- [ ] **Step 1: 重写 ChatView.svelte script 区**

把 `src/ui/chat/ChatView.svelte` 的 `<script lang="ts">` 区替换为(保留文件头注释,更新 @file 路径与 @depends):

```typescript
<script lang="ts">
	/**
	 * @file src/ui/chat/ChatView.svelte
	 * @description Chat 编排层 — 状态持有 + 事件循环 + 子组件编排(~200 行)
	 * @module ui/chat/ChatView
	 * @depends main, ./message-stream/MessageList, ../status/StatusLine, ../status/StatusDrawer, ./input/SlashMenu, ./input/AttachmentStrip
	 */
	import type RatelVaultPlugin from '../../main';
	import { get } from 'svelte/store';
	import StatusLine from '../status/StatusLine.svelte';
	import StatusDrawer from '../status/StatusDrawer.svelte';
	import SlashMenu from './input/SlashMenu.svelte';
	import AttachmentStrip from './input/AttachmentStrip.svelte';
	import MessageList from './message-stream/MessageList.svelte';
	import type { Message } from './message-stream/types';
	import {
		appendText, appendThink, appendToolCall, attachToolResult, markToolFailed,
	} from './message-stream/segment-appender';
	import { filterCommands, type SlashCommand } from './input/slash-commands';
	import { validateAttachment, estimateImageTokens } from './input/attachment-utils';
	import { evaluateChatSendGate } from './chat-send-gate';
	import { hasChatApiKey } from '../../secrets/ratel-secrets';
	import { formatChatError, type DiagError } from './chat-error';
	import { showCompactConfirm } from './compact-confirm';
	import { devLogger } from '../../logging/dev-logger';
	import { formatToolDisplayName } from './format-tool-display';

	let { plugin }: { plugin: RatelVaultPlugin } = $props();

	// ==================== 响应式状态 ====================
	let messages = $state<Message[]>([]);
	let input = $state('');
	let isRunning = $state(false);
	let sessionId = $state('session-' + Date.now());
	let drawerExpanded = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let slashMenuEl = $state<{ handleKeydown: (e: KeyboardEvent) => boolean } | null>(null);
	let messagesEl = $state<HTMLDivElement | null>(null);

	const statusStore = plugin.userStatus.statusBar$;
	const contextStore = plugin.userStatus.contextUsage$;
	const attachmentStore = plugin.userStatus.pendingAttachments$;

	let keyTick = $state(0);
	const hasKey = $derived.by(() => { keyTick; return hasChatApiKey(plugin.app, plugin.settings); });
	const gate = $derived.by(() => {
		keyTick;
		return evaluateChatSendGate(plugin.settings, $statusStore, { hasChatApiKey: hasKey });
	});
	const slashVisible = $derived.by(() => {
		const v = input.startsWith('/') && !input.includes(' ');
		if (!v) return false;
		return filterCommands(input).length > 0;
	});
	const modelName = $derived(plugin.settings.chatModel);

	// ==================== 工具函数 ====================
	function refreshKeyState() {
		plugin.rebuildLLM();
		keyTick++;
	}

	function handleAgentError(am: Message, code: string, message: string, toolName?: string) {
		if (code === 'CANCELLED') { am.cancelled = true; return; }
		if (code === 'TOOL_ERROR' || code === 'TOOL_DENIED' || code === 'INDEX_NOT_READY') {
			if (toolName) {
				markToolFailed(am, toolName, message);
				return;
			}
		}
		am.chatError = formatChatError(code, message);
	}

	// ==================== 斜杠命令 ====================
	function executeSlashCommand(cmd: SlashCommand) {
		input = '';
		switch (cmd.name) {
			case '/new':
				messages = [];
				sessionId = 'session-' + Date.now();
				plugin.userStatus.patchContextUsage({ usedTokens: 0 });
				plugin.userStatus.clearAttachments();
				break;
			case '/compact': handleCompact(); break;
			case '/model':
				(plugin.app as unknown as { setting: { open: () => void } }).setting.open();
				break;
			case '/reindex':
				plugin.indexController.reindex().catch((err) => devLogger.error('index', '/reindex 失败', err));
				break;
		}
	}

	async function handleCompact() {
		const confirmed = await showCompactConfirm(plugin.app);
		if (!confirmed) return;
		messages = messages.slice(-2);
	}

	// ==================== 发送消息 ====================
	async function sendMessage() {
		refreshKeyState();
		const text = input.trim();
		if (!text || isRunning) return;

		const currentGate = evaluateChatSendGate(plugin.settings, get(statusStore), {
			hasChatApiKey: hasChatApiKey(plugin.app, plugin.settings),
		});
		if (!currentGate.canSend) return;

		const currentAttachments = get(attachmentStore).map((a) => ({
			fileName: a.fileName, mimeType: a.mimeType, base64: a.base64,
		}));

		// 关键路径:用 push + 从数组中取出 Proxy 引用,触发细粒度 DOM 更新
		messages.push({
			role: 'user' as const,
			segments: [{ type: 'text', text }],
			attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
		});
		messages.push({ role: 'assistant' as const, segments: [] });
		const am = messages[messages.length - 1] as Message;

		input = '';
		isRunning = true;
		plugin.userStatus.patch({ model: 'checking' });
		const ac = new AbortController();
		let lastToolName: string | undefined;
		const scrollToBottom = () => {
			requestAnimationFrame(() => { if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight; });
		};
		scrollToBottom();

		try {
			const events = plugin.ask(sessionId, text, ac.signal);
			abortController = ac;
			for await (const event of events) {
				switch (event.type) {
					case 'message.delta':
						if (event.payload.reasoning) {
							appendThink(am, event.payload.reasoning);
						} else if (event.payload.text) {
							appendText(am, event.payload.text);
						}
						scrollToBottom();
						break;
					case 'tool.call':
						lastToolName = event.payload.name;
						appendToolCall(am, {
							name: event.payload.name,
							displayName: formatToolDisplayName(event.payload.name, event.payload.args),
							args: event.payload.args,
							status: 'calling',
							startAt: Date.now(),
						});
						scrollToBottom();
						break;
					case 'tool.result':
						attachToolResult(am, event.payload.name, event.payload.result);
						scrollToBottom();
						break;
					case 'search.result':
						am.searchResults = event.payload.results;
						am.searchReranked = event.payload.reranked;
						scrollToBottom();
						break;
					case 'message.end':
						if (event.payload.promptTokens && event.payload.completionTokens) {
							am.tokenUsage = {
								promptTokens: event.payload.promptTokens,
								completionTokens: event.payload.completionTokens,
							};
						}
						break;
					case 'error':
						handleAgentError(am, event.payload.code, event.payload.message, lastToolName);
						break;
				}
			}
		} catch (err) {
			if (ac.signal.aborted) { am.cancelled = true; }
			else {
				const message = err instanceof Error ? err.message : String(err);
				handleAgentError(am, 'LLM_ERROR', message);
			}
		} finally {
			isRunning = false;
			abortController = null;
			plugin.userStatus.patch({ model: 'ready' });
			plugin.userStatus.clearAttachments();
			scrollToBottom();
		}
	}

	let abortController: AbortController | null = null;
	function stopGeneration() { abortController?.abort(); }

	// ==================== 键盘 / 文件 ====================
	function handleKeydown(e: KeyboardEvent) {
		if (slashVisible && slashMenuEl) { if (slashMenuEl.handleKeydown(e)) return; }
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			const trimmed = input.trim();
			const exactMatch = filterCommands(trimmed).find((c) => c.name === trimmed);
			if (exactMatch) { executeSlashCommand(exactMatch); return; }
			sendMessage();
		}
	}

	function triggerFileInput() { fileInput?.click(); }

	async function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		if (!target.files || target.files.length === 0) return;
		const file = target.files[0]!;
		target.value = '';
		const currentCount = get(attachmentStore).length;
		const vr = validateAttachment(file, currentCount);
		if (!vr.ok) { input = `[附件错误] ${vr.reason}`; return; }
		const { width, height } = await readImageDimensions(file);
		const estimatedTokens = estimateImageTokens(width, height);
		const base64 = await fileToBase64(file);
		plugin.userStatus.addAttachment({ fileName: file.name, mimeType: file.type, base64, estimatedTokens });
	}

	function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
		return new Promise((resolve) => {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(url); };
			img.onerror = () => { resolve({ width: 0, height: 0 }); URL.revokeObjectURL(url); };
			img.src = url;
		});
	}

	function fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => { const result = reader.result as string; resolve(result.split(',')[1] ?? ''); };
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}
</script>
```

- [ ] **Step 2: 重写 ChatView.svelte 模板区**

把 `<div class="ratel-chat">` 开始到 `</div>` 结束(含 style)替换为:

```svelte
<div class="ratel-chat">
	<div class="ratel-header">
		<span class="ratel-header-title">Ratel</span>
		<span class="ratel-header-badge">{modelName}</span>
	</div>

	<div class="ratel-messages-wrap" bind:this={messagesEl}>
		<MessageList {messages} {isRunning} />
	</div>

	<StatusLine
		status$={statusStore}
		contextUsage$={contextStore}
		expanded={drawerExpanded}
		onToggle={() => (drawerExpanded = !drawerExpanded)}
	/>

	<StatusDrawer
		expanded={drawerExpanded}
		status$={statusStore}
		contextUsage$={contextStore}
		pendingAttachments$={attachmentStore}
		onCompact={handleCompact}
	/>

	<div class="ratel-input">
		{#if gate.hardBlockReason}
			<div class="ratel-gate ratel-gate-hard">{gate.hardBlockReason}</div>
		{:else if gate.softHint}
			<div class="ratel-gate">{gate.softHint}</div>
		{/if}

		<AttachmentStrip
			pendingAttachments$={attachmentStore}
			onRemove={(id) => plugin.userStatus.removeAttachment(id)}
		/>

		{#if slashVisible}
			<div class="ratel-slash-wrap">
				<SlashMenu
					bind:this={slashMenuEl}
					input={input}
					onSelect={executeSlashCommand}
					onClose={() => { input = ''; }}
				/>
			</div>
		{/if}

		<div class="ratel-input-row">
			<button class="ratel-plus-btn" type="button" onclick={triggerFileInput} aria-label="添加图片" disabled={isRunning}>+</button>
			<input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onchange={handleFileSelect} style="display:none;" />
			<textarea
				bind:value={input}
				onkeydown={handleKeydown}
				onfocus={refreshKeyState}
				placeholder="输入 / 查看命令,或直接提问…"
				disabled={isRunning || !gate.canSend}
				rows={1}
			></textarea>
		</div>
		<div class="ratel-input-footer">
			{#if isRunning}
				<button class="ratel-send ratel-stop" onclick={stopGeneration}>Stop</button>
			{:else}
				<button class="ratel-send" onclick={sendMessage} disabled={!input.trim() || !gate.canSend}>Send</button>
			{/if}
		</div>
	</div>
</div>

<style>
	* { box-sizing: border-box; }

	.ratel-chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		font-size: 13.5px;
		line-height: 1.5;
		color: var(--text-normal);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
	}

	.ratel-header {
		flex-shrink: 0;
		padding: 10px 14px;
		border-bottom: 1px solid var(--background-modifier-border);
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.ratel-header-title { font-size: 13px; font-weight: 600; color: var(--text-normal); }

	.ratel-header-badge {
		font-size: 11px;
		font-family: var(--font-monospace);
		padding: 2px 8px;
		border-radius: 12px;
		background: color-mix(in srgb, var(--text-success) 15%, transparent);
		color: var(--text-success);
	}

	.ratel-messages-wrap {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.ratel-gate { font-size: 11px; color: var(--text-warning); margin-bottom: 8px; }
	.ratel-gate-hard { color: var(--text-error); }

	.ratel-input {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
		border-top: 1px solid var(--background-modifier-border);
		padding: 10px 14px 14px;
		position: relative;
	}

	.ratel-slash-wrap {
		position: absolute;
		bottom: 100%;
		left: 14px;
		right: 14px;
		margin-bottom: 4px;
		z-index: 20;
	}

	.ratel-input-row { display: flex; align-items: flex-end; gap: 8px; }

	.ratel-plus-btn {
		width: 32px; height: 32px; flex-shrink: 0;
		border-radius: 6px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-secondary);
		color: var(--text-muted);
		font-size: 16px; line-height: 1;
		cursor: pointer;
		display: flex; align-items: center; justify-content: center;
		padding: 0;
		transition: color 0.15s;
		box-shadow: none;
		-webkit-appearance: none; appearance: none;
		font-family: inherit;
	}
	.ratel-plus-btn:hover { color: var(--text-normal); }
	.ratel-plus-btn:disabled { opacity: 0.5; cursor: not-allowed; }

	.ratel-input-row textarea {
		flex: 1;
		min-height: 54px; max-height: 160px;
		padding: 10px 12px;
		border-radius: 8px;
		border: 1px solid var(--background-modifier-border);
		background: var(--background-modifier-form-field);
		color: var(--text-normal);
		font-family: inherit; font-size: 13px; line-height: 1.5;
		resize: none; outline: none;
		transition: border-color 0.15s;
		overflow-y: auto;
	}
	.ratel-input-row textarea:focus { border-color: var(--interactive-accent); }
	.ratel-input-row textarea::placeholder { color: var(--text-faint); }

	.ratel-input-footer { display: flex; justify-content: flex-end; margin-top: 4px; }

	.ratel-send {
		padding: 6px 16px;
		border-radius: 6px;
		border: none;
		background: var(--text-success);
		color: var(--background-primary);
		font-size: 12px; font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		transition: opacity 0.15s;
		box-shadow: none;
		-webkit-appearance: none; appearance: none;
	}
	.ratel-send:disabled { opacity: 0.4; cursor: not-allowed; }
	.ratel-stop { background: var(--text-error) !important; color: #fff !important; }
</style>
```

- [ ] **Step 3: svelte-check 确认编译通过**

Run: `npx svelte-check --tsconfig tsconfig.json`
Expected: 0 errors

- [ ] **Step 4: 全量构建**

Run: `npm run build`
Expected: 成功

- [ ] **Step 5: 运行全量测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add src/ui/chat/ChatView.svelte
git commit -m "refactor(chat): ChatView 重构为 segments 编排层

事件循环改用 segment-appender 追加 text/think/tool 段,模板委托
MessageList/MessageBubble 渲染。移除内联 content/toolCalls 模型与
formatToolResult/refreshContextUsage 等下沉逻辑。从 ~600 行瘦身到
~200 行编排层。支持 think 块渲染与工具详情展开。"
```

---

## Task 15: context-manager 用 estimateTokens 替代 length/4

**Files:**
- Modify: `src/core/context-manager.ts`(tokenCount L254-258, trimHistory L235-236, getContextUsage L279-280)
- Test: `tests/core/context-manager-usage.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/core/context-manager-usage.test.ts` 末尾追加:

```typescript
	it('getContextUsage - 中文文本 - 用 estimateTokens 而非 length/4', async () => {
		const persistence = createMockPersistence();
		const ctx = new ContextManager(persistence);
		await ctx.load('s1');
		ctx.addUserMessage('你好世界测试'); // 6 个 CJK
		const usage = ctx.getContextUsage(1000, 0, 'direct');
		// estimateTokens: 6/1.5 = 4;length/4 会给出 2(6/4=1.5→ceil=2)
		expect(usage.usedTokens).toBe(4);
	});
```

若 `createMockPersistence` 未在该文件定义,从 `tests/core/context-manager.test.ts` 复制 helper 或 import。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/context-manager-usage.test.ts`
Expected: FAIL — 旧算法给出 2,新算法期望 4

- [ ] **Step 3: 修改 context-manager**

在 `src/core/context-manager.ts` 顶部加 import:

```typescript
import { estimateTokens } from '../ui/tokens/token-estimator';
```

把 `trimHistory` 内的 `estimateTokens` 局部函数(L235-236)改为调用导入的 `estimateTokens`:

```typescript
private trimHistory(messages: ChatMessage[]): ChatMessage[] {
	if (messages.length <= 1) return messages;
	const countTokens = (msgs: ChatMessage[]): number =>
		estimateTokens(msgs.map((m) => m.content).join(''));
	const tokens = countTokens(messages);
	if (tokens <= this.maxHistoryTokens) return messages;
	const trimmed = [...messages];
	while (trimmed.length > 1 && countTokens(trimmed) > this.maxHistoryTokens) {
		trimmed.shift();
	}
	return trimmed;
}
```

把 `tokenCount()`(L254-258)改为:

```typescript
tokenCount(): number {
	const text = this.toMessages().map((m) => m.content).join('');
	return estimateTokens(text);
}
```

把 `getContextUsage()`(L279-280)内的 `usedTokens` 计算改为:

```typescript
const text = this.toMessages(intent).map((m) => m.content).join('');
const usedTokens = estimateTokens(text);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/context-manager-usage.test.ts tests/core/context-manager.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/context-manager.ts tests/core/context-manager-usage.test.ts
git commit -m "feat(context): tokenCount/trimHistory/getContextUsage 用 estimateTokens

替代 text.length/4 粗估,中英混合语料偏差降低。中文按 1.5 字符/token、
英文按 4 字符/token 分权重求和。真值仍由 message.end 的 API usage 校准。"
```

---

## Task 16: ContextUsage 加 source 字段

**Files:**
- Modify: `src/user-feedback/user-status.ts`(ContextUsage 接口)

- [ ] **Step 1: 修改 ContextUsage 接口**

在 `src/user-feedback/user-status.ts` 的 `ContextUsage` 接口加可选 `source` 字段:

```typescript
export interface ContextUsage {
	usedTokens: number;
	maxTokens: number;
	attachmentTokens: number;
	percentage: number;
	/** 数据来源,用于 StatusLine 样式区分(可选,旧调用方不传等同 'estimate') */
	source?: 'estimate' | 'streaming' | 'api';
}
```

- [ ] **Step 2: 类型检查确认编译通过**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 无新增错误(可选字段,向后兼容)

- [ ] **Step 3: 运行现有 user-status 测试确认无回归**

Run: `npx vitest run tests/user-feedback/user-status.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/user-feedback/user-status.ts
git commit -m "feat(user-status): ContextUsage 加可选 source 字段

标记数据来源(estimate/streaming/api),供 StatusLine/StatusDrawer 区分
token 统计的可信度。可选字段,向后兼容旧调用方。"
```

---

## Task 17: ChatView token 三层校准接线

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`(sendMessage 事件循环 + send 前 + message.end)

- [ ] **Step 1: 在 ChatView script 区加 import 与 send 前估算**

在 `src/ui/chat/ChatView.svelte` 的 import 区加:

```typescript
import { estimateTokens } from '../tokens/token-estimator';
```

在 `sendMessage()` 函数内,`messages.push(...)` 之前加 send 前估算(第 1 层):

```typescript
// 第 1 层:send 前精确估算
const baselineUsed = messages.reduce(
	(sum, m) => sum + m.segments.reduce(
		(s, seg) => s + (seg.type === 'text' ? estimateTokens(seg.text) : seg.type === 'think' ? estimateTokens(seg.text) : 0),
		0,
	),
	0,
);
const attachmentTokens = get(attachmentStore).reduce((s, a) => s + a.estimatedTokens, 0);
plugin.userStatus.patchContextUsage({
	usedTokens: baselineUsed,
	maxTokens: plugin.settings.chatModelMaxTokens,
	attachmentTokens,
	source: 'estimate',
});
```

- [ ] **Step 2: 在 message.delta 事件加流式累计(第 2 层)**

在 `sendMessage()` 的事件循环 `case 'message.delta':` 分支内,追加流式 token 累计:

```typescript
case 'message.delta':
	if (event.payload.reasoning) {
		appendThink(am, event.payload.reasoning);
		streamingUsed += estimateTokens(event.payload.reasoning);
	} else if (event.payload.text) {
		appendText(am, event.payload.text);
		streamingUsed += estimateTokens(event.payload.text);
	}
	plugin.userStatus.patchContextUsage({
		usedTokens: baselineUsed + streamingUsed,
		source: 'streaming',
	});
	scrollToBottom();
	break;
```

在 `sendMessage()` 函数顶部(try 块之前)声明 `streamingUsed`:

```typescript
let streamingUsed = 0;
```

- [ ] **Step 3: 在 message.end 事件加 API 真值校准(第 3 层)**

修改 `case 'message.end':` 分支:

```typescript
case 'message.end':
	if (event.payload.promptTokens && event.payload.completionTokens) {
		am.tokenUsage = {
			promptTokens: event.payload.promptTokens,
			completionTokens: event.payload.completionTokens,
		};
		plugin.userStatus.patchContextUsage({
			usedTokens: event.payload.promptTokens + event.payload.completionTokens,
			source: 'api',
		});
	}
	break;
```

- [ ] **Step 4: svelte-check + 构建确认**

Run: `npx svelte-check --tsconfig tsconfig.json && npm run build`
Expected: 0 errors,构建成功

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/ChatView.svelte
git commit -m "feat(chat): token 三层校准接线

send 前用 estimateTokens 精确估算(source=estimate),流式中累计 delta
token(source=streaming),message.end 用 API 真值覆盖(source=api)。
source 字段供 StatusLine 后续区分样式。"
```

---

## Task 18: probe-model 模型探测

**Files:**
- Create: `src/ui/tokens/probe-model.ts`
- Test: `tests/ui/tokens/probe-model.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/ui/tokens/probe-model.test.ts
/**
 * @file tests/ui/tokens/probe-model.test.ts
 * @description probe-model 单元测试 — 测试连接 + 映射表推断
 */
import { describe, it, expect, vi } from 'vitest';

const { mockRequestUrl } = vi.hoisted(() => ({ mockRequestUrl: vi.fn() }));
vi.mock('obsidian', () => ({ requestUrl: mockRequestUrl }));

import { probeModelContextLength } from '../../../src/ui/tokens/probe-model';

describe('probeModelContextLength', () => {
	beforeEach(() => { mockRequestUrl.mockReset(); });

	it('连接成功 + 映射表命中 - 返回 contextLength', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { model: 'deepseek-chat' } });
		const result = await probeModelContextLength({
			apiBase: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat',
		});
		expect(result.contextLength).toBe(64000);
		expect(result.error).toBeUndefined();
	});

	it('连接失败 - 返回 error', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 401, text: 'unauthorized' });
		const result = await probeModelContextLength({
			apiBase: 'https://api.deepseek.com', apiKey: 'sk-bad', model: 'deepseek-chat',
		});
		expect(result.contextLength).toBeUndefined();
		expect(result.error).toBeDefined();
	});

	it('映射表未命中 - contextLength 为 undefined', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: { model: 'unknown-model' } });
		const result = await probeModelContextLength({
			apiBase: 'https://api.example.com', apiKey: 'sk-test', model: 'unknown-model',
		});
		expect(result.contextLength).toBeUndefined();
		expect(result.error).toBeUndefined();
	});

	it('模型名前缀匹配 - deepseek-reasoner 匹配 deepseek-reasoner', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		const result = await probeModelContextLength({
			apiBase: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-reasoner',
		});
		expect(result.contextLength).toBe(64000);
	});

	it('claude-3-5-sonnet 匹配 - 200000', async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		const result = await probeModelContextLength({
			apiBase: 'https://api.anthropic.com', apiKey: 'sk-test', model: 'claude-3-5-sonnet-20241022',
		});
		expect(result.contextLength).toBe(200000);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/tokens/probe-model.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 写最小实现**

```typescript
// src/ui/tokens/probe-model.ts
/**
 * @file src/ui/tokens/probe-model.ts
 * @description 测试连接 + 内置映射表推断模型 context length
 * @module ui/tokens/probe-model
 * @depends obsidian(requestUrl)
 */

import { requestUrl } from 'obsidian';

/** 内置模型 context length 映射表(常用模型) */
const MODEL_CONTEXT_MAP: Record<string, number> = {
	// DeepSeek
	'deepseek-chat': 64000,
	'deepseek-reasoner': 64000,
	// Claude
	'claude-3-5-sonnet-20241022': 200000,
	'claude-3-5-haiku-20241022': 200000,
	'claude-3-opus-20240229': 200000,
	// Ollama 常见本地模型
	'llama3.1': 128000,
	'qwen2.5': 32768,
	// OpenAI 兼容端点常见模型
	'gpt-4o': 128000,
	'gpt-4o-mini': 128000,
};

/**
 * 从映射表按前缀匹配推断 context length。
 *
 * @param model - 模型名(大小写不敏感,前缀匹配)
 * @returns 匹配到的 context length;未命中返回 undefined
 */
function lookupModelContext(model: string): number | undefined {
	const lower = model.toLowerCase();
	// 精确匹配优先
	if (MODEL_CONTEXT_MAP[lower] != null) return MODEL_CONTEXT_MAP[lower];
	// 前缀匹配(如 deepseek-chat-0628 匹配 deepseek-chat)
	for (const key of Object.keys(MODEL_CONTEXT_MAP)) {
		if (lower.startsWith(key)) return MODEL_CONTEXT_MAP[key];
	}
	return undefined;
}

/**
 * 测试连接并推断模型 context length。
 *
 * 策略:
 * 1. 发送极短请求(max_tokens=1)验证连接 + 模型有效性
 * 2. 从内置映射表按前缀匹配推断 context length
 * 3. 映射表未命中,返回 undefined,UI 提示用户手动填写
 *
 * @param config - LLM 配置(apiBase / apiKey / model)
 * @returns 推断结果:成功含 contextLength;连接失败含 error;映射未命中两者皆无
 */
export async function probeModelContextLength(config: {
	apiBase: string;
	apiKey: string;
	model: string;
}): Promise<{ contextLength?: number; error?: string }> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (config.apiKey) {
		headers['Authorization'] = `Bearer ${config.apiKey}`;
	}

	try {
		const response = await requestUrl({
			url: `${config.apiBase}/chat/completions`,
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: config.model,
				messages: [{ role: 'user', content: 'hi' }],
				max_tokens: 1,
				stream: false,
			}),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			return { error: `API 返回 ${response.status}:连接失败或模型名无效` };
		}

		// 连接成功,查映射表
		const contextLength = lookupModelContext(config.model);
		return contextLength != null ? { contextLength } : {};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: `请求失败:${message}` };
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/tokens/probe-model.test.ts`
Expected: PASS — 5 个用例全过

- [ ] **Step 5: 提交**

```bash
git add src/ui/tokens/probe-model.ts tests/ui/tokens/probe-model.test.ts
git commit -m "feat(tokens): 新增 probe-model 测试连接 + 映射表推断

发送 max_tokens=1 的极短请求验证连接,成功后按内置映射表(DeepSeek/
Claude/Ollama/OpenAI 常见模型)前缀匹配推断 context length。未命中返回
undefined,UI 提示手动填写。"
```

---

## Task 19: 设置面板"测试连接"按钮 + chatModelMaxTokens 默认 0

**Files:**
- Modify: `src/settings.ts`(DEFAULT_SETTINGS L92 + 模型配置区加按钮)

- [ ] **Step 1: 修改默认值**

在 `src/settings.ts` 的 `DEFAULT_SETTINGS`(L92)改:

```typescript
// 关键路径:0 表示未探测,StatusLine 显示"未配置"引导用户去设置面板测试连接。
chatModelMaxTokens: 0,
```

- [ ] **Step 2: 在模型配置区加"测试连接"按钮**

在 `src/settings.ts` 的 `renderSettings` 方法中,Chat 区域(API Base URL Setting 之后、secret-hint 之前)加:

```typescript
	// ==================== Context Length 探测 ====================
	new Setting(containerEl)
		.setName('Context Length')
		.setDesc('模型上下文窗口上限(token)。点击测试连接自动推断,或手动填写。')
		.addText((text) =>
			text
				.setPlaceholder('未配置')
				.setValue(
					this.plugin.settings.chatModelMaxTokens > 0
						? String(this.plugin.settings.chatModelMaxTokens)
						: '',
				)
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					this.plugin.settings.chatModelMaxTokens = isNaN(num) ? 0 : num;
					await this.plugin.saveSettings();
				}),
		)
		.addButton((btn) =>
			btn
				.setButtonText('测试连接')
				.onClick(async () => {
					btn.setButtonText('探测中…');
					btn.setDisabled(true);
					const { probeModelContextLength } = await import('./ui/tokens/probe-model');
					const result = await probeModelContextLength({
						apiBase: this.plugin.settings.chatApiBase,
						apiKey: '', // 关键路径:apiKey 从 SecretStorage 读取,设置面板不持有明文
						model: this.plugin.settings.chatModel,
					});
					btn.setButtonText('测试连接');
					btn.setDisabled(false);
					if (result.error) {
						new Notice(`✗ ${result.error}`, 5000);
					} else if (result.contextLength != null) {
						this.plugin.settings.chatModelMaxTokens = result.contextLength;
						await this.plugin.saveSettings();
						new Notice(`✓ 已探测:${result.contextLength.toLocaleString()} tokens`, 4000);
						this.display();
					} else {
						new Notice('连接成功,但无法自动推断 context length,请手动填写', 5000);
					}
				}),
		);
```

在 `src/settings.ts` 顶部 import 区加:

```typescript
import { Notice } from 'obsidian';
```

- [ ] **Step 3: 类型检查 + 构建确认**

Run: `npx tsc -noEmit -skipLibCheck && npm run build`
Expected: 0 errors,构建成功

- [ ] **Step 4: 运行现有 settings 测试确认无回归**

Run: `npx vitest run tests/settings.test.ts tests/settings-migration.test.ts tests/settings-adapter.test.ts`
Expected: PASS(若有测试断言旧默认值 32000,需同步修正为 0)

- [ ] **Step 5: 提交**

```bash
git add src/settings.ts
git commit -m "feat(settings): chatModelMaxTokens 默认 0 + 测试连接按钮

默认值从 32000 改为 0(未探测)。模型配置区加 Context Length 输入框 +
测试连接按钮,调用 probeModelContextLength 自动推断。成功填充并 Notice
提示,失败提示手动填写。"
```

---

## Task 20: 全量构建 + 测试 + STATUS.md 登记

**Files:**
- Verify: 全项目
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: 全量类型检查**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: 0 errors

- [ ] **Step 2: svelte-check**

Run: `npx svelte-check --tsconfig tsconfig.json`
Expected: 0 errors

- [ ] **Step 3: 全量构建(三产物)**

Run: `npm run build`
Expected: 成功产出 `dist/main.js`、`dist/worker.js`、`dist/embedding-worker.js`

- [ ] **Step 4: 全量测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 5: 更新 STATUS.md**

在 `docs/superpowers/STATUS.md` 的"实施 Plan"表加一行:

```markdown
| P-MSG-STREAM | [2026-06-28-chat-message-stream-redesign-implementation.md](plans/2026-06-28-chat-message-stream-redesign-implementation.md) | 🔄 In Progress | S-MSG-STREAM | 分支 `feat/s-msg-stream` |
```

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs(status): 登记 P-MSG-STREAM 为 In Progress

分支 feat/s-msg-stream,实施 S-MSG-STREAM spec。"
```

---

## 自审

### 1. Spec 覆盖度

| Spec 章节 | 覆盖 Task | 备注 |
|-----------|----------|------|
| 1.1 数据模型 | Task 3 | ✓ |
| 1.2 segment-appender | Task 4 | ✓ |
| 1.3 事件流改造 | Task 14 | ✓ |
| 1.4 消息渲染组件 | Task 9-13 | ✓ |
| 2.1 端口层扩展 | Task 5 | ✓ |
| 2.2 DeepSeek 适配器 | Task 6 | ✓ |
| 2.3 Claude 适配器 | — | **缺口:文件不存在,scope out** |
| 2.4 Agent-loop 透传 | Task 7 | ✓ |
| 3.1-3.3 UI 目录归拢 | Task 8 | ✓ |
| 4.1 token-estimator | Task 1 | ✓ |
| 4.2 三层校准 | Task 15,16,17 | ✓ |
| 4.3 probe-model | Task 18 | ✓ |
| 4.4 设置面板交互 | Task 19 | ✓ |
| 5.1-5.4 agent-loop 拆分 | Task 2,7 | ✓ |

### 2. Placeholder 扫描

- 无 TBD / TODO / "实现细节后续补充"。
- 每个 Step 含完整代码或精确命令。
- 无"类似 Task N"引用(所有代码均内联)。

### 3. 类型一致性

- `MessageSegment` 在 Task 3 定义,Task 4/11/12/13/14 引用 — 字段名一致(`type`/`text`/`toolCall`)。
- `ToolCallEntry` 在 Task 3 定义,Task 4/12/14 引用 — `status`/`displayName`/`startAt` 一致。
- `Message` 在 Task 3 定义,Task 4/13/14 引用 — `segments`/`chatError`/`searchResults` 一致。
- `ChatDelta.reasoning` / `usage` 在 Task 5 定义,Task 6/7 引用 — 一致。
- `AgentEvent.message.delta.reasoning` / `message.end.promptTokens` 在 Task 5 定义,Task 7/14/17 引用 — 一致。
- `estimateTokens` 在 Task 1 定义,Task 15/17 引用 — 签名一致。
- `mapSearchResults` 在 Task 2 定义,Task 7 引用 — 返回值形状一致。
- `probeModelContextLength` 在 Task 18 定义,Task 19 引用 — 签名一致。
