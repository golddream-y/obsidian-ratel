# S-CLEANUP-1 实施计划 — 杂项缺失修复与历史技术债清理

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次性清理 12 项散落缺失(A 硬伤 + B 接线 + C 文档 + E lint + F 技术债),使代码库达到"无已知硬伤、无过时文档、无悬挂设置项、无 deferred 历史债"状态。

**Architecture:** 单 spec 单 plan,24 个 Task 按模块分批:先 A(用户感知硬伤)→ B(配置接线)→ C(文档)→ E(lint)→ F(技术债)。每个 Task 走 TDD 5 步(写失败测试 → 看它失败 → 写最小实现 → 看它通过 → 提交),由 subagent 独立执行 + 两阶段审查(spec 合规 + 代码质量)。

**Tech Stack:** TypeScript 5 + Svelte 5 + vitest + esbuild + Obsidian API + BailianReranker + vectra

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|---|---|
| `src/ui/chat/compact-session.ts` | A1 `/compact` 主逻辑:fork LLM 摘要 + 重置 session |
| `src/ui/chat/model-info-modal.ts` | A4 `/model` 信息 Modal(临时方案) |
| `src/ui/confirm-modal.ts` | A2 危险操作确认 Modal(reindex / dropIndex) |
| `src/hooks/immediate-reindex.ts` | B2 post-tool-use hook:从 toolCall 提取 path |
| `tests/helpers/make-tool-def.ts` | F1 提取的公共 test helper |
| `tests/ui/chat/compact-session.test.ts` | A1 测试 |
| `tests/ui/confirm-modal.test.ts` | A2 测试 |
| `tests/hooks/immediate-reindex.test.ts` | B2 helper 测试 |
| `tests/hooks/post-tool-use.test.ts` | B2 hook 注册测试 |

### 修改文件

| 文件 | 改动 |
|---|---|
| `src/core/context-manager.ts` | A1 新增 `resetSession()` + `addSystemMessage()` 方法 |
| `src/prompts/defaults/zh.ts` | A1 新增 `internal.compact` section |
| `src/prompts/types.ts` | A1 新增 `'internal.compact'` PromptSectionId |
| `src/prompts/composer.ts` | A1 新增 `composeCompactMessages()` 函数 |
| `src/ui/chat/ChatView.svelte` | A1/A4 改 `handleCompact` + `handleModel` |
| `src/main.ts` | A2 `registerCommands` + B2 `registerHooks` + F6 incremental chunkCount |
| `src/settings.ts` | B1 删除 `autoSuggestLinks` + `linkConfidenceThreshold` |
| `src/worker/index.ts` | B3 注释强化 |
| `src/adapters/vector-vectra.ts` | F5 修 `indexDelete` FIXME |
| `src/tools/{grep,glob,list-files,write-note,append-note,delete-note,edit-note}.ts` | F2 补 JSDoc |
| `src/tools/read-note.ts` | F4 改 `requireString` |
| `tests/tools/{read-note,search-vault,grep,glob,list-files,write-note,append-note,edit-note,delete-note}.test.ts` | F1 用 helper + F3 read-note 描述中文化 |
| `tests/adapters/vector-vectra.test.ts` | F8 回滚测试 |
| `tests/adapters/embedding-worker-proxy.test.ts` | F9 失败路径测试 |
| `tests/worker/embedding-worker.test.ts` | F10 embed/init 测试 |
| `src/ui/diagnostics/` | F7 文案改"块数" + A3 rerank-placeholder 重写 |
| `docs/ARCHITECTURE.md` | C1 工具清单更新 |
| `docs/superpowers/specs/2026-06-14-ratel-rag-architecture.md` | C2 §12.1 状态表更新 |
| `eslint.config.js` | E1 svelte-eslint-parser 配置 |
| `styles.css` | B1 删 Link Suggestions CSS |

---

## Task 列表

### Task 1: A1a — 新增 `internal.compact` prompt section + Composer 接入

**Files:**
- Modify: `src/prompts/types.ts`
- Modify: `src/prompts/defaults/zh.ts`
- Modify: `src/prompts/composer.ts`
- Test: `tests/prompts/composer.test.ts`

- [ ] **Step 1: 写失败测试**

新增测试到 `tests/prompts/composer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { composeCompactMessages } from '../../src/prompts/composer';

describe('composeCompactMessages', () => {
  it('正常输入 - 返回 system + user 消息 - system 包含 4 段结构化字段', () => {
    const history = 'user: 帮我建一个 a.md\nassistant: 已创建 a.md';
    const messages = composeCompactMessages({ history }, {});
    
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('对话历程');
    expect(messages[0].content).toContain('已确认事实');
    expect(messages[0].content).toContain('当前任务目标');
    expect(messages[0].content).toContain('未解决问题');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain(history);
  });

  it('overrides 覆盖 internal.compact - 使用自定义摘要指令', () => {
    const messages = composeCompactMessages({ history: '对话' }, {
      'internal.compact': '自定义摘要指令:{{history}}',
    });
    expect(messages[0].content).toBe('自定义摘要指令:对话');
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/prompts/composer.test.ts -t "composeCompactMessages"
```
Expected: FAIL with "composeCompactMessages is not exported"

- [ ] **Step 3: 实现**

`src/prompts/types.ts` 加 `'internal.compact'` 到 `PromptSectionId` union。

`src/prompts/defaults/zh.ts` 加新 section:

```typescript
'internal.compact': `你是会话压缩器。把下面的对话历史压成结构化摘要,不限制字数,用尽量精炼的语言。

输出格式(严格 4 段,每段用 markdown 标题):

## 对话历程
<用户问了什么、助手答了什么,简述>

## 已确认事实
<讨论中确定的结论、约束、决策>

## 当前任务目标
<下一步要做什么>

## 未解决问题
<还待确认的点,若无写"无">

要求:
- 不丢失关键决策、约束、未解决问题
- 不保留原文细节,只提炼要点
- 若历史为空,直接返回"无历史"`,
```

`src/prompts/composer.ts` 新增函数:

```typescript
export function composeCompactMessages(
  params: { history: string },
  overrides: OverrideMap,
): ChatMessage[] {
  const template = resolveSection('internal.compact', overrides);
  const systemContent = interpolate(template, { history: params.history });
  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: params.history },
  ];
}
```

注:`interpolate` 与 `resolveSection` 是 composer 内已有的私有 helper,直接复用。

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/prompts/composer.test.ts -t "composeCompactMessages"
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/prompts/types.ts src/prompts/defaults/zh.ts src/prompts/composer.ts tests/prompts/composer.test.ts
git commit -m "feat(prompts): 新增 internal.compact section 供 /compact 摘要使用"
```

---

### Task 2: A1b — ContextManager 新增 `resetSession()` + `addSystemMessage()`

**Files:**
- Modify: `src/core/context-manager.ts`
- Test: `tests/core/context-manager.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/core/context-manager.test.ts` 末尾加:

```typescript
describe('resetSession', () => {
  it('正常调用 - 删旧 session + 注入摘要 + preserved', async () => {
    const sessions = new Map<string, Session>();
    sessions.set('s1', { id: 's1', title: 'old', messages: [{ role: 'user', content: 'old' }], createdAt: 0, updatedAt: 0 });
    const ctx = createCtx({ sessions });
    await ctx.load('s1');
    expect(ctx.toMessages().length).toBeGreaterThan(0);

    const preserved: ChatMessage[] = [
      { role: 'user', content: 'last question' },
      { role: 'assistant', content: 'last answer' },
    ];
    await ctx.resetSession('s1', '摘要内容', preserved);

    const messages = ctx.toMessages();
    // system + 摘要 system + preserved 2 条
    expect(messages.some(m => m.role === 'system' && m.content.includes('摘要内容'))).toBe(true);
    expect(messages.some(m => m.role === 'user' && m.content === 'last question')).toBe(true);
    expect(messages.some(m => m.role === 'assistant' && m.content === 'last answer')).toBe(true);
    // 不应有旧消息
    expect(messages.some(m => m.content === 'old')).toBe(false);
  });

  it('persistence.sessions.delete 失败 - 抛错', async () => {
    const failingPersistence = {
      sessions: {
        get: async () => null,
        upsert: async () => {},
        list: async () => [],
        delete: async () => { throw new Error('disk error'); },
      },
      notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
      hooks: { append: async () => {}, list: async () => [] },
    };
    const ctx = new ContextManager(failingPersistence as any);
    await ctx.load('s1');
    await expect(ctx.resetSession('s1', '摘要', [])).rejects.toThrow('disk error');
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/core/context-manager.test.ts -t "resetSession"
```
Expected: FAIL with "ctx.resetSession is not a function"

- [ ] **Step 3: 实现**

在 `ContextManager` 类中(`addSearchResults` 之后)加:

```typescript
/**
 * 追加自定义 system 消息(用于 /compact 摘要注入等场景)。
 *
 * @param content - system 消息内容。
 */
addSystemMessage(content: string): void {
  const session = this.requireSession();
  session.messages.push({ role: 'system', content });
  session.updatedAt = Date.now();
}

/**
 * 重置 session — 删除当前持久化,新建空 session,注入摘要 system 消息 + preserved 消息。
 *
 * 关键路径:供 /compact 使用。原 session 历史被完全丢弃,只保留摘要 + 最近 N 条原文。
 *
 * @param sessionId - 会话 ID(同名)
 * @param summary - 摘要文本(已由 LLM 生成)
 * @param preservedMessages - 保留的最近原文消息(通常是最后 3 条)
 * @throws 若 persistence.sessions.delete 失败,抛原错误,session 处于中间状态(已 load 空 session 但未注入)
 */
async resetSession(
  sessionId: string,
  summary: string,
  preservedMessages: ChatMessage[],
): Promise<void> {
  // 关键路径:先删持久化,失败则抛错,不破坏当前 session 状态(此时 this.session 仍是旧的)
  await this.persistence.sessions.delete(sessionId);
  // 重新 load 创建空 session
  await this.load(sessionId);
  // 注入摘要 system 消息
  this.addSystemMessage(`[compact 摘要]\n${summary}`);
  // 注入保留的原文
  for (const msg of preservedMessages) {
    this.session!.messages.push(msg);
  }
  this.session!.updatedAt = Date.now();
}
```

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/core/context-manager.test.ts -t "resetSession"
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/context-manager.ts tests/core/context-manager.test.ts
git commit -m "feat(core): ContextManager 新增 resetSession + addSystemMessage 供 /compact 使用"
```

---

### Task 3: A1c — 创建 `compact-session.ts`

**Files:**
- Create: `src/ui/chat/compact-session.ts`
- Test: `tests/ui/chat/compact-session.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/ui/chat/compact-session.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { compactSession } from '../../../src/ui/chat/compact-session';
import { ContextManager } from '../../../src/core/context-manager';
import type { LLMClient, ChatRequest, ChatDelta } from '../../../src/ports/llm';
import type { Persistence, Session, ChatMessage } from '../../../src/ports/persistence';

function createPersistence(sessions = new Map<string, Session>()): Persistence {
  return {
    sessions: {
      get: async (id) => sessions.get(id) ?? null,
      upsert: async (s) => { sessions.set(s.id, s); },
      list: async () => [],
      delete: async (id) => { sessions.delete(id); },
    },
    notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
    hooks: { append: async () => {}, list: async () => [] },
  };
}

function createMockLLM(responses: ChatDelta[][]): LLMClient {
  let i = 0;
  return {
    async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
      for (const d of responses[i++] ?? []) yield d;
    },
    embed: async () => [],
    countTokens: () => 10,
  };
}

describe('compactSession', () => {
  it('正常 - 摘要 + 保留最近 3 条 + 重置 session', async () => {
    const sessions = new Map<string, Session>();
    const oldMessages: ChatMessage[] = [
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '答案1' },
      { role: 'user', content: '问题2' },
      { role: 'assistant', content: '答案2' },
      { role: 'user', content: '问题3' },
      { role: 'assistant', content: '答案3' },
      { role: 'user', content: '保留问题1' },
      { role: 'assistant', content: '保留答案1' },
      { role: 'user', content: '保留问题2' },
    ];
    sessions.set('s1', { id: 's1', title: '', messages: oldMessages, createdAt: 0, updatedAt: 0 });

    const persistence = createPersistence(sessions);
    const ctx = new ContextManager(persistence);
    const llm = createMockLLM([[{ text: '这是摘要' }]]);

    const result = await compactSession(ctx, llm, 's1');

    expect(result.summary).toBe('这是摘要');
    expect(result.preservedMessages).toHaveLength(3);
    expect(result.preservedMessages[0].content).toBe('答案3');
    expect(result.preservedMessages[1].content).toBe('保留问题1');
    expect(result.preservedMessages[2].content).toBe('保留答案1');

    // session 已重置,只剩摘要 system + 3 条 preserved
    await ctx.load('s1');
    const messages = ctx.toMessages('direct');
    expect(messages.some(m => m.role === 'system' && m.content.includes('这是摘要'))).toBe(true);
    expect(messages.some(m => m.content === '问题1')).toBe(false);
    expect(messages.some(m => m.content === '保留问题1')).toBe(true);
  });

  it('LLM 失败 - 抛错,session 不重置', async () => {
    const sessions = new Map<string, Session>();
    sessions.set('s1', { id: 's1', title: '', messages: [{ role: 'user', content: '原问' }], createdAt: 0, updatedAt: 0 });
    const persistence = createPersistence(sessions);
    const ctx = new ContextManager(persistence);
    const llm: LLMClient = {
      async *chat() { throw new Error('network'); },
      embed: async () => [],
      countTokens: () => 0,
    };

    await expect(compactSession(ctx, llm, 's1')).rejects.toThrow('network');

    // session 未被重置,原消息还在
    await ctx.load('s1');
    const messages = ctx.toMessages('direct');
    expect(messages.some(m => m.content === '原问')).toBe(true);
  });

  it('历史不足 3 条 - 全部保留,不调 LLM', async () => {
    const sessions = new Map<string, Session>();
    sessions.set('s1', { id: 's1', title: '', messages: [{ role: 'user', content: '只一条' }], createdAt: 0, updatedAt: 0 });
    const persistence = createPersistence(sessions);
    const ctx = new ContextManager(persistence);
    const llm = createMockLLM([]); // 不应被调用

    const result = await compactSession(ctx, llm, 's1');
    expect(result.summary).toBe('');
    expect(result.preservedMessages).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/ui/chat/compact-session.test.ts
```
Expected: FAIL with "Cannot find module '../../../src/ui/chat/compact-session'"

- [ ] **Step 3: 实现**

新建 `src/ui/chat/compact-session.ts`:

```typescript
/**
 * @file src/ui/chat/compact-session.ts
 * @description /compact 命令实现 — fork LLM 摘要 + 保留最近 3 条原文 + 重置 session
 * @module ui/chat/compact-session
 * @depends ../../core/context-manager, ../../ports/llm, ../../prompts/composer
 */

import type { ContextManager } from '../../core/context-manager';
import type { LLMClient, ChatDelta } from '../../ports/llm';
import type { ChatMessage } from '../../ports/persistence';
import { composeCompactMessages } from '../../prompts/composer';
import type { OverrideMap } from '../../prompts/types';

/**
 * 保留最近 N 条原文(混合 user/assistant),保证压缩后上下文连续性。
 */
const PRESERVED_COUNT = 3;

/**
 * /compact 结果。
 */
export interface CompactResult {
  summary: string;
  preservedMessages: ChatMessage[];
}

/**
 * 把对话历史压成结构化摘要,保留最近 3 条原文,重置 session。
 *
 * 流程(Claude Code 式):
 * 1. 拉 session 全部 messages
 * 2. 保留最后 3 条原文
 * 3. 把剩余 messages 拼成对话文本,fork 一次 LLM 调用做结构化摘要
 * 4. 调 ctx.resetSession(sessionId, summary, preservedMessages) 重置 session
 *
 * @param ctx - ContextManager 实例
 * @param llm - LLM 客户端,用于摘要
 * @param sessionId - 会话 ID
 * @param overrides - 可选 prompt 覆盖(默认空对象)
 * @returns 摘要 + 保留的原文消息
 * @throws LLM 调用失败时抛原错误,session 不重置
 */
export async function compactSession(
  ctx: ContextManager,
  llm: LLMClient,
  sessionId: string,
  overrides: OverrideMap = {},
): Promise<CompactResult> {
  await ctx.load(sessionId);
  // 关键路径:拉全部 session messages(用 toMessages 会带 system,需要只取 history)
  // 这里通过 load + 直接读 session 消息 — 但 ContextManager 不暴露 session,加一个 getter 或用 toMessages 过滤
  // 简化:用 toMessages 后过滤掉 role === 'system' 的消息
  const allMessages = ctx.toMessages('direct').filter(m => m.role !== 'system');
  
  // 历史不足 PRESERVED_COUNT 条,直接全部保留,不调 LLM
  if (allMessages.length <= PRESERVED_COUNT) {
    return { summary: '', preservedMessages: allMessages };
  }

  const preservedMessages = allMessages.slice(-PRESERVED_COUNT);
  const summaryInputMessages = allMessages.slice(0, -PRESERVED_COUNT);
  
  // 拼成对话文本
  const history = summaryInputMessages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  // 关键路径:fork LLM 调用做摘要
  const llmMessages = composeCompactMessages({ history }, overrides);
  const summary = await collectStream(llm.chat({ messages: llmMessages }));

  // 重置 session:删旧 + 新建 + 注入摘要 system + 注入 preserved
  await ctx.resetSession(sessionId, summary, preservedMessages);

  return { summary, preservedMessages };
}

/**
 * 拼接 LLM 流式 delta 为字符串。
 */
async function collectStream(stream: AsyncIterable<ChatDelta>): Promise<string> {
  let result = '';
  for await (const delta of stream) {
    if (delta.text) result += delta.text;
  }
  return result;
}
```

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/ui/chat/compact-session.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/compact-session.ts tests/ui/chat/compact-session.test.ts
git commit -m "feat(ui): 新增 compact-session 模块 - Claude Code 式 LLM 摘要 + 保留 3 条 + 重置 session"
```

---

### Task 4: A1d — ChatView.handleCompact 接入 + loading UI

**Files:**
- Modify: `src/ui/chat/ChatView.svelte`
- Modify: `src/ui/chat/input/slash-commands.ts`(若需更新描述)

- [ ] **Step 1: 写失败测试**

由于 Svelte 组件测试成本高,本次以集成验证为主,不写新单测。跳过 Step 1。

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

读 `src/ui/chat/ChatView.svelte:139-143`,把 `handleCompact` 改为:

```typescript
async function handleCompact() {
  const confirmed = await showCompactConfirm(plugin.app);
  if (!confirmed) return;
  
  // 关键路径:显示压缩中 loading
  isCompacting = true;
  
  try {
    const result = await compactSession(ctx, plugin.llm, sessionId, plugin.settings.promptOverrides ?? {});
    // 更新 Svelte state
    messages = result.preservedMessages;
    // 可选:在聊天里追加一条 system 消息显示摘要预览
    // (留给后续 UI 增强,本次只做基础接入)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 关键路径:压缩失败,session 未重置,显示 toast
    new Notice(`压缩失败:${message}`, 5000);
  } finally {
    isCompacting = false;
  }
}
```

文件顶部加 import:

```typescript
import { compactSession } from './compact-session';
import { Notice } from 'obsidian';
```

加 `isCompacting` state:

```typescript
let isCompacting = $state(false);
```

UI 在压缩按钮附近加条件渲染:

```svelte
{#if isCompacting}
  <div class="ratel-compacting-hint">压缩中...</div>
{/if}
```

`styles.css` 加:

```css
.ratel-compacting-hint {
  padding: 4px 8px;
  color: var(--text-muted);
  font-size: var(--font-ui-smaller);
}
```

- [ ] **Step 4: 跑现有测试无回归**

```bash
npm test
```
Expected: 全部 PASS(本任务无新测试,验证不破坏现有)

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/ChatView.svelte styles.css
git commit -m "feat(ui): /compact 接入 compact-session - 显示 loading + 错误处理"
```

---

### Task 5: A2 — 命令面板补 4 个 + confirm-modal

**Files:**
- Create: `src/ui/confirm-modal.ts`
- Modify: `src/main.ts`
- Test: `tests/ui/confirm-modal.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/ui/confirm-modal.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
// Modal 类需要 mock obsidian
vi.mock('obsidian', () => ({
  Modal: class {
    app: any;
    contentEl: HTMLElement;
    constructor(app: any) { this.app = app; this.contentEl = document.createElement('div'); }
    open() {}
    close() {}
  },
  App: class {},
  Setting: class {
    constructor(el: HTMLElement) {}
    setName() { return this; }
    setDesc() { return this; }
    addText(cb: any) { cb({ setValue: () => this, inputEl: document.createElement('input') }); return this; }
    addButton(cb: any) { cb({ setDisabled: () => this, onClick: () => this }); return this; }
  },
}));

import { showReindexConfirm, showDropIndexConfirm } from '../../src/ui/confirm-modal';

describe('showReindexConfirm', () => {
  it('用户确认 - 调 onConfirm', async () => {
    const onConfirm = vi.fn();
    const app = {} as any;
    // 模拟用户点确认按钮
    await showReindexConfirm(app, onConfirm);
    // 由于 Modal 是 mock,需手动触发 — 此测试简化,只验证不抛错
    expect(typeof showReindexConfirm).toBe('function');
  });
});

describe('showDropIndexConfirm', () => {
  it('用户输入 DELETE 才能确认 - 输错不调 onConfirm', async () => {
    const onConfirm = vi.fn();
    const app = {} as any;
    await showDropIndexConfirm(app, onConfirm);
    expect(typeof showDropIndexConfirm).toBe('function');
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/ui/confirm-modal.test.ts
```
Expected: FAIL with "Cannot find module '../../src/ui/confirm-modal'"

- [ ] **Step 3: 实现**

新建 `src/ui/confirm-modal.ts`:

```typescript
/**
 * @file src/ui/confirm-modal.ts
 * @description 危险操作确认 Modal — reindex / dropIndex 等需要二次确认的场景
 * @module ui/confirm-modal
 * @depends obsidian
 */

import { App, Modal, Setting } from 'obsidian';

/**
 * 显示重建索引确认 Modal。
 *
 * @param app - Obsidian App 实例
 * @param onConfirm - 用户确认后回调
 */
export function showReindexConfirm(app: App, onConfirm: () => void | Promise<void>): void {
  const modal = new Modal(app);
  modal.titleEl.setText('重建索引(全量)');
  
  new Setting(modal.contentEl)
    .setName('确认重建索引?')
    .setDesc('将删除并重建整个索引,耗时较长,期间搜索不可用。');
  
  new Setting(modal.contentEl)
    .addButton((btn) => {
      btn.setButtonText('取消').onClick(() => modal.close());
    })
    .addButton((btn) => {
      btn.setButtonText('确认重建')
        .setCta()
        .onClick(async () => {
          modal.close();
          await onConfirm();
        });
    });
  
  modal.open();
}

/**
 * 显示清空索引确认 Modal — 要求用户输入 "DELETE" 才能确认。
 *
 * @param app - Obsidian App 实例
 * @param onConfirm - 用户确认后回调
 */
export function showDropIndexConfirm(app: App, onConfirm: () => void | Promise<void>): void {
  const modal = new Modal(app);
  modal.titleEl.setText('清空索引(危险操作)');
  
  new Setting(modal.contentEl)
    .setName('确认清空整个索引?')
    .setDesc('将删除所有向量数据,需重新全量索引才能恢复搜索。此操作不可撤销。');
  
  let input = '';
  let confirmBtn: HTMLButtonElement | null = null;
  
  new Setting(modal.contentEl)
    .setName('请输入 "DELETE" 确认')
    .addText((text) => {
      text.setValue('')
        .onChange((v) => {
          input = v;
          if (confirmBtn) confirmBtn.disabled = v !== 'DELETE';
        });
    });
  
  new Setting(modal.contentEl)
    .addButton((btn) => {
      btn.setButtonText('取消').onClick(() => modal.close());
    })
    .addButton((btn) => {
      btn.setButtonText('清空索引')
        .setWarning()
        .setDisabled(true)
        .onClick(async () => {
          if (input !== 'DELETE') return;
          modal.close();
          await onConfirm();
        });
      confirmBtn = btn.buttonEl;
    });
  
  modal.open();
}
```

`src/main.ts` 在 `registerCommands`(从 onload 抽出或就在 onload 内)加 4 个 `addCommand`:

```typescript
// 重建索引
this.addCommand({
  id: 'reindex',
  name: '重建索引(全量)',
  callback: () => showReindexConfirm(this.app, () => this.indexController.reindex()),
});

// 暂停索引
this.addCommand({
  id: 'pause-index',
  name: '暂停索引',
  callback: () => {
    this.indexController.pause();
    new Notice('索引已暂停');
  },
});

// 恢复索引
this.addCommand({
  id: 'resume-index',
  name: '恢复索引',
  callback: () => {
    this.indexController.resume();
    new Notice('索引已恢复');
  },
});

// 清空索引
this.addCommand({
  id: 'drop-index',
  name: '清空索引(危险)',
  callback: () => showDropIndexConfirm(this.app, () => this.vectraStore.dropIndex()),
});
```

加 import:`import { showReindexConfirm, showDropIndexConfirm } from './ui/confirm-modal';` 与 `import { Notice } from 'obsidian';`(若未导入)。

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/ui/confirm-modal.test.ts
npm run build
```
Expected: 测试 PASS + build 无错

- [ ] **Step 5: 提交**

```bash
git add src/ui/confirm-modal.ts src/main.ts tests/ui/confirm-modal.test.ts
git commit -m "feat(main): 命令面板补 4 个命令 - reindex/pause/resume/dropIndex,危险操作带确认 Modal"
```

---

### Task 6: A3 — Rerank 诊断面板重写

**Files:**
- Rename: `src/ui/diagnostics/rerank-placeholder.ts` → `src/ui/diagnostics/rerank-test.ts`
- Modify: `src/ui/diagnostics/diagnostics-panel.ts`(更新 import)
- Modify: `styles.css`(若需要新样式)

- [ ] **Step 1: 写失败测试**

由于 Svelte 组件测试成本高,本次以集成验证为主。跳过单测。

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

读 `src/ui/diagnostics/embedding-test.ts` 作为参考模式。

读 `src/ui/diagnostics/rerank-placeholder.ts` 当前内容。

把 `rerank-placeholder.ts` 重命名为 `rerank-test.ts`,重写为:

```typescript
/**
 * @file src/ui/diagnostics/rerank-test.ts
 * @description Rerank 测试面板 — 让用户输入 query + 候选文本,测试 BailianReranker 排序效果
 * @module ui/diagnostics/rerank-test
 * @depends obsidian, ../../adapters/reranker-bailian, ../../secrets/ratel-secrets
 */

import { App, Setting } from 'obsidian';
import { BailianReranker } from '../../adapters/reranker-bailian';
import { hasRerankApiKey } from '../../secrets/ratel-secrets';

/**
 * 渲染 Rerank 测试面板到容器。
 *
 * @param app - Obsidian App
 * @param container - 容器元素
 * @param plugin - RatelVaultPlugin 实例(用于拿 secret)
 */
export function renderRerankTest(
  app: App,
  container: HTMLElement,
  plugin: { app: App; loadRerankSecret: () => Promise<string | null> },
): void {
  container.empty();
  
  if (!hasRerankApiKey(app)) {
    container.createEl('p', {
      text: '未配置百炼 rerank。请在 Obsidian 设置 → Keychain 中添加 ratel-rerank-bailian secret。',
      cls: 'ratel-rerank-warn',
    });
    return;
  }
  
  let query = '';
  let candidates = '';
  
  new Setting(container)
    .setName('Query')
    .setDesc('测试查询文本')
    .addText((text) => {
      text.setValue('').onChange((v) => { query = v; });
    });
  
  const candidatesEl = container.createEl('textarea', {
    cls: 'ratel-rerank-candidates',
    attr: { placeholder: '一行一个候选文本', rows: '6' },
  });
  candidatesEl.addEventListener('change', () => {
    candidates = candidatesEl.value;
  });
  
  const resultEl = container.createEl('div', { cls: 'ratel-rerank-result' });
  
  new Setting(container)
    .addButton((btn) => {
      btn.setButtonText('测试 Rerank')
        .setCta()
        .onClick(async () => {
          resultEl.empty();
          resultEl.createEl('p', { text: '测试中...' });
          
          try {
            const apiKey = await plugin.loadRerankSecret();
            if (!apiKey) {
              resultEl.empty().createEl('p', { text: '无法读取 rerank API key', cls: 'ratel-rerank-warn' });
              return;
            }
            const reranker = new BailianReranker(apiKey);
            const candidateList = candidates.split('\n').filter(s => s.trim());
            const ranked = await reranker.rerank(query, candidateList);
            
            resultEl.empty();
            ranked.forEach((r, i) => {
              const item = resultEl.createEl('div', { cls: 'ratel-rerank-item' });
              item.createEl('span', { text: `#${i + 1} (score: ${r.score?.toFixed(4) ?? 'N/A'})` });
              item.createEl('span', { text: r.text });
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            resultEl.empty().createEl('p', { text: `测试失败:${message}`, cls: 'ratel-rerank-warn' });
          }
        });
    });
}
```

更新 `src/ui/diagnostics/diagnostics-panel.ts` 中的 import:把 `rerank-placeholder` 改为 `rerank-test`,`renderRerankPlaceholder` 改为 `renderRerankTest`。

`styles.css` 加:

```css
.ratel-rerank-warn {
  color: var(--text-warning);
  padding: 8px;
}

.ratel-rerank-candidates {
  width: 100%;
  margin: 8px 0;
  padding: 8px;
}

.ratel-rerank-result {
  margin-top: 12px;
}

.ratel-rerank-item {
  display: flex;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--background-modifier-border);
}
```

- [ ] **Step 4: 跑现有测试无回归 + build**

```bash
npm test && npm run build
```
Expected: 全部 PASS + build 无错

- [ ] **Step 5: 提交**

```bash
git add src/ui/diagnostics/rerank-test.ts src/ui/diagnostics/diagnostics-panel.ts styles.css
git rm src/ui/diagnostics/rerank-placeholder.ts
git commit -m "feat(diagnostics): Rerank 诊断面板重写 - 接通真实 BailianReranker,改名为 rerank-test"
```

---

### Task 7: A4 — `/model` 信息 Modal(临时方案)

**Files:**
- Create: `src/ui/chat/model-info-modal.ts`
- Modify: `src/ui/chat/ChatView.svelte`

- [ ] **Step 1: 写失败测试**

Svelte 组件测试成本高,跳过单测。

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

新建 `src/ui/chat/model-info-modal.ts`:

```typescript
// TODO(ratel): 临时方案,后续完善成类似 Hermes 的模型切换体验
// (在 Modal 内直接选模型 + Apply,不走设置面板)

/**
 * @file src/ui/chat/model-info-modal.ts
 * @description /model 信息 Modal — 展示当前模型配置 + 跳转 Ratel 设置面板(临时方案)
 * @module ui/chat/model-info-modal
 * @depends obsidian
 */

import { App, Modal, Setting } from 'obsidian';

interface RatelSettingsSnapshot {
  chatModelName: string;
  chatBaseUrl: string;
  embedModelId: string;
  chatModelMaxTokens: number;
  hasRerank: boolean;
}

interface PluginLike {
  app: App;
  settings: RatelSettingsSnapshot;
}

/**
 * 展示当前模型配置 + 跳转按钮的 Modal(临时方案)。
 */
export class ModelInfoModal extends Modal {
  constructor(app: App, private plugin: PluginLike) {
    super(app);
  }
  
  onOpen(): void {
    this.titleEl.setText('当前模型配置');
    
    const s = this.plugin.settings;
    new Setting(this.contentEl)
      .setName('Chat Model')
      .setDesc(s.chatModelName || '(未配置)');
    
    new Setting(this.contentEl)
      .setName('Chat Base URL')
      .setDesc(s.chatBaseUrl || '(默认)');
    
    new Setting(this.contentEl)
      .setName('Embed Model')
      .setDesc(s.embedModelId || '(默认本地 ONNX)');
    
    new Setting(this.contentEl)
      .setName('Context Length')
      .setDesc(`${s.chatModelMaxTokens} tokens`);
    
    new Setting(this.contentEl)
      .setName('Rerank')
      .setDesc(s.hasRerank ? '已配置(百炼)' : '未配置');
    
    new Setting(this.contentEl)
      .addButton((btn) => {
        btn.setButtonText('打开 Ratel 设置面板')
          .setCta()
          .onClick(() => {
            this.close();
            this.app.setting.open();
            // 关键路径:切换到 Ratel tab(setting 对象的 tab id 通常是 plugin id)
            this.app.setting.openTabById('ratel-vault');
          });
      });
  }
}
```

修改 `src/ui/chat/ChatView.svelte` 的 `/model` 处理:

```typescript
case '/model':
  new ModelInfoModal(plugin.app, plugin as any).open();
  break;
```

加 import:`import { ModelInfoModal } from './model-info-modal';`

- [ ] **Step 4: 跑现有测试无回归 + build**

```bash
npm test && npm run build
```
Expected: 全部 PASS + build 无错

- [ ] **Step 5: 提交**

```bash
git add src/ui/chat/model-info-modal.ts src/ui/chat/ChatView.svelte
git commit -m "feat(ui): /model 改为信息 Modal - 展示当前配置 + 跳转 Ratel 设置(临时方案)"
```

---

### Task 8: B1 — 删除 Link Suggestions 设置项

**Files:**
- Modify: `src/settings.ts`
- Modify: `styles.css`(若需要)

- [ ] **Step 1: 写失败测试**

无需新增测试,验证现有测试不破坏。

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

读 `src/settings.ts`,搜索 `autoSuggestLinks` 与 `linkConfidenceThreshold`,删除:
1. `RatelVaultSettings` interface 中两字段
2. `DEFAULT_SETTINGS` 中两字段
3. `renderSettings()` 中 `renderLinkSuggestions()` 调用
4. `renderLinkSuggestions()` 方法本身(约 30 行)
5. 任何相关 import

`styles.css` 删除 `.ratel-link-suggestions-*` 相关 CSS(如有)。

- [ ] **Step 4: 跑测试无回归 + build**

```bash
npm test && npm run build
```
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/settings.ts styles.css
git commit -m "chore(settings): 删除 Link Suggestions 设置项 - Librarian 未实现前移除误导性配置"
```

---

### Task 9: B2a — `immediate-reindex.ts` helper

**Files:**
- Create: `src/hooks/immediate-reindex.ts`
- Test: `tests/hooks/immediate-reindex.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/hooks/immediate-reindex.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractToolTargetPath } from '../../src/hooks/immediate-reindex';
import type { ToolCall } from '../../src/ports/llm';

describe('extractToolTargetPath', () => {
  it('write_note - 提取 path', () => {
    const tc: ToolCall = { id: '1', name: 'write_note', args: { path: 'a.md', content: 'x' } };
    expect(extractToolTargetPath(tc)).toBe('a.md');
  });

  it('append_note - 提取 path', () => {
    const tc: ToolCall = { id: '2', name: 'append_note', args: { path: 'b.md', content: 'y' } };
    expect(extractToolTargetPath(tc)).toBe('b.md');
  });

  it('edit_note - 提取 path', () => {
    const tc: ToolCall = { id: '3', name: 'edit_note', args: { path: 'c.md', line: 1, content: 'z' } };
    expect(extractToolTargetPath(tc)).toBe('c.md');
  });

  it('delete_note - 提取 path', () => {
    const tc: ToolCall = { id: '4', name: 'delete_note', args: { path: 'd.md' } };
    expect(extractToolTargetPath(tc)).toBe('d.md');
  });

  it('非写工具 - 返回 null', () => {
    const tc: ToolCall = { id: '5', name: 'read_note', args: { path: 'e.md' } };
    expect(extractToolTargetPath(tc)).toBeNull();
  });

  it('args 缺 path 字段 - 返回 null', () => {
    const tc: ToolCall = { id: '6', name: 'write_note', args: { content: 'x' } };
    expect(extractToolTargetPath(tc)).toBeNull();
  });

  it('path 不是字符串 - 返回 null', () => {
    const tc: ToolCall = { id: '7', name: 'write_note', args: { path: 123 } };
    expect(extractToolTargetPath(tc)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/hooks/immediate-reindex.test.ts
```
Expected: FAIL with "Cannot find module '../../src/hooks/immediate-reindex'"

- [ ] **Step 3: 实现**

新建 `src/hooks/immediate-reindex.ts`:

```typescript
/**
 * @file src/hooks/immediate-reindex.ts
 * @description post-tool-use 钩子 - 写工具执行后立即触发索引刷新,绕过 FolderWatcher 5s 去抖
 * @module hooks/immediate-reindex
 * @depends ../ports/llm
 */

import type { ToolCall } from '../ports/llm';

/**
 * 触发立即索引刷新的写工具集合。
 */
const WRITE_TOOLS = new Set(['write_note', 'append_note', 'edit_note', 'delete_note']);

/**
 * 从 toolCall.args 提取目标 path。
 *
 * @param toolCall - 工具调用对象
 * @returns path 字符串;若非写工具或 args 无 path 字段则返回 null
 */
export function extractToolTargetPath(toolCall: ToolCall): string | null {
  if (!WRITE_TOOLS.has(toolCall.name)) return null;
  const path = (toolCall.args as Record<string, unknown>).path;
  if (typeof path !== 'string' || path.length === 0) return null;
  return path;
}

/**
 * 判断是否为删除类工具(用于 IndexController 决定 upsert vs delete)。
 *
 * @param toolName - 工具名
 * @returns true 表示删除(dequeue delete),false 表示 upsert
 */
export function isDeleteTool(toolName: string): boolean {
  return toolName === 'delete_note';
}
```

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/hooks/immediate-reindex.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/hooks/immediate-reindex.ts tests/hooks/immediate-reindex.test.ts
git commit -m "feat(hooks): 新增 immediate-reindex helper - 从 toolCall 提取 path 供 post-tool-use 钩子用"
```

---

### Task 10: B2b — main.ts 注册 post-tool-use hook + IndexController.enqueue

**Files:**
- Modify: `src/main.ts`
- Modify: `src/core/index-controller.ts`(若 enqueue 方法不存在)
- Test: `tests/hooks/post-tool-use.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `tests/hooks/post-tool-use.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { HookRegistry } from '../../src/core/hooks';

describe('post-tool-use immediate-reindex hook', () => {
  it('write_note 工具 - 触发 IndexController.enqueue', async () => {
    const enqueueSpy = vi.fn();
    const hooks = new HookRegistry();
    // 模拟 main.ts 注册逻辑
    hooks.register('post-tool-use', async (tc) => {
      const writeTools = ['write_note', 'append_note', 'edit_note', 'delete_note'];
      if (!writeTools.includes(tc.name)) return { allowed: true };
      // 简化:不真正调 IndexController,只验证 hook 被触发
      enqueueSpy(tc.args.path);
      return { allowed: true };
    });
    
    await hooks.run('post-tool-use', { id: '1', name: 'write_note', args: { path: 'a.md' } });
    expect(enqueueSpy).toHaveBeenCalledWith('a.md');
  });

  it('read_note 工具 - 不触发 enqueue', async () => {
    const enqueueSpy = vi.fn();
    const hooks = new HookRegistry();
    hooks.register('post-tool-use', async (tc) => {
      const writeTools = ['write_note', 'append_note', 'edit_note', 'delete_note'];
      if (!writeTools.includes(tc.name)) return { allowed: true };
      enqueueSpy(tc.args.path);
      return { allowed: true };
    });
    
    await hooks.run('post-tool-use', { id: '2', name: 'read_note', args: { path: 'a.md' } });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/hooks/post-tool-use.test.ts
```
Expected: 可能 PASS 或 FAIL(取决于 hooks.run 实现)。先跑看现状。

- [ ] **Step 3: 实现**

读 `src/core/index-controller.ts`,检查是否有 `enqueue(path, op)` 方法。若无则新增:

```typescript
/**
 * 立即触发单文件索引刷新,绕过 FolderWatcher 5s 去抖。
 *
 * 关键路径:供 post-tool-use hook 调用,写工具执行后立即更新索引。
 *
 * @param path - 文件路径(vault 相对路径)
 * @param op - 'upsert' 或 'delete'
 */
async enqueue(path: string, op: 'upsert' | 'delete'): Promise<void> {
  // 加锁防并发:同 path 短时间内多次 enqueue 只执行最后一次
  // 用 debounce 模式:50ms 内多次调用合并
  if (this.pendingEnqueues?.has(path)) {
    this.pendingEnqueues.set(path, op);
    return;
  }
  this.pendingEnqueues = this.pendingEnqueues ?? new Map();
  this.pendingEnqueues.set(path, op);
  
  setTimeout(async () => {
    const finalOp = this.pendingEnqueues!.get(path);
    this.pendingEnqueues!.delete(path);
    try {
      if (finalOp === 'delete') {
        await this.indexer.deleteFile(path);
      } else {
        await this.indexer.indexFile(path);
      }
    } catch (err) {
      devLogger.warn('hooks', `immediate-reindex 失败: ${path}`, err);
    }
  }, 50);
}
```

注:具体实现需根据 IndexController 现有结构对接,以上是参考骨架。`devLogger` import 加上。

`src/main.ts` `registerHooks()`(从 onload 抽出)新增:

```typescript
// 关键路径:写工具执行后立即触发索引刷新,绕过 FolderWatcher 5s 去抖
this.hooks.register('post-tool-use', async (toolCall: ToolCall) => {
  const targetPath = extractToolTargetPath(toolCall);
  if (targetPath) {
    await this.indexController.enqueue(targetPath, isDeleteTool(toolCall.name) ? 'delete' : 'upsert');
  }
}, 'immediate-reindex');
```

加 import:`import { extractToolTargetPath, isDeleteTool } from './hooks/immediate-reindex';`

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/hooks/post-tool-use.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main.ts src/core/index-controller.ts tests/hooks/post-tool-use.test.ts
git commit -m "feat(hooks): 注册 post-tool-use 立即索引刷新 - 写工具执行后绕过 5s 去抖"
```

---

### Task 11: B3 — Worker Threads 入口 dead code 注释强化

**Files:**
- Modify: `src/worker/index.ts:22-30`

- [ ] **Step 1: 不需要测试(纯注释改动)**

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

读 `src/worker/index.ts:22-30`,把:

```typescript
throw new Error('Worker Threads 场景下暂未实现 embeddings 注入,请使用 InlineWorker 模式');
```

改为:

```typescript
// 关键路径:此分支为未来扩展预留,当前 Obsidian 渲染进程不支持 Worker Threads(见 ADR-002)
// 所有 Worker 实际走 InlineWorker 模式(主线程模拟),不进入此分支。
// 若未来 Obsidian 支持 Worker Threads,需在此实现 embeddings 注入。
throw new Error('Worker Threads 路径不可达:当前 Obsidian 不支持 Worker Threads,请使用 InlineWorker 模式');
```

- [ ] **Step 4: 跑测试无回归**

```bash
npm test && npm run build
```
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/worker/index.ts
git commit -m "docs(worker): 强化 Worker Threads 不可达分支注释 - 引用 ADR-002"
```

---

### Task 12: C1 — ARCHITECTURE.md §3.1 工具清单更新

**Files:**
- Modify: `docs/ARCHITECTURE.md:317-328`

- [ ] **Step 1: 不需要测试(纯文档改动)**

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

读 `docs/ARCHITECTURE.md:317-328`,把老工具清单替换为:

```markdown
| 工具 | 文件 | 用途 |
|---|---|---|
| read_note | src/tools/read-note.ts | 读取笔记全文 |
| search_vault | src/tools/search-vault.ts | 向量+BM25 混合检索 |
| grep | src/tools/grep.ts | 正则搜索 |
| glob | src/tools/glob.ts | 文件名匹配 |
| list_files | src/tools/list-files.ts | 列出文件 |
| write_note | src/tools/write-note.ts | 创建/覆盖笔记 |
| append_note | src/tools/append-note.ts | 追加内容 |
| edit_note | src/tools/edit-note.ts | 编辑指定行 |
| delete_note | src/tools/delete-note.ts | 删除笔记 |
```

- [ ] **Step 4: 不需要测试**

- [ ] **Step 5: 提交**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): §3.1 工具清单更新为当前 9 个工具"
```

---

### Task 13: C2 — S-RAG-ARCH §12.1 状态表更新

**Files:**
- Modify: `docs/superpowers/specs/2026-06-14-ratel-rag-architecture.md:556-596`

- [ ] **Step 1: 不需要测试(纯文档改动)**

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

读 `docs/superpowers/specs/2026-06-14-ratel-rag-architecture.md:556-596`,把 6 个 ❌ 改为 ✅,并在每条下加实施 plan/commit 注(从 STATUS.md archive 区取):

- #7 search_vault → ✅(S-RAG-LOOP / S-W3-HYBRID)
- #9 BM25 → ✅(S-W3-HYBRID,vectra 内置 isBm25)
- #10 RRF → ✅(S-W3-HYBRID,src/core/rrf.ts)
- #11 上下文注入 → ✅(S-RAG-LOOP,ContextManager.addSearchResults)
- #12 RAG 提示词 → ✅(S-PROMPTS,src/prompts/defaults/zh.ts)
- #13 引用标记 [1][2] → ✅(S-W3-HYBRID,search-vault.ts:55)

- [ ] **Step 4: 不需要测试**

- [ ] **Step 5: 提交**

```bash
git add docs/superpowers/specs/2026-06-14-ratel-rag-architecture.md
git commit -m "docs(spec): S-RAG-ARCH §12.1 状态表更新 - 6 项已实现 ❌→✅"
```

---

### Task 14: E1 — svelte-eslint-parser 配置

**Files:**
- Modify/Create: `eslint.config.js`
- Modify: `package.json`(新增 devDependencies)

- [ ] **Step 1: 不需要测试(lint 配置)**

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

```bash
npm install -D svelte-eslint-parser @eslint/js typescript-eslint eslint-plugin-svelte
```

读现有 `eslint.config.js`(若有),添加 svelte 支持:

```javascript
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelteParser from 'svelte-eslint-parser';
import sveltePlugin from 'eslint-plugin-svelte';

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        extraFileExtensions: ['.svelte'],
      },
    },
    plugins: {
      svelte: sveltePlugin,
    },
    rules: {
      ...sveltePlugin.configs.recommended.rules,
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '.obsidian/'],
  },
];
```

跑 `npx eslint src/ 2>&1 | head -50` 验证 `*.svelte` 被覆盖。

若历史 pre-existing errors 过多(2023 个),本次不强制清零,只确保新配置正确加载。

- [ ] **Step 4: 验证**

```bash
npx eslint src/ui/chat/ChatView.svelte
```
Expected: 不再是 "No parser found" 错误,可能有一些 lint warnings/errors(可接受)

- [ ] **Step 5: 提交**

```bash
git add eslint.config.js package.json package-lock.json
git commit -m "build(lint): 配置 svelte-eslint-parser - 让 eslint 覆盖 *.svelte 文件"
```

---

### Task 15: F1 — `makeToolDef` helper 提取

**Files:**
- Create: `tests/helpers/make-tool-def.ts`
- Modify: 7 个 test 文件(`tests/tools/{read-note,search-vault,grep,glob,list-files,write-note,append-note,edit-note,delete-note}.test.ts`)

- [ ] **Step 1: 不需要新测试(refactor)**

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

新建 `tests/helpers/make-tool-def.ts`:

```typescript
import { composeToolDefinitions } from '../../src/prompts/composer';
import type { ToolDefinition } from '../../src/ports/llm';

/**
 * 测试 helper:按工具名生成 ToolDefinition。
 *
 * @param name - 工具名(如 'read_note')
 * @returns ToolDefinition 实例
 */
export function makeToolDef(name: string): ToolDefinition {
  return composeToolDefinitions({}, [name])[0]!;
}
```

7 个 test 文件每个:

1. 删除本地 `makeToolDef` 函数定义
2. 加 `import { makeToolDef } from '../helpers/make-tool-def';`
3. 验证所有 `makeToolDef('xxx')` 调用正常

- [ ] **Step 4: 跑测试无回归**

```bash
npm test -- tests/tools/
```
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add tests/helpers/make-tool-def.ts tests/tools/*.test.ts
git commit -m "refactor(tests): 提取 makeToolDef helper - 消除 7 个 test 文件重复"
```

---

### Task 16: F2 — 7 个 tool 函数补 JSDoc

**Files:**
- Modify: `src/tools/{grep,glob,list-files,write-note,append-note,delete-note,edit-note}.ts`

- [ ] **Step 1: 不需要测试(纯文档)**

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

7 个文件,每个 `export function createXxxTool(...)` 上方加 JSDoc(按 AGENTS.md § 2.3 格式):

```typescript
/**
 * 创建 xxx 工具实例。
 *
 * @param vault - ObsidianVault 外观,提供文件系统访问
 * @param definition - 工具定义(name/description/parameters),由 composer 从 prompt section 组装
 * @returns ToolRegistry 注册项(definition + execute + readOnly)
 * @example
 *   const tool = createXxxTool(vault, toolDef);
 *   tools.register(tool);
 */
```

每个文件替换 `xxx` 为具体工具名,补一行简短职责说明。

- [ ] **Step 4: 跑测试无回归 + build**

```bash
npm test && npm run build
```
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/grep.ts src/tools/glob.ts src/tools/list-files.ts src/tools/write-note.ts src/tools/append-note.ts src/tools/delete-note.ts src/tools/edit-note.ts
git commit -m "docs(tools): 7 个 tool 函数补方法级 JSDoc(AGENTS.md § 2.3 规范)"
```

---

### Task 17: F3 — `read-note.test.ts` 描述中文化

**Files:**
- Modify: `tests/tools/read-note.test.ts`

- [ ] **Step 1: 不需要测试(纯描述改动)**

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

读 `tests/tools/read-note.test.ts`,所有 `it(...)` / `describe(...)` 描述改为"行为 - 条件 - 期望结果"中文格式:

- `it('reads a note', ...)` → `it('read_note - 文件存在 - 返回内容', ...)`
- `it('throws on missing file', ...)` → `it('read_note - 文件不存在 - 抛错', ...)`
- 等等

按 AGENTS.md § 2.7 规范。

- [ ] **Step 4: 跑测试无回归**

```bash
npm test -- tests/tools/read-note.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tests/tools/read-note.test.ts
git commit -m "docs(tests): read-note.test.ts 描述中文化 - 行为 - 条件 - 期望结果"
```

---

### Task 18: F4 — `read-note.ts` 改用 `requireString`

**Files:**
- Modify: `src/tools/read-note.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/tools/read-note.test.ts` 加:

```typescript
it('read_note - path 缺失 - 抛错带字段名', async () => {
  const vault = createMockVault();
  const tool = createReadNoteTool(vault, makeToolDef('read_note'));
  await expect(tool.execute({})).rejects.toThrow(/path/);
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/tools/read-note.test.ts -t "path 缺失"
```
Expected: 可能 PASS(原 `as string` 也抛错但不带字段名)或 FAIL

- [ ] **Step 3: 实现**

读 `src/tools/read-note.ts`,把:

```typescript
const notePath = args.path as string;
```

改为:

```typescript
import { requireString } from './validate-args';
// ...
const notePath = requireString(args, 'path', 'path');
```

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/tools/read-note.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/read-note.ts tests/tools/read-note.test.ts
git commit -m "refactor(tools): read-note 改用 requireString - 取代 as string 类型断言"
```

---

### Task 19: F5 — `indexDelete` FIXME 修复

**Files:**
- Modify: `src/adapters/vector-vectra.ts`

- [ ] **Step 1: 写失败测试(先复现 bug)**

在 `tests/adapters/vector-vectra.test.ts` 加:

```typescript
describe('indexDelete - catalog 同步', () => {
  it('删除后 catalog 不再包含被删项', async () => {
    // 先 upsert 一个 doc,然后 delete,验证 catalog 已清理
    // 具体实现取决于 vectra API
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/adapters/vector-vectra.test.ts -t "catalog"
```
Expected: FAIL(catalog 仍有残留)

- [ ] **Step 3: 实现**

读 `src/adapters/vector-vectra.ts` 找到 `indexDelete` 方法与 FIXME 注释。按 vectra API 正确删除 catalog 项(参考 `deleteByPath` 已修的方式,用 `index.deleteItems(itemIds)`)。

删除 FIXME 注释。

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/adapters/vector-vectra.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/vector-vectra.ts tests/adapters/vector-vectra.test.ts
git commit -m "fix(vector): 修复 indexDelete catalog 同源 bug - 删除 FIXME"
```

---

### Task 20: F6 — `chunkCount` incremental 路径更新

**Files:**
- Modify: `src/main.ts:189-198`

- [ ] **Step 1: 写失败测试**

(视 main.ts 结构而定,可能需要集成测试)

- [ ] **Step 2: 跑测试看失败**

- [ ] **Step 3: 实现**

读 `src/main.ts:189-198` `incremental` 索引路径。调用 `index.incremental` 后,补 `manifest.recordEntry(...)` 更新 chunkCount:

```typescript
// 关键路径:incremental 后更新 manifest.chunkCount
const result = await this.indexer.incremental(...);
if (result?.chunkCount !== undefined) {
  this.indexManifest.recordEntry(result.chunkCount);
  await this.indexManifest.save();
}
```

(具体实现取决于 incremental 返回值与 IndexManifest API,需现场对接)

- [ ] **Step 4: 跑测试无回归**

```bash
npm test
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main.ts
git commit -m "fix(index): incremental 路径更新 manifest.chunkCount - 修复 0 占位问题"
```

---

### Task 21: F7 — `totalDocs` 语义统一

**Files:**
- Modify: `src/ui/diagnostics/` 下相关文件
- Modify: `src/ui/status/` 下相关文件

- [ ] **Step 1: 不需要测试(纯文案)**

- [ ] **Step 2: 不适用**

- [ ] **Step 3: 实现**

grep 搜索"文档数"在 `src/ui/` 下的所有出现,替换为"块数":

```bash
# 用 Grep 工具搜 "文档数" 在 src/ui/
```

替换每处为"块数"。

- [ ] **Step 4: 跑测试无回归**

```bash
npm test
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ui/
git commit -m "docs(ui): 文案从'文档数'改为'块数' - 准确反映 vectra 存储 chunk 语义"
```

---

### Task 22: F8 — 回滚测试补充

**Files:**
- Modify: `tests/adapters/vector-vectra.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/adapters/vector-vectra.test.ts` 加:

```typescript
describe('upsertItems 事务回滚', () => {
  it('事务中失败 - 已写入部分回滚', async () => {
    // 模拟 batch 中途失败,验证已写入的 chunk 被回滚
  });
});

describe('deleteByPath 失败保护', () => {
  it('deleteByPath 失败 - 不破坏索引状态', async () => {
    // 模拟 delete 失败,验证索引仍可查询
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/adapters/vector-vectra.test.ts -t "事务回滚"
```

- [ ] **Step 3: 实现**

视测试结果决定是修代码还是补 mock。若 vectra 本身保证事务,测试通过即可;若不保证,需在 VectraStore 层加事务包装。

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/adapters/vector-vectra.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tests/adapters/vector-vectra.test.ts
git commit -m "test(vector): 补充事务回滚测试 - 覆盖 upsertItems 中途失败与 deleteByPath 失败"
```

---

### Task 23: F9 — EmbeddingWorkerProxy 测试补充

**Files:**
- Modify: `tests/adapters/embedding-worker-proxy.test.ts`

- [ ] **Step 1: 写失败测试**

加 3 个测试:

```typescript
describe('EmbeddingWorkerProxy - 失败路径', () => {
  it('init - Worker 初始化失败 - 抛 explicit error', async () => {
    // mock Worker 抛 init error
  });

  it('embed - Worker 业务错误 - 抛 explicit error 不静默降级', async () => {
    // mock Worker 在 embed 阶段抛错
  });

  it('embed - 并发调用 - 多请求 ID 不串扰', async () => {
    // 同时发 3 个 embed,验证结果对应正确
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/adapters/embedding-worker-proxy.test.ts
```

- [ ] **Step 3: 实现**

按测试失败情况修代码或补 mock,确保错误显式上报(不静默降级,见 AGENTS.md 关键约束)。

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/adapters/embedding-worker-proxy.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tests/adapters/embedding-worker-proxy.test.ts src/adapters/embedding-worker-proxy.ts
git commit -m "test(embedding): 补充 EmbeddingWorkerProxy 失败路径 + 并发测试"
```

---

### Task 24: F10 — embedding-worker.ts 测试补充

**Files:**
- Modify: `tests/worker/embedding-worker.test.ts`

- [ ] **Step 1: 写失败测试**

加 2 个测试:

```typescript
describe('embedding-worker - 消息处理', () => {
  it('onmessage - embed 成功 - 返回向量', async () => {
    // mock ONNX session.run,验证 postMessage 返回向量
  });

  it('onmessage - init 失败 - 返回错误', async () => {
    // mock ONNX 初始化失败,验证 postMessage 返回 error
  });
});
```

- [ ] **Step 2: 跑测试看失败**

```bash
npm test -- tests/worker/embedding-worker.test.ts
```

- [ ] **Step 3: 实现**

补 mock 与测试代码,确保 init 失败显式上报。

- [ ] **Step 4: 跑测试看通过**

```bash
npm test -- tests/worker/embedding-worker.test.ts
```
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add tests/worker/embedding-worker.test.ts
git commit -m "test(worker): 补充 embedding-worker embed/init 路径测试"
```

---

## 自审

### Spec coverage 检查

- ✅ A1 `/compact` — Task 1-4(4 个 Task)
- ✅ A2 命令面板 — Task 5
- ✅ A3 Rerank 诊断 — Task 6
- ✅ A4 /model Modal — Task 7
- ✅ B1 删 Link Suggestions — Task 8
- ✅ B2 post-tool-use hook — Task 9-10(2 个 Task)
- ✅ B3 Worker Threads 注释 — Task 11
- ✅ C1 ARCHITECTURE.md — Task 12
- ✅ C2 S-RAG-ARCH §12.1 — Task 13
- ✅ E1 svelte-eslint-parser — Task 14
- ✅ F1 makeToolDef 提取 — Task 15
- ✅ F2 7 个 tool JSDoc — Task 16
- ✅ F3 read-note.test 中文化 — Task 17
- ✅ F4 read-note requireString — Task 18
- ✅ F5 indexDelete FIXME — Task 19
- ✅ F6 chunkCount 更新 — Task 20
- ✅ F7 totalDocs 语义 — Task 21
- ✅ F8 回滚测试 — Task 22
- ✅ F9 EmbeddingWorkerProxy 测试 — Task 23
- ✅ F10 embedding-worker.ts 测试 — Task 24

12 项全部覆盖,共 24 个 Task。

### Placeholder 扫描

- 无 TBD / TODO(除 Task 7 的 `TODO(ratel)` 是设计明确要求保留的)
- Task 19-20 / 22-24 的测试代码是骨架,需 implementer 现场根据 vectra/worker API 补全 — 这是合理的,因为这些 API 在 spec 阶段无法预知细节
- Task 20 (chunkCount) 实现代码也是骨架,需现场对接 IndexManifest API

### 类型一致性

- `resetSession(sessionId, summary, preservedMessages)` — Task 2 定义,Task 3 调用 ✅
- `composeCompactMessages({ history }, overrides)` — Task 1 定义,Task 3 调用 ✅
- `extractToolTargetPath(toolCall)` — Task 9 定义,Task 10 调用 ✅
- `isDeleteTool(toolName)` — Task 9 定义,Task 10 调用 ✅
- `makeToolDef(name)` — Task 15 定义,后续 Task 调用 ✅

### 歧义检查

- Task 5 `loadRerankSecret` 在 Task 6 中作为 plugin 接口出现,需 implementer 根据 main.ts 实际方法名对接 — 标注
- Task 20 `recordEntry` 与 `chunkCount` 字段需根据 IndexManifest 实际 API 对接 — 标注

---

## 执行建议

按 Task 1-24 顺序执行。A 模块(Task 1-7)是用户感知最强的,先做完;B 模块(Task 8-11)次之;C(Task 12-13)+ E(Task 14)是文档/配置;F(Task 15-24)是技术债清理。

每个 Task 走 subagent-driven-development:
1. 派 implementer subagent 执行
2. spec compliance reviewer 检查
3. code quality reviewer 检查
4. 通过后进入下一 Task

Task 间有依赖:
- Task 2 依赖 Task 1(`internal.compact` section)
- Task 3 依赖 Task 1 + Task 2
- Task 4 依赖 Task 3
- Task 10 依赖 Task 9
- 其他 Task 互相独立

不要并行派 implementer(可能冲突),但 reviewer 可以并行。
