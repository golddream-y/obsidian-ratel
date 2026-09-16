# P-RENDER-STABILITY-B:发送路径单次 load + Embedding Worker 空闲回收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次发送对同一 session 只解析一遍 JSON；Embedding Web Worker 惰性创建、空闲 5 分钟回收 WASM、崩溃后下次 embed 重建。

**Architecture:** `ContextManager.load` 同 id 幂等，ChatView 预发送的 `preCtx` 经 `ask({ preloadedContext })` 复用，`agentLoop` 仍调 `load` 但变成 no-op。`EmbeddingWorkerProxy` 第二参改为工厂（保留旧 deps 对象重载以免 Task 2 合入后 `main.ts` 编不过）；空闲/崩溃不新增面包屑 phase，用 `heartbeat` + `n=worker.*`（heartbeat 不改 `lastPhase`）。

**Tech Stack:** TypeScript / Vitest fake timers / Web Worker mock。无新 npm。

**关联文档:** [S-RENDER-STABILITY](2026-09-15-render-stability-design.md) §4.3 / §4.4 / §4.6

## Global Constraints

- 只实现分期 B（§4.3 单次加载 + §4.4 Worker 生命周期）。禁止改 vectra、AgentEvent、重试/压缩/上送预算、architecture 文档、分期 C
- 不跨发送缓存 ctx；一次 `ask` 结束即丢弃
- 压缩重试（`attempt > 0`）与 `compact.applied` 后 rehydrate 仍用**同一个** ctx 实例
- `load` 同 id 幂等：**不得**再 `sessions.get`，**不得**清空 `searchResultsMessages`
- Worker 构造第二参：`EmbeddingOnnxDeps | (() => Promise<EmbeddingOnnxDeps>)`。工厂路径每次 `ensureWorker` 必须 `getDeps()` 新 ArrayBuffer（transfer 会掏空旧 buffer）
- 空闲回收：`IDLE_TERMINATE_MS = 5 * 60_000`；无挂起请求且距最后一次成功 `embed` 超过此时长才 `terminate`
- 崩溃重建：`error` 事件 reject 全部 pending 后 `worker = null`；下次 `embed` 再创建。连续 **2 次 init 失败** 进入 `dead`，之后 `embed` 直接抛错并 `devLogger.error` 一次
- 生命周期面包屑**不新增 phase**：`mark('heartbeat', undefined, 'worker.create' | 'worker.idle-terminate' | 'worker.crash')`。禁止用 `ask.embed.begin` 打空闲回收，否则 `lastPhase` 变成进行中态、空闲后误报 `crash.suspect`
- 定时器：`globalThis.setTimeout` / `clearTimeout`（测假时钟）；桌面插件，不为此改成 `window.*`
- 用户可见字符串：本 plan 无新 UI 文案，不新增 i18n key
- 测试 `it(...)` 中文:`行为 - 条件 - 期望结果`；源码文件头中文
- 只链 Obsidian Sandbox；禁止 `link:vault` 日常主库；本机绝对路径不进仓库
- 提交只暂存本 task 文件清单，禁止 `git add -A`
- 工作目录：`.worktrees/feat-p-render-stability-b`；分支 `feat/p-render-stability-b`（从 `develop` `b56773a`）。不要改 `develop` 上未提交的 0.7.2 发版文件，不要混进 `feat/p-llm-retry-ui`

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/context-manager.ts` | `load` 同 id 直接 return |
| `tests/core/context-manager.test.ts` | 二次 load 不打 persistence |
| `src/adapters/embedding-worker-proxy.ts` | 惰性 Worker、空闲 terminate、崩溃重建、dead |
| `tests/adapters/embedding-worker-proxy.test.ts` | fake timers 空闲 / error 重建 / 两次 init 失败 dead |
| `src/main.ts` | `ask` 接 `preloadedContext`；Worker 工厂 + onLifecycle |
| `src/ui/chat/ChatView.svelte` | `preCtx` 传入 `ask` |

## 并行波次

- **Wave 1（可并行）：** Task 1 ∥ Task 2（无共同文件）
- **Wave 2（可并行，等 Wave 1 都过审）：** Task 3 ∥ Task 4

---

### Task 1: ContextManager.load 同 id 幂等

**Files:**
- Modify: `src/core/context-manager.ts`
- Modify: `tests/core/context-manager.test.ts`

**Interfaces:**
- Consumes: 现有 `load(sessionId: string): Promise<void>`、`sessionId` getter
- Produces: 同 id 二次 `load` 不调用 `persistence.sessions.get`，不清空检索结果

- [ ] **Step 1:写失败测试**

在 `tests/core/context-manager.test.ts` 的 `describe('ContextManager')` 内、`'loads existing session with history'` 之后插入：

```typescript
	it('load - 同 id 二次调用 - 不再触发 persistence.sessions.get', async () => {
		const persistence = createMockPersistence();
		const getSpy = vi.spyOn(persistence.sessions, 'get');
		const ctx = createCtx(persistence);
		await ctx.load('session-1');
		await ctx.load('session-1');
		expect(getSpy).toHaveBeenCalledTimes(1);
	});

	it('load - 换 id - 会再次 get 并丢掉旧检索结果', async () => {
		const persistence = createMockPersistence();
		const getSpy = vi.spyOn(persistence.sessions, 'get');
		const ctx = createCtx(persistence);
		await ctx.load('session-1');
		ctx.addSearchResults([{ path: 'a.md', content: 's' }]);
		await ctx.load('session-2');
		expect(getSpy).toHaveBeenCalledTimes(2);
		expect(ctx.sessionId).toBe('session-2');
		expect(ctx.toMessages().some((m) => m.content.includes('a.md'))).toBe(false);
	});
```

文件顶部若无 `vi`，把 `import { describe, it, expect } from 'vitest'` 改成 `import { describe, it, expect, vi } from 'vitest'`。`addSearchResults` 若签名不同，按 `src/core/context-manager.ts` 现有 public 方法改测试，不要发明新 API。

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/core/context-manager.test.ts -t '同 id 二次'`

Expected: FAIL（二次 load 仍调用 get）

- [ ] **Step 3:实现**

`src/core/context-manager.ts` 的 `load` 开头加幂等：

```typescript
	async load(sessionId: string): Promise<void> {
		// 关键路径:同 id 已在内存则不要再解析 session JSON（分期 B 单次加载）
		if (this.session?.id === sessionId) return;
		this.searchResultsMessages = [];
		this.session = await this.persistence.sessions.get(sessionId);
		if (!this.session) {
			this.session = {
				id: sessionId,
				title: '',
				messages: [],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
		}
	}
```

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/core/context-manager.test.ts`

Expected: PASS（含原有用例）

- [ ] **Step 5:Commit**

```bash
git add src/core/context-manager.ts tests/core/context-manager.test.ts
git commit -m "$(cat <<'EOF'
perf(render-stability): 同一 session 二次 load 不再解析磁盘 JSON

发送路径上 ChatView 与 agentLoop 会连续 load 同一场对话，重复解析是白屏峰值之一。
EOF
)"
```

---

### Task 2: EmbeddingWorkerProxy 惰性 / 空闲回收 / 崩溃重建

**Files:**
- Modify: `src/adapters/embedding-worker-proxy.ts`
- Modify: `tests/adapters/embedding-worker-proxy.test.ts`

**Interfaces:**
- Consumes: 现有 MockWorker、`EmbeddingOnnxDeps`
- Produces: `IDLE_TERMINATE_MS`、`WorkerLifecycleKind`、`onLifecycle?`；第二参兼容 deps 对象与 `() => Promise<EmbeddingOnnxDeps>`；`worker` 可为 null

- [ ] **Step 1:写失败测试**

在 `tests/adapters/embedding-worker-proxy.test.ts` 追加（保留现有用例；空数组用例改为「不创建 Worker」）：

把原 `'embed - 空数组不调 postMessage'` 的期望改成：空数组时 `global.Worker` **不被 new**（惰性）。若现用例仍假定构造即 init，按新语义改断言，不要留「构造即 1 次 postMessage」的旧口径。

新增：

```typescript
import { IDLE_TERMINATE_MS } from '../../src/adapters/embedding-worker-proxy';

function emptyDeps() {
	return { vocabContent: '', modelBuffer: new ArrayBuffer(8), wasmBinary: new ArrayBuffer(8) };
}

	it('构造 - 不立即 new Worker - 直到 embed', async () => {
		vi.useFakeTimers();
		const proxy = new EmbeddingWorkerProxy('mock-url', emptyDeps, 512);
		expect(global.Worker).not.toHaveBeenCalled();
		const p = proxy.embed(['a']);
		await vi.runAllTimersAsync();
		const embedCall = mockWorker.postMessage.mock.calls.find(
			(c: unknown[]) => (c[0] as { type: string }).type === 'embed',
		);
		const requestId = (embedCall![0] as { requestId: string }).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.1]] },
		} as MessageEvent);
		await p;
		expect(global.Worker).toHaveBeenCalledTimes(1);
		proxy.terminate();
		vi.useRealTimers();
	});

	it('空闲 5 分钟无挂起 - terminate Worker', async () => {
		vi.useFakeTimers();
		const lifecycle: string[] = [];
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			async () => emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
		);
		const p = proxy.embed(['a']);
		await vi.advanceTimersByTimeAsync(1);
		const embedCall = mockWorker.postMessage.mock.calls.find(
			(c: unknown[]) => (c[0] as { type: string }).type === 'embed',
		);
		const requestId = (embedCall![0] as { requestId: string }).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.2]] },
		} as MessageEvent);
		await p;
		expect(mockWorker.terminate).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(IDLE_TERMINATE_MS);
		expect(mockWorker.terminate).toHaveBeenCalled();
		expect(lifecycle).toContain('idle-terminate');
		proxy.terminate();
		vi.useRealTimers();
	});

	it('error 后下一次 embed - 再 new Worker', async () => {
		vi.useFakeTimers();
		const lifecycle: string[] = [];
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			async () => emptyDeps(),
			512,
			16,
			(k) => lifecycle.push(k),
		);
		const first = proxy.embed(['a']);
		await vi.advanceTimersByTimeAsync(1);
		mockWorker.onerror?.(new ErrorEvent('error', { message: 'WASM crash' }));
		await expect(first).rejects.toThrow('WASM crash');
		expect(lifecycle).toContain('crash');
		const workersBefore = (global.Worker as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
		const second = proxy.embed(['b']);
		await vi.advanceTimersByTimeAsync(1);
		expect((global.Worker as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(workersBefore);
		const embedCall = mockWorker.postMessage.mock.calls.find(
			(c: unknown[]) => (c[0] as { type: string }).type === 'embed',
		);
		const requestId = (embedCall![0] as { requestId: string }).requestId;
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.3]] },
		} as MessageEvent);
		await second;
		proxy.terminate();
		vi.useRealTimers();
	});

	it('连续两次 init 失败 - dead 后 embed 直接抛错不再 new Worker', async () => {
		vi.useFakeTimers();
		const failWorker = new MockWorker();
		failWorker.postMessage = vi.fn((data: unknown) => {
			queueMicrotask(() => {
				const msg = data as { type: string };
				if (msg.type === 'init') {
					failWorker.onmessage?.({
						data: { type: 'error', error: 'ONNX 初始化失败' },
					} as MessageEvent);
				}
			});
		});
		(global as unknown as { Worker: unknown }).Worker = vi.fn(function (this: unknown) {
			return failWorker;
		});
		const proxy = new EmbeddingWorkerProxy('mock-url', async () => emptyDeps(), 512);
		await expect(proxy.embed(['a'])).rejects.toThrow();
		await expect(proxy.embed(['b'])).rejects.toThrow();
		const callsAfterDead = (global.Worker as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
		await expect(proxy.embed(['c'])).rejects.toThrow();
		expect((global.Worker as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsAfterDead);
		proxy.terminate();
		vi.useRealTimers();
	});
```

MockWorker / 时钟若与现文件冲突，以「假时钟 + 手动 onmessage 回 result」为准改测试，不要真等 5 分钟。

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/adapters/embedding-worker-proxy.test.ts -t '不立即 new Worker'`

Expected: FAIL（当前构造函数立刻 `new Worker`）

- [ ] **Step 3:实现**

`src/adapters/embedding-worker-proxy.ts` 按下面骨架改（可拆私有方法，但公开行为必须一致）。导出：

```typescript
export const IDLE_TERMINATE_MS = 5 * 60_000;
export type WorkerLifecycleKind = 'create' | 'idle-terminate' | 'crash';
```

核心语义：

```typescript
type DepsOrFactory = EmbeddingOnnxDeps | (() => Promise<EmbeddingOnnxDeps>);

export class EmbeddingWorkerProxy implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId: string;
	private worker: Worker | null = null;
	private readyPromise: Promise<void> = Promise.resolve();
	private pending = new Map<string, (vectors: number[][]) => void>();
	private pendingError = new Map<string, (err: Error) => void>();
	private requestCounter = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private consecutiveInitFailures = 0;
	private dead = false;
	private readonly workerUrl: string;
	private readonly maxBatchSize: number;
	private readonly createDeps: () => Promise<EmbeddingOnnxDeps>;
	private readonly onLifecycle?: (kind: WorkerLifecycleKind) => void;
	private loggedDead = false;

	constructor(
		workerUrl: string,
		depsOrFactory: DepsOrFactory,
		dimensions: number,
		maxBatchSize = 16,
		onLifecycle?: (kind: WorkerLifecycleKind) => void,
	) {
		this.workerUrl = workerUrl;
		this.dimensions = dimensions;
		this.maxBatchSize = maxBatchSize;
		this.onLifecycle = onLifecycle;
		this.createDeps = typeof depsOrFactory === 'function'
			? depsOrFactory
			: async () => depsOrFactory;
		this.modelId = 'local:bge-small-zh-v1.5';
	}

	get ready(): Promise<void> {
		return this.readyPromise;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		if (this.dead) {
			if (!this.loggedDead) {
				devLogger.error('embedding', 'Embedding Worker 连续 init 失败，已停止重建');
				this.loggedDead = true;
			}
			throw new Error('Embedding Worker 不可用');
		}
		await this.ensureWorker();
		this.clearIdleTimer();
		const requestId = `embed_${++this.requestCounter}`;
		const result = await new Promise<number[][]>((resolve, reject) => {
			this.pending.set(requestId, resolve);
			this.pendingError.set(requestId, reject);
			this.worker!.postMessage({ type: 'embed', texts, requestId });
		});
		if (this.pending.size === 0) this.armIdleTimer();
		return result;
	}
}
```

`ensureWorker`：已有 worker 则 `await readyPromise`。否则 `const deps = await this.createDeps()`，`new Worker`，绑 message/error，post init（transfer `modelBuffer`/`wasmBinary`），成功则 `consecutiveInitFailures = 0` 并 `onLifecycle?.('create')`；init 失败则 `consecutiveInitFailures += 1`、worker=null，到 2 次设 `dead=true` 并抛错。

`error` 监听：reject 全部 pending，`terminate` 当前 worker，`worker = null`，`onLifecycle?.('crash')`。不把运行时崩溃算进 `consecutiveInitFailures`。

`armIdleTimer`：`globalThis.setTimeout(() => { this.terminateWorker('idle-terminate'); }, IDLE_TERMINATE_MS)`。

`terminateWorker(kind)`：清 timer、`worker.terminate()`、reject pending、`worker = null`、`onLifecycle?.(kind)`。公开 `terminate()` 走这个（kind 可省略 lifecycle，避免卸载时误打 idle）。

从 `src/logging/dev-logger.ts` import `devLogger`（与 main 其它模块一致）。

现有「构造即 init」测试改为先 `embed` 再断言，或改为工厂惰性；不要删掉 ready/embed/error 覆盖。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/adapters/embedding-worker-proxy.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/adapters/embedding-worker-proxy.ts tests/adapters/embedding-worker-proxy.test.ts
git commit -m "$(cat <<'EOF'
perf(render-stability): Embedding Worker 惰性创建并在空闲后释放

ORT WASM 线性内存只涨不缩；常驻 Worker 会把渲染进程堆顶满，空闲五分钟收回。
EOF
)"
```

---

### Task 3: ask 复用 preloadedContext + ChatView 传入

**Files:**
- Modify: `src/main.ts`（仅 `ask` 签名与 ctx 构造，不要改 `initEmbeddingWorkerProxy`）
- Modify: `src/ui/chat/ChatView.svelte`（`plugin.ask(...)` 那一处 opts）

**Interfaces:**
- Consumes: Task 1 的幂等 `load`；`ContextManager.sessionId`
- Produces: `opts?: { goalRound?: boolean; modelMessage?: string; preloadedContext?: ContextManager }`

- [ ] **Step 1:写失败测试**

无独立 Plugin 测试床时，在 `tests/core/context-manager.test.ts` 追加一条把「预加载 + agentLoop 再 load」说清楚（Task 1 已有同 id 二次）。再加：

创建 `tests/core/preloaded-context.test.ts`：

```typescript
/**
 * @file tests/core/preloaded-context.test.ts
 * @description ask 是否复用预加载 ctx — 纯函数，不启动 Plugin
 * @module tests/core/preloaded-context
 */

import { describe, it, expect } from 'vitest';
import { shouldReusePreloadedContext } from '../../src/core/preloaded-context';

describe('shouldReusePreloadedContext', () => {
	it('shouldReusePreloadedContext - sessionId 相同 - 复用', () => {
		expect(shouldReusePreloadedContext({ sessionId: 's1' }, 's1')).toBe(true);
	});
	it('shouldReusePreloadedContext - sessionId 不同或缺失 - 不复用', () => {
		expect(shouldReusePreloadedContext({ sessionId: 's1' }, 's2')).toBe(false);
		expect(shouldReusePreloadedContext(undefined, 's1')).toBe(false);
		expect(shouldReusePreloadedContext({ sessionId: '' }, 's1')).toBe(false);
	});
});
```

- [ ] **Step 2:跑测试确认失败**

Run: `npx vitest run tests/core/preloaded-context.test.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3:实现**

创建 `src/core/preloaded-context.ts`：

```typescript
/**
 * @file src/core/preloaded-context.ts
 * @description 判断 ask 能否复用 ChatView 预加载的 ContextManager
 * @module core/preloaded-context
 */

export function shouldReusePreloadedContext(
	preloaded: { sessionId: string } | undefined,
	sessionId: string,
): boolean {
	return Boolean(preloaded && preloaded.sessionId && preloaded.sessionId === sessionId);
}
```

`src/main.ts`：

- `import { shouldReusePreloadedContext } from './core/preloaded-context';`
- `import type { ContextManager }` 已有则不重复
- `ask` 的 `opts` 增加 `preloadedContext?: ContextManager`
- 把 `const ctx = new ContextManager(...)` 换成：

```typescript
		const ctx = shouldReusePreloadedContext(opts?.preloadedContext, sessionId)
			? opts!.preloadedContext!
			: new ContextManager(this.persistence, {
				getOverrides: () => this.settings.promptOverrides,
				getTools: () => this.tools.definitions(),
				getSkillsDiscovery: () =>
					this.skillActivator.composeDiscovery(this.settings.promptOverrides, message),
				getSkillsActive: () => '',
			}, tailBudget(getEffectiveChatModelMaxTokens(this.settings)));
```

其后 `setGoalAnchorProvider` / `setEnvContext` / `setSkillsContext` / 记忆注入 **照旧执行**（spec：setter 对已加载 session 幂等）。

更新 `ask` 的 JSDoc：每次调用不跨发送缓存；若传入同 session 的 `preloadedContext` 则不再 `new`。

`ChatView.svelte` 里 `plugin.ask(...)` 的 opts 展开增加：

```typescript
				preloadedContext: preCtx,
```

`preCtx` 已在同函数前面 `load(sessionId)`。不要把 `postCtx`（轮后校准）传进去。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/core/preloaded-context.test.ts tests/core/context-manager.test.ts tests/core/agent-loop.test.ts`

Expected: PASS

- [ ] **Step 5:Commit**

```bash
git add src/core/preloaded-context.ts tests/core/preloaded-context.test.ts \
  src/main.ts src/ui/chat/ChatView.svelte
git commit -m "$(cat <<'EOF'
perf(render-stability): 发送时复用预加载的会话上下文

预发送压缩判断已经解析过同一场 JSON，ask 不再 new 一份再 load 第三次。
EOF
)"
```

---

### Task 4: main 装配 Worker 工厂 + 生命周期面包屑

**Files:**
- Modify: `src/main.ts`（仅 `initEmbeddingWorkerProxy`）

**Interfaces:**
- Consumes: Task 2 的工厂 + `onLifecycle`
- Produces: 每次 ensureWorker 重新 `modelManager.getDeps()`；create/idle-terminate/crash 打 `heartbeat` + `n=worker.*`

- [ ] **Step 1:写失败测试**

本 task 是装配，无独立 harness。在 `tests/adapters/embedding-worker-proxy.test.ts` 已覆盖 onLifecycle。本 step 在 `src/main.ts` 的 `initEmbeddingWorkerProxy` 搜 `new EmbeddingWorkerProxy(`：若仍是 `(workerUrl, deps, embedding.dimensions)` 则本 task 未做完。

可选：给 `tests/adapters/embedding-worker-proxy.test.ts` 加一条断言 lifecycle 字符串仅为 `'create' | 'idle-terminate' | 'crash'`（已在 Task 2）。本 task 不强制新文件。

先跑 Task 2 测试确认工厂仍绿，再改 main。

- [ ] **Step 2:确认当前装配仍是同步 deps**

Run: `rg -n "new EmbeddingWorkerProxy" src/main.ts`

Expected: 仍把 `deps` 对象传入（Task 4 要改掉）

- [ ] **Step 3:实现**

`initEmbeddingWorkerProxy` 改为：

```typescript
		const proxy = new EmbeddingWorkerProxy(
			workerUrl,
			async () => {
				const fresh = await this.modelManager.getDeps();
				if (!fresh) throw new Error(tNow('error.embedding.notInit'));
				return fresh;
			},
			embedding.dimensions,
			16,
			(kind) => this.breadcrumbs?.mark('heartbeat', undefined, `worker.${kind}`),
		);
```

删除构造前那一次「只为传入而 getDeps」；改为工厂内获取。若第一次 `embed` 前仍要 `await proxy.ready`：惰性后 `ready` 在无 worker 时是已 resolve 的空 Promise。onload 若必须预热，改为 `await proxy.embed([])` **不行**（空数组不创建）。预热用：

```typescript
		await proxy.embed(['']); // 不要
```

正确：保持 onload 现有 `await proxy.ready` 语义——在 `ensureWorker` 暴露为 public 过重。改为：构造后调用一次私有预热。最简单：给 proxy 加 `ensureReady(): Promise<void>` public，内部 `await this.ensureWorker()`。

**本 task 允许**在 `embedding-worker-proxy.ts` 增加：

```typescript
	/** onload 预热：创建 Worker 并等到 init ready，不跑推理 */
	async ensureReady(): Promise<void> {
		if (this.dead) throw new Error('Embedding Worker 不可用');
		await this.ensureWorker();
	}
```

`initEmbeddingWorkerProxy` 用 `await proxy.ensureReady()` 替换 `await proxy.ready`。

若 `ensureWorker` 是 private，ensureReady 与 embed 共用即可。

- [ ] **Step 4:跑测试确认通过**

Run: `npx vitest run tests/adapters/embedding-worker-proxy.test.ts`

Expected: PASS。再 `npx tsc -noEmit -skipLibCheck` 若仓库脚本允许（`npm run typecheck` 可能含 svelte-check，失败与本 task 无关则记到 report，不要为过 typecheck 改无关文件）。

- [ ] **Step 5:Commit**

```bash
git add src/main.ts src/adapters/embedding-worker-proxy.ts tests/adapters/embedding-worker-proxy.test.ts
git commit -m "$(cat <<'EOF'
perf(render-stability): Worker 每次重建都重新读模型缓冲

transfer 会掏空 ArrayBuffer；空闲回收后再 embed 必须 getDeps 一份新的。
EOF
)"
```

若 Task 2 已加 `ensureReady`，本 commit 可以只含 `src/main.ts`。不要无关文件。

---

## 自审

- Spec §4.3：Task 1 + Task 3。压缩重试仍用 ask 里同一个 ctx，未新 new。
- Spec §4.4：Task 2 + Task 4。idle 5min、error 重建、两次 init → dead。
- Spec §4.6 测试：load 幂等、proxy fake timers、error 重建、两次 init dead。ask 的 get 一次由 load 幂等 + 复用 ctx 保证；未上完整 Plugin 集成（仓库无 ask() 测试床）。
- 无 TBD。Worker 面包屑用 heartbeat+n，避免污染 lastPhase。
- 不改 architecture。无新用户文案。
- 并行：Task 1/2 无共同文件；Task 3 不改 `initEmbeddingWorkerProxy`；Task 4 不改 `ask`/ChatView。
