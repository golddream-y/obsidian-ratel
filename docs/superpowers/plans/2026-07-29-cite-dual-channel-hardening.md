# P-CITE — 引用双通道加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提高正文 `[n]` 命中率（prompt + 注入），并让 chip 在有内联标时隐藏、无标时折叠；续聊从 `search_vault` tool 历史重建 `searchResults` 使引用可点。

**Architecture:** 纯函数负责截断 / 抽取 citedIndexes；hydrate 用 `mapSearchResults` 从 tool JSON 还原；SearchResults 按是否有有效内联标切换显隐；Agent Loop 在 `search.result` 旁调用 `ContextManager.replaceSearchIndexBlock` 注入 `[n] path` 清单；prompt 收紧引用规则。不改 Session schema。

**Tech Stack:** TypeScript / Svelte 5 / Vitest / 现有 ContextManager + Composer wrapper / i18n

**Spec:** [S-CITE](../specs/2026-07-29-cite-dual-channel-hardening-design.md)

## Global Constraints

- 用户可见字符串走 i18n（`zh.ts` + `en.ts` + `types.ts`），禁止硬编码
- 测试 `it(...)` 描述中文：`行为 - 条件 - 期望结果`
- 文件头 / 导出函数按 AGENTS.md 注释规范（中文）
- 不改 Session / ChatMessage schema；不自动改写模型正文插 `[n]`
- 多次 `search_vault`：UI / 注入 / hydrate 均只保留**最后一次**可 map 的结果
- 注入时保持 `mapped.results` **原序**（`formatSearchResultsBlock` 用 `i+1` 作 index）
- 不改检索算法 / 默认 topK / Worker

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/ui/chat/cite-path-display.ts` | 新建：可读 path 截断 |
| `src/ui/chat/collect-cited-indexes.ts` | 新建：抽取 citedIndexes + `shouldShowCiteChips` |
| `src/ui/chat/message-stream/hydrate-session-messages.ts` | 从 search_vault tool 结果挂 `searchResults` |
| `src/ui/chat/message-stream/SearchResults.svelte` | 默认折叠「来源 N 篇」；用新截断；保留 `title={r.path}` |
| `src/ui/chat/message-stream/MessageBubble.svelte` | 有有效内联标则不渲染 SearchResults |
| `src/core/context-manager.ts` | `replaceSearchIndexBlock`（清空再写；保持 results 原序） |
| `src/core/agent-loop.ts` | search 成功后注入（勿重排 mapped.results） |
| `src/prompts/defaults/zh.ts` | 收紧 workflow + search_vault 描述 |
| `src/i18n/types.ts` / `zh.ts` / `en.ts` | 折叠文案 |
| `tests/ui/chat/cite-path-display.test.ts` | 截断单测 |
| `tests/ui/chat/collect-cited-indexes.test.ts` | citedIndexes + shouldShowCiteChips 单测 |
| `tests/ui/chat/message-stream/hydrate-session-messages.test.ts` | 扩展 hydrate + pathForCiteIndex |
| `tests/core/context-manager-search.test.ts` | 扩展 replace |
| `tests/core/agent-loop.test.ts` | 扩展：spy replaceSearchIndexBlock |

---

### Task 1: 截断 path + 抽取 citedIndexes（纯函数）

**Files:**
- Create: `src/ui/chat/cite-path-display.ts`
- Create: `src/ui/chat/collect-cited-indexes.ts`
- Create: `tests/ui/chat/cite-path-display.test.ts`
- Create: `tests/ui/chat/collect-cited-indexes.test.ts`

**Interfaces:**
- Produces:
  - `formatCitePath(path: string, maxLen?: number): string`
  - `collectCitedIndexes(text: string, validIndexes: ReadonlySet<number>): Set<number>`
  - `collectCitedIndexesFromSegments(segments: Array<{ type: string; text?: string }>, validIndexes: ReadonlySet<number>): Set<number>`
  - `shouldShowCiteChips(hasSearchResults: boolean, citedCount: number): boolean`

- [ ] **Step 1: 写截断失败测试**

```typescript
/**
 * @file tests/ui/chat/cite-path-display.test.ts
 * @description cite path 可读截断
 */
import { describe, it, expect } from 'vitest';
import { formatCitePath } from '../../../src/ui/chat/cite-path-display';

describe('formatCitePath', () => {
	it('formatCitePath - 短路径 - 原样返回', () => {
		expect(formatCitePath('a/b.md')).toBe('a/b.md');
	});

	it('formatCitePath - 长路径 - 保留文件名', () => {
		const p = 'Work/技术资料/AIGC方向/模型推理/很长的目录/密码本.md';
		const out = formatCitePath(p, 28);
		expect(out.endsWith('密码本.md') || out.includes('密码本.md')).toBe(true);
		expect(out.length).toBeLessThanOrEqual(30);
	});
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ui/chat/cite-path-display.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 formatCitePath**

```typescript
/**
 * @file src/ui/chat/cite-path-display.ts
 * @description 引用 chip 路径可读截断 — 优先文件名 / 末两段
 * @module ui/chat/cite-path-display
 */

/**
 * 将 vault 相对路径截成 chip 可读短串。
 *
 * @param path - vault 相对路径
 * @param maxLen - 最大字符数,默认 28
 */
export function formatCitePath(path: string, maxLen = 28): string {
	const normalized = path.replace(/\\/g, '/').trim();
	if (!normalized) return normalized;
	if (normalized.length <= maxLen) return normalized;

	const parts = normalized.split('/').filter(Boolean);
	const file = parts[parts.length - 1] ?? normalized;
	if (file.length >= maxLen) {
		return '…' + file.slice(-(maxLen - 1));
	}
	if (parts.length >= 2) {
		const two = `${parts[parts.length - 2]}/${file}`;
		if (two.length <= maxLen) return two;
		return '…/' + file;
	}
	return '…' + file.slice(-(maxLen - 1));
}
```

- [ ] **Step 4: 写 citedIndexes 测试并实现**

```typescript
/**
 * @file tests/ui/chat/collect-cited-indexes.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
	collectCitedIndexes,
	collectCitedIndexesFromSegments,
	shouldShowCiteChips,
} from '../../../src/ui/chat/collect-cited-indexes';

describe('collectCitedIndexes', () => {
	it('collectCitedIndexes - 正文含有效编号 - 返回交集', () => {
		const set = collectCitedIndexes('见[1]与[[2]]和[9]', new Set([1, 2, 3]));
		expect([...set].sort()).toEqual([1, 2]);
	});

	it('collectCitedIndexes - 无有效编号 - 空集', () => {
		expect(collectCitedIndexes('无引用', new Set([1])).size).toBe(0);
	});

	it('collectCitedIndexesFromSegments - 只扫 text 段', () => {
		const set = collectCitedIndexesFromSegments(
			[
				{ type: 'think', text: '[1]' },
				{ type: 'text', text: '结论[2]' },
			],
			new Set([1, 2]),
		);
		expect([...set]).toEqual([2]);
	});

	it('shouldShowCiteChips - 有结果无引用 - 显示', () => {
		expect(shouldShowCiteChips(true, 0)).toBe(true);
	});

	it('shouldShowCiteChips - 有结果且有引用 - 隐藏', () => {
		expect(shouldShowCiteChips(true, 1)).toBe(false);
	});

	it('shouldShowCiteChips - 无结果 - 隐藏', () => {
		expect(shouldShowCiteChips(false, 0)).toBe(false);
	});
});
```

```typescript
/**
 * @file src/ui/chat/collect-cited-indexes.ts
 * @description 从助手正文抽取与 searchResults 交集的引用编号；chip 显隐判定
 * @module ui/chat/collect-cited-indexes
 */

const CITE_RE = /\[\[(\d+)\]\]|\[(\d+)\]/g;

export function collectCitedIndexes(
	text: string,
	validIndexes: ReadonlySet<number>,
): Set<number> {
	const out = new Set<number>();
	if (!text || validIndexes.size === 0) return out;
	CITE_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CITE_RE.exec(text)) !== null) {
		const n = Number(m[1] ?? m[2]);
		if (validIndexes.has(n)) out.add(n);
	}
	return out;
}

export function collectCitedIndexesFromSegments(
	segments: Array<{ type: string; text?: string }>,
	validIndexes: ReadonlySet<number>,
): Set<number> {
	const out = new Set<number>();
	for (const seg of segments) {
		if (seg.type !== 'text' || !seg.text) continue;
		for (const n of collectCitedIndexes(seg.text, validIndexes)) out.add(n);
	}
	return out;
}

/**
 * 是否渲染底部 cite chip 行(含折叠条)。
 * 有 searchResults 且正文无任何有效 [n] 时才显示。
 */
export function shouldShowCiteChips(hasSearchResults: boolean, citedCount: number): boolean {
	return hasSearchResults && citedCount === 0;
}
```

- [ ] **Step 5: 跑测试通过并提交**

Run: `npx vitest run tests/ui/chat/cite-path-display.test.ts tests/ui/chat/collect-cited-indexes.test.ts`  
Expected: PASS

```bash
git add src/ui/chat/cite-path-display.ts src/ui/chat/collect-cited-indexes.ts \
  tests/ui/chat/cite-path-display.test.ts tests/ui/chat/collect-cited-indexes.test.ts
git commit -m "feat(cite): path 截断与 citedIndexes 纯函数"
```

---

### Task 2: hydrate 从 search_vault tool 重建 searchResults

**Files:**
- Modify: `src/ui/chat/message-stream/hydrate-session-messages.ts`
- Modify: `tests/ui/chat/message-stream/hydrate-session-messages.test.ts`
- Consumes: `mapSearchResults` from `src/core/search-result-mapper.ts`

**Interfaces:**
- Produces: UI `Message` 在存在 search_vault tool 时带 `searchResults` / `searchReranked`（最后一次）

- [ ] **Step 1: 扩展失败测试**

在 `hydrate-session-messages.test.ts` 顶部增加：

```typescript
import { pathForCiteIndex } from '../../../../src/ui/chat/open-chat-note';
```

追加用例：

```typescript
it('hydrateSessionMessages - search_vault 标准结果 - 挂 searchResults', () => {
	const toolBody = JSON.stringify([
		{
			docId: 'd1',
			score: 0.9,
			index: 1,
			metadata: { path: 'notes/a.md' },
			reranked: true,
		},
	]);
	const ui = hydrateSessionMessages([
		{ role: 'user', content: 'q' },
		{
			role: 'assistant',
			content: '',
			toolCallId: 't1',
			toolName: 'search_vault',
			toolArgs: { query: 'q' },
		},
		{ role: 'tool', content: toolBody, toolCallId: 't1' },
		{ role: 'assistant', content: '见[1]' },
	]);
	const asst = ui[1]!;
	expect(asst.searchResults).toEqual([
		{ docId: 'd1', score: 0.9, path: 'notes/a.md', index: 1 },
	]);
	expect(asst.searchReranked).toBe(true);
	expect(pathForCiteIndex(asst.searchResults, 1)).toBe('notes/a.md');
});

it('hydrateSessionMessages - 两次 search_vault - 保留最后一次', () => {
	const first = JSON.stringify([
		{ docId: 'd1', score: 0.5, index: 1, metadata: { path: 'old.md' } },
	]);
	const second = JSON.stringify([
		{ docId: 'd2', score: 0.8, index: 1, metadata: { path: 'new.md' } },
	]);
	const ui = hydrateSessionMessages([
		{ role: 'user', content: 'q' },
		{ role: 'assistant', content: '', toolCallId: 't1', toolName: 'search_vault', toolArgs: {} },
		{ role: 'tool', content: first, toolCallId: 't1' },
		{ role: 'assistant', content: '', toolCallId: 't2', toolName: 'search_vault', toolArgs: {} },
		{ role: 'tool', content: second, toolCallId: 't2' },
		{ role: 'assistant', content: '答' },
	]);
	expect(ui[1]!.searchResults?.[0]?.path).toBe('new.md');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/ui/chat/message-stream/hydrate-session-messages.test.ts`  
Expected: FAIL（`searchResults` undefined）

- [ ] **Step 3: 实现 hydrate 挂载**

在 `hydrateSessionMessages` 的 assistant 折叠循环内：

1. `import { mapSearchResults } from '../../../core/search-result-mapper';`
2. 在 `let sawReasoning = false` 旁增加：
   `let lastSearch: { results: ...; reranked: boolean } | null = null;`
3. 当 `toolName === 'search_vault'` 且成功解析 `result` 后：
   `const mapped = mapSearchResults(result); if (mapped) lastSearch = mapped;`
4. `out.push` 时：
```typescript
out.push({
  role: 'assistant',
  segments,
  ...(lastSearch
    ? { searchResults: lastSearch.results, searchReranked: lastSearch.reranked }
    : {}),
});
```

- [ ] **Step 4: 测试通过并提交**

Run: `npx vitest run tests/ui/chat/message-stream/hydrate-session-messages.test.ts`  
Expected: PASS

```bash
git add src/ui/chat/message-stream/hydrate-session-messages.ts \
  tests/ui/chat/message-stream/hydrate-session-messages.test.ts
git commit -m "feat(cite): hydrate 从 search_vault tool 重建 searchResults"
```

---

### Task 3: i18n + SearchResults 折叠 + MessageBubble 有标则隐藏

**Files:**
- Modify: `src/i18n/types.ts`（ChatStrings 增加 key）
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`
- Modify: `src/ui/chat/message-stream/SearchResults.svelte`
- Modify: `src/ui/chat/message-stream/MessageBubble.svelte`
- Consumes: `formatCitePath`, `collectCitedIndexesFromSegments`

**Interfaces:**
- i18n: `chat.cite.sourcesCollapsed` = 「来源 {n} 篇」/ 「{n} sources」
- i18n: `chat.cite.sourcesExpandAria` / `chat.cite.sourcesCollapseAria`（折叠条按钮 aria）

- [ ] **Step 1: 加 i18n key**

在 `types.ts` 的 `ChatStrings` 中 `chat.cite.openFailed` 后追加：

```typescript
  'chat.cite.sourcesCollapsed': string;
  'chat.cite.sourcesExpandAria': string;
  'chat.cite.sourcesCollapseAria': string;
```

`zh.ts`:

```typescript
  'chat.cite.sourcesCollapsed': '来源 {n} 篇',
  'chat.cite.sourcesExpandAria': '展开来源列表',
  'chat.cite.sourcesCollapseAria': '收起来源列表',
```

`en.ts`:

```typescript
  'chat.cite.sourcesCollapsed': '{n} sources',
  'chat.cite.sourcesExpandAria': 'Expand sources',
  'chat.cite.sourcesCollapseAria': 'Collapse sources',
```

- [ ] **Step 2: 改 SearchResults — 默认折叠 + 新截断**

替换 `truncatePath` 为 `formatCitePath`；增加本地 `$state expanded = false`；默认只渲染折叠按钮，展开后才是 chip 行。

核心 template 结构：

```svelte
<script lang="ts">
  import { t } from '../../../i18n';
  import { formatCitePath } from '../cite-path-display';
  // props 不变: results, reranked, onOpenPath
  let expanded = $state(false);
</script>

{#if results.length > 0}
  <div class="ratel-cites">
    {#if reranked}
      <div class="ratel-cites-hint">{$t('chat.search.rerankHint')}</div>
    {/if}
    <button
      type="button"
      class="ratel-cites-toggle"
      aria-expanded={expanded}
      aria-label={expanded ? $t('chat.cite.sourcesCollapseAria') : $t('chat.cite.sourcesExpandAria')}
      onclick={() => (expanded = !expanded)}
    >
      {$t('chat.cite.sourcesCollapsed', { n: results.length })}
    </button>
    {#if expanded}
      <div class="ratel-cites-row" role="list">
        {#each results as r}
          <button
            type="button"
            class="ratel-cite-chip"
            role="listitem"
            aria-label={$t('chat.cite.openNote', { path: r.path })}
            title={r.path}
            onclick={() => onOpenPath(r.path)}
          >
            <span class="ratel-cite-chip-n">{r.index}</span>
            <span class="ratel-cite-chip-path">{formatCitePath(r.path)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
```

样式：`.ratel-cites-toggle` 用 muted 11–12px 文本按钮，无厚重卡片。

- [ ] **Step 3: MessageBubble — 有有效内联标则不挂 SearchResults**

```svelte
import {
  collectCitedIndexesFromSegments,
  shouldShowCiteChips,
} from '../collect-cited-indexes';

const validIndexes = $derived(
  new Set((msg.searchResults ?? []).map((r) => r.index)),
);
const citedIndexes = $derived(
  collectCitedIndexesFromSegments(msg.segments, validIndexes),
);
const showCiteChips = $derived(
  shouldShowCiteChips(!!msg.searchResults?.length, citedIndexes.size),
);
```

```svelte
{#if showCiteChips}
  <SearchResults
    results={msg.searchResults!}
    reranked={msg.searchReranked ?? false}
    {onOpenPath}
  />
{/if}
```

注意：SearchResults 仍放在 text/trace **之后**（保持现有 DOM 顺序）。

- [ ] **Step 4: 构建/测试冒烟**

Run: `npx vitest run tests/ui/chat/cite-path-display.test.ts tests/ui/chat/collect-cited-indexes.test.ts tests/ui/chat/message-stream/hydrate-session-messages.test.ts`  
Run: `npm run build`（或至少 `npx svelte-check` 若仓库脚本支持）  
Expected: 测试 PASS；无 i18n 缺 key 编译错误

```bash
git add src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts \
  src/ui/chat/message-stream/SearchResults.svelte \
  src/ui/chat/message-stream/MessageBubble.svelte
git commit -m "feat(cite): 有内联标藏 chip，无标则折叠来源"
```

---

### Task 4: ContextManager.replaceSearchIndexBlock

**Files:**
- Modify: `src/core/context-manager.ts`
- Modify: `tests/core/context-manager-search.test.ts`

**Interfaces:**
- Produces: `replaceSearchIndexBlock(results: Array<{ path: string; content?: string }>): void`  
  - 清空 `searchResultsMessages` 后，若非空则调用现有 `addSearchResults`（content 默认 `''`）
  - `load()` 已有清空，保持不变

- [ ] **Step 1: 写失败测试**

```typescript
it('replaceSearchIndexBlock - 两次调用 - toMessages 仅含最后一批 path', async () => {
  const persistence = createMockPersistence();
  const ctx = new ContextManager(persistence);
  await ctx.load('session-1');
  ctx.addUserMessage('q');
  ctx.replaceSearchIndexBlock([{ path: 'old.md', content: '' }]);
  ctx.replaceSearchIndexBlock([{ path: 'new.md', content: '' }]);
  const msgs = ctx.toMessages();
  const joined = msgs.map((m) => m.content).join('\n');
  expect(joined).toContain('new.md');
  expect(joined).not.toContain('old.md');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/core/context-manager-search.test.ts`  
Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现方法**

在 `addSearchResults` 旁：

```typescript
/**
 * 用最新一轮 search 索引块替换上下文中的检索注入(清空后写入)。
 *
 * 关键路径:同一回合多次 search_vault 时与 UI「后写覆盖」对齐。
 */
replaceSearchIndexBlock(results: Array<{ path: string; content?: string }>): void {
  this.searchResultsMessages = [];
  if (results.length === 0) return;
  // 关键路径:保持调用方传入顺序;formatSearchResultsBlock 用 i+1 作 index,勿重排
  this.addSearchResults(
    results.map((r) => ({ path: r.path, content: r.content ?? '' })),
  );
}
```

- [ ] **Step 4: 通过并提交**

```bash
git add src/core/context-manager.ts tests/core/context-manager-search.test.ts
git commit -m "feat(cite): ContextManager.replaceSearchIndexBlock 覆盖注入"
```

---

### Task 5: Agent Loop 接线注入

**Files:**
- Modify: `src/core/agent-loop.ts`（`search_vault` 成功分支）
- Modify: `tests/core/agent-loop.test.ts`

**Interfaces:**
- Consumes: `ctx.replaceSearchIndexBlock`
- 在现有 `yield search.result` 之后调用；try/catch + `devLogger`，不抛

- [ ] **Step 1: 写完整 spy 测试（勿省略 fixture）**

在 `tests/core/agent-loop.test.ts` 追加完整用例：

```typescript
it('agentLoop - search_vault 成功 - 调用 replaceSearchIndexBlock', async () => {
	const spy = vi.spyOn(ContextManager.prototype, 'replaceSearchIndexBlock');
	const persistence = createMockPersistence();
	const ctx = new ContextManager(persistence);

	const toolCall: ToolCall = {
		id: 'call_1',
		name: 'search_vault',
		args: { query: '技术栈', topK: 3 },
	};

	const llm = createMockLLM([
		[{ text: '', toolCall }],
		[{ text: '根据 [1] 的内容...' }],
	]);

	const tools = new ToolRegistry();
	tools.register({
		definition: { name: 'search_vault', description: 'search', parameters: {} },
		readOnly: true,
		execute: async () => [
			{ docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 }, index: 1 },
			{ docId: 'notes/b.md#chunk-0', score: 0.8, metadata: { path: 'notes/b.md', chunkIndex: 0 }, index: 2 },
		],
	});

	const hooks = new HookRegistry();
	for await (const _event of agentLoop(
		{ sessionId: 's1', message: '查技术栈' },
		ctx,
		llm,
		tools,
		hooks,
	)) {
		/* drain */
	}

	expect(spy).toHaveBeenCalled();
	const arg = spy.mock.calls[0]?.[0] as Array<{ path: string }>;
	expect(arg.map((r) => r.path)).toEqual(['notes/a.md', 'notes/b.md']);
	spy.mockRestore();
});
```

- [ ] **Step 2: 改 agent-loop**

```typescript
if (tc.name === 'search_vault') {
  const mapped = mapSearchResults(result);
  if (mapped) {
    yield { type: 'search.result', payload: mapped };
    try {
      // 关键路径:保持 mapped.results 原序,注入 index 与 tool index 对齐
      ctx.replaceSearchIndexBlock(
        mapped.results.map((r) => ({ path: r.path, content: '' })),
      );
    } catch (err) {
      devLogger.warn('agent', 'search 索引注入失败', err);
    }
  }
}
```

确认文件顶部已有 `devLogger` import；若无则从现有日志工具引入。

- [ ] **Step 3: 测试通过并提交**

Run: `npx vitest run tests/core/agent-loop.test.ts -t "replaceSearchIndexBlock|search.result"`  
Expected: PASS

```bash
git add src/core/agent-loop.ts tests/core/agent-loop.test.ts
git commit -m "feat(cite): search_vault 成功后注入 index 清单"
```

---

### Task 6: Prompt 收紧

**Files:**
- Modify: `src/prompts/defaults/zh.ts`

- [ ] **Step 1: 更新 `agent.rag.workflow`**

替换为：

```typescript
'agent.rag.workflow': `回答知识库问题时,按以下流程:
1. 调用 search_vault 查找相关笔记(结果带 index 编号)。
2. 对有价值的结果调用 read_note 读全文。
3. 凡依据检索结论的句子,句末必须写 [n](与 search_vault 返回的 index 一致);禁止只用文件名或表格代替 [n] 作为唯一引用方式。
4. 同一回合若多次调用 search_vault,只用最后一次返回的 index。
5. 若无结果,如实告知。`,
```

- [ ] **Step 2: 更新 `tool.search_vault.description`**

在现有描述末尾追加：`回答时用返回的 index 写成 [n] 引用。`

- [ ] **Step 3: 提交**

```bash
git add src/prompts/defaults/zh.ts
git commit -m "feat(cite): 收紧 RAG workflow 与 search_vault 引用说明"
```

（无强制单测；若有 prompt snapshot 测试则更新期望字符串。）

---

### Task 7: STATUS 状态推进 + 全量相关测试

**Files:**
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: 更新 P-CITE 状态**

P-CITE 已在 STATUS 登记。本 plan **开始执行**时改为 `🔄 In Progress`（备注分支名）；**全部 Task 完成后**改为 `✅ Completed`。不要重复新增行。

- [ ] **Step 2: 跑相关测试套件**

Run:

```bash
npx vitest run \
  tests/ui/chat/cite-path-display.test.ts \
  tests/ui/chat/collect-cited-indexes.test.ts \
  tests/ui/chat/cite-enhance.test.ts \
  tests/ui/chat/message-stream/hydrate-session-messages.test.ts \
  tests/core/context-manager-search.test.ts \
  tests/core/agent-loop.test.ts
```

Expected: 全部 PASS

- [ ] **Step 3: 提交 STATUS（Completed 时）**

```bash
git add docs/superpowers/STATUS.md
git commit -m "docs(status): P-CITE 标记 Completed"
```

---

## Spec 覆盖自检

| Spec 要求 | Task |
|---|---|
| prompt 收紧 | Task 6 |
| search 后注入 `[n] path` | Task 4–5 |
| 有有效 `[n]` 藏 chip | Task 1 `shouldShowCiteChips` + Task 3 |
| 无 `[n]` 折叠来源 | Task 3 |
| 可读截断 | Task 1 + 3 |
| chip `title` 全路径 | Task 3（显式保留 `title={r.path}`） |
| hydrate 从 tool 重建 + 可解析 path | Task 2 |
| 多次 search 覆盖 / 勿重排 | Task 2/4/5 |
| i18n | Task 3 |
| 不改 Session schema | 全 plan |
| 不自动插标 | 非目标，无 task |

## Placeholder 扫描

无 TBD；Task 5 含完整 fixture；Task 7 仅推进 STATUS 状态。

## 审查修订（2026-07-29）

相对初版 plan 已补：`shouldShowCiteChips` 单测、hydrate `pathForCiteIndex` 断言、chip `title`、Task 5 完整 spy 用例、注入勿重排注释、Task 7 STATUS 语义。

---

## 执行方式

Plan 已保存。两种执行选项：

1. **Subagent-Driven（推荐）** — 每 Task 新 subagent，两阶段审查  
2. **Inline Execution** — 本会话按 executing-plans 连续做

要哪种？
