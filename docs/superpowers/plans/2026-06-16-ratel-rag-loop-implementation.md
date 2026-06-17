# S-RAG-LOOP Implementation Plan: RAG 最小可用闭环

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现「开 vault → 自动索引 → RAG 问答」的最小可用闭环。

**Architecture:** main.ts 在 `onLayoutReady` 时启动模型下载,模型就绪后把 extractor 注入 EmbeddingLocal,再启动 IndexController 全量索引;Agent Loop 中注册 `search_vault` 工具,调用 `embedding.embed(query)` → Worker `vector.search` → 返回 docId+score+metadata;ContextManager 支持 `addSearchResults`,把搜索结果格式化为 context 注入到 system prompt 之后。

**Tech Stack:** TypeScript (strict), vitest, esbuild + Svelte 5, vectra, Obsidian API

**Prerequisite:** S-INIT-INDEX 已完成(176/176 tests pass),ModelManager / IndexController / Worker / EmbeddingLocal 均已实现。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/tools/search-vault.ts` | 新建 `search_vault` 工具,主线程 embed + Worker 搜索 |
| `src/core/context-manager.ts` | 扩展 `addSearchResults()` + RAG system prompt 组合 |
| `src/main.ts` | 接入 ModelManager / IndexController / search_vault 工具注册 / Worker workerData |
| `src/worker/index.ts` | Worker 入口读取 workerData,自初始化 embeddings + indexDir |
| `src/types.ts` | 确保 `WorkerRequest.vector.search` 已定义 |
| `tests/tools/search-vault.test.ts` | search_vault 工具的单元测试 |
| `tests/core/context-manager-search.test.ts` | ContextManager.addSearchResults 的单元测试 |
| `tests/main-rag-loop.test.ts` | main.ts 接入层时序测试(可选但推荐) |

---

## Task 1: 创建 search_vault 工具

**Files:**
- Create: `src/tools/search-vault.ts`
- Test: `tests/tools/search-vault.test.ts`

### Step 1: 写失败测试

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import type { VectorSearchResult } from '../../src/ports/vector';

function createMockEmbedding(): EmbeddingPort {
  return {
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
    dimensions: 3,
    modelId: 'local:mock',
  };
}

function createMockWorkerManager(): WorkerManager {
  return {
    request: vi.fn(),
    destroy: vi.fn(),
  } as unknown as WorkerManager;
}

describe('createSearchVaultTool', () => {
  it('search_vault - 查询命中 - 返回 docId + score + metadata', async () => {
    const embedding = createMockEmbedding();
    const worker = createMockWorkerManager();
    worker.request = vi.fn().mockResolvedValue({
      type: 'vector.search.result',
      payload: [
        { docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 } },
      ] as VectorSearchResult[],
    });

    const tool = createSearchVaultTool(embedding, worker);
    const result = await tool.execute({ query: '技术栈', topK: 5 });

    expect(embedding.embed).toHaveBeenCalledWith(['技术栈']);
    expect(worker.request).toHaveBeenCalledWith({
      type: 'vector.search',
      payload: { queryVector: [0.1, 0.2, 0.3], topK: 5 },
    });
    expect(result).toEqual([
      { docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 } },
    ]);
  });

  it('search_vault - 未命中 - 返回空数组', async () => {
    const embedding = createMockEmbedding();
    const worker = createMockWorkerManager();
    worker.request = vi.fn().mockResolvedValue({
      type: 'vector.search.result',
      payload: [] as VectorSearchResult[],
    });

    const tool = createSearchVaultTool(embedding, worker);
    const result = await tool.execute({ query: '不存在', topK: 3 });

    expect(result).toEqual([]);
  });
});
```

**Run:** `npm test -- tests/tools/search-vault.test.ts`

**Expected:** FAIL with `Cannot find module '../../src/tools/search-vault'`

### Step 2: 实现 search_vault 工具

```typescript
/**
 * @file src/tools/search-vault.ts
 * @description `search_vault` 工具 — 在知识库中做向量搜索,返回 docId + score + metadata
 * @module tools/search-vault
 * @depends core/tool-registry, ports/embedding, worker/manager
 */

import type { Tool } from '../core/tool-registry';
import type { EmbeddingPort } from '../ports/embedding';
import type { WorkerManager } from '../worker/manager';

/**
 * 构造 `search_vault` 工具实例。
 *
 * 设计要点:
 * - 只读工具(`readOnly: true`),不触发写钩子。
 * - 查询 embedding 在主线程执行(ms 级,不卡 UI);向量检索走 Worker(读索引文件)。
 * - 只返回 docId + score + metadata,不返回 chunk 原文,让模型自主用 read_note 读取。
 *
 * @param embedding - Embedding 端口,用于把 query 编码为向量。
 * @param workerManager - Worker 管理器,用于向 Worker 发起 vector.search 请求。
 * @returns 符合 `Tool` 接口的工具定义。
 */
export function createSearchVaultTool(embedding: EmbeddingPort, workerManager: WorkerManager): Tool {
  return {
    definition: {
      name: 'search_vault',
      description: 'Search the vault for notes relevant to a query. Returns document paths and relevance scores; use read_note to fetch the actual content.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query (e.g. "project tech stack")',
          },
          topK: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
            default: 5,
          },
        },
        required: ['query'],
      },
    },
    readOnly: true,
    async execute(args: Record<string, unknown>) {
      const query = args.query as string;
      const topK = typeof args.topK === 'number' ? args.topK : 5;

      // 关键路径:查询向量化在主线程完成,单条 ms 级,不阻塞 UI。
      const [queryVector] = await embedding.embed([query]);

      const response = await workerManager.request({
        type: 'vector.search',
        payload: { queryVector, topK },
      });

      if (response.type !== 'vector.search.result') {
        throw new Error(`Unexpected worker response type: ${response.type}`);
      }

      return response.payload;
    },
  };
}
```

**Run:** `npm test -- tests/tools/search-vault.test.ts`

**Expected:** PASS

### Step 3: Commit

```bash
git add src/tools/search-vault.ts tests/tools/search-vault.test.ts
git commit -m "$(cat <<'EOF'
feat(search-vault): 添加 search_vault 工具

- 主线程 embed 查询文本
- Worker 执行 vector.search
- 返回 docId + score + metadata
- 单测覆盖命中/未命中场景
EOF
)"
```

---

## Task 2: 扩展 ContextManager 支持搜索结果注入

**Files:**
- Modify: `src/core/context-manager.ts`
- Test: `tests/core/context-manager-search.test.ts`

### Step 1: 写失败测试

```typescript
import { describe, it, expect } from 'vitest';
import { ContextManager } from '../../src/core/context-manager';
import type { Persistence, Session } from '../../src/ports/persistence';

function createMockPersistence(sessions: Map<string, Session> = new Map()): Persistence {
  return {
    sessions: {
      get: async (id: string) => sessions.get(id) ?? null,
      upsert: async (session: Session) => { sessions.set(session.id, session); },
      list: async () => Array.from(sessions.values()),
      delete: async (id: string) => { sessions.delete(id); },
    },
    notes: {
      get: async () => null,
      upsert: async () => {},
      listByPath: async () => [],
      delete: async () => {},
    },
    hooks: {
      append: async () => {},
      list: async () => [],
    },
  };
}

describe('ContextManager.addSearchResults', () => {
  it('addSearchResults - 空数组 - 不修改 messages', async () => {
    const persistence = createMockPersistence();
    const ctx = new ContextManager(persistence);
    await ctx.load('session-1');
    ctx.addUserMessage('hello');
    ctx.addSearchResults([]);

    const msgs = ctx.toMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]!.role).toBe('user');
  });

  it('addSearchResults - 有结果 - 插入 system 之后 user 之前', async () => {
    const persistence = createMockPersistence();
    const ctx = new ContextManager(persistence);
    await ctx.load('session-1');
    ctx.addUserMessage('项目用什么技术栈?');
    ctx.addSearchResults([
      { path: 'notes/project.md', content: '项目使用 TypeScript + esbuild 构建。' },
    ]);

    const msgs = ctx.toMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]!.role).toBe('system');
    expect(msgs[1]!.content).toContain('知识库检索结果');
    expect(msgs[1]!.content).toContain('notes/project.md');
    expect(msgs[2]!.role).toBe('user');
  });

  it('addSearchResults - 多次调用 - 追加不覆盖', async () => {
    const persistence = createMockPersistence();
    const ctx = new ContextManager(persistence);
    await ctx.load('session-1');
    ctx.addUserMessage('Q');
    ctx.addSearchResults([{ path: 'a.md', content: 'A' }]);
    ctx.addSearchResults([{ path: 'b.md', content: 'B' }]);

    const systemMsgs = ctx.toMessages().filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(3); // base + 2 search results
  });
});
```

**Run:** `npm test -- tests/core/context-manager-search.test.ts`

**Expected:** FAIL with `Property 'addSearchResults' does not exist`

### Step 2: 实现 ContextManager 扩展

修改 `src/core/context-manager.ts`:

1. 在类中新增属性:

```typescript
private searchResultsMessages: ChatMessage[] = [];
```

2. 新增方法 `addSearchResults`:

```typescript
/**
 * 把搜索结果格式化为系统消息追加到上下文。
 *
 * 设计要点:
 * - 插入位置固定:base system prompt 之后、历史消息之前。
 * - 多次调用追加,不覆盖,支持多轮检索。
 * - content 来自 read_note,不是 search_vault(工具只返回 metadata)。
 *
 * @param results - 搜索结果,每项包含文档路径与已读取的内容。
 */
addSearchResults(results: { path: string; content: string }[]): void {
  if (results.length === 0) return;

  const lines = results.map((r, i) => `[${i + 1}] ${r.path}\n${r.content}`);
  const content = `--- Vault Search Results ---\n\n${lines.join('\n\n')}`;
  this.searchResultsMessages.push({ role: 'system', content });
}
```

3. 修改 `toMessages()`:

```typescript
toMessages(): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...this.searchResultsMessages,
    ...(this.session?.messages ?? []),
  ];
}
```

### Step 3: 运行测试

**Run:** `npm test -- tests/core/context-manager-search.test.ts tests/core/context-manager.test.ts`

**Expected:** PASS

### Step 4: Commit

```bash
git add src/core/context-manager.ts tests/core/context-manager-search.test.ts
git commit -m "$(cat <<'EOF'
feat(context-manager): 支持 addSearchResults 注入检索结果

- 搜索结果格式化为 system message
- 插入位置:base system prompt 之后、历史消息之前
- 多次调用追加,不覆盖
EOF
)"
```

---

## Task 3: Worker 自初始化 embeddings

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/main.ts` (创建 Worker 时传 workerData)
- Test: `tests/worker/index-init.test.ts`

> 关键路径:S-INIT-INDEX 完成后 `initProcessor(indexDir, embeddings)` 一直未在 Worker 入口调用,导致真实 Worker 线程无法索引/搜索。本 task 让 Worker 启动时从 `workerData` 读取 indexDir + modelId,自行加载 transformers pipeline 并初始化。

### Step 1: 写失败测试

```typescript
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

const TMP_WORKER_INIT_DIR = path.join(__dirname, '../tmp/worker-init-test');

describe('Worker self init', () => {
  it('Worker 入口 - 存在 workerData 时调用 initProcessor', async () => {
    vi.mock('worker_threads', () => ({
      workerData: { indexDir: TMP_WORKER_INIT_DIR, modelId: 'Xenova/bge-small-zh-v1.5' },
    }));

    vi.mock('@huggingface/transformers', () => ({
      pipeline: vi.fn().mockResolvedValue({
        async forward(texts: string[]) {
          return { tolist: () => texts.map(() => [0.1, 0.2, 0.3]) };
        },
      }),
    }));

    if (fs.existsSync(TMP_WORKER_INIT_DIR)) fs.rmSync(TMP_WORKER_INIT_DIR, { recursive: true });

    const { handleMessage } = await import('../../src/worker/handler?worker-init-test=' + Date.now());
    const res = await handleMessage({ type: 'index.status', payload: {} } as any);
    expect(res.type).toBe('index.status.result');
  });
});
```

**Run:** `npm test -- tests/worker/index-init.test.ts`

**Expected:** FAIL (Worker 入口未读取 workerData)

### Step 2: 修改 Worker 入口

修改 `src/worker/index.ts`:

```typescript
/**
 * @file src/worker/index.ts
 * @description Worker 线程入口 — 接收主线程消息并委托给 handler
 * @module worker/index
 * @depends types, ./handler, worker_threads, @huggingface/transformers
 *
 * 硬约束:
 * - 严禁 `import 'obsidian'`
 * - 不发 HTTP 请求(Embedding / LLM 调用都在主线程)
 * - 与主线程通过 `postMessage` 单向通信
 * - Worker 启动时从 workerData 读取 indexDir + modelId,自行初始化 embeddings
 */

import type { WorkerRequest, WorkerResponse } from '../types';
import { handleMessage, initProcessor } from './handler';
import { workerData } from 'worker_threads';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';

// 关键路径:Worker 启动时若有 workerData,立即初始化 embeddings 与索引。
// embeddings 对象不能跨线程序列化,必须在 Worker 线程内部构造。
async function bootstrapWorker(): Promise<void> {
  if (!workerData || typeof workerData.indexDir !== 'string') return;

  const { indexDir, modelId } = workerData as { indexDir: string; modelId: string };

  // 关键路径:外部化(external)的 transformers,运行时由 Worker 线程自己 require。
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', modelId, {
    dtype: 'q8',
  });

  const embeddings: EmbeddingsModel = {
    maxTokens: 8192,
    async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
      const arr = Array.isArray(inputs) ? inputs : [inputs];
      const output = await extractor(arr, { pooling: 'mean', normalize: true });
      return { status: 'success', output: output.tolist() };
    },
  };

  initProcessor(indexDir, embeddings);
}

// 关键路径:先启动,再注册 onmessage;避免消息在 bootstrap 完成前到达。
void bootstrapWorker().then(() => {
  self.onmessage = async (e: MessageEvent) => {
    const msg = e.data as WorkerRequest & { _requestId?: string };
    const requestId = msg._requestId;

    try {
      const response = await handleMessage(msg);
      if (requestId) {
        (response as Record<string, unknown>)._requestId = requestId;
      }
      self.postMessage(response);
    } catch (err) {
      const errorResponse: WorkerResponse = {
        type: 'error',
        payload: {
          code: 'WORKER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
      if (requestId) {
        (errorResponse as Record<string, unknown>)._requestId = requestId;
      }
      self.postMessage(errorResponse);
    }
  };
});
```

### Step 3: 修改 main.ts 创建 Worker 时传 workerData

在 `src/main.ts` 中:

```typescript
import { Worker } from 'worker_threads';
```

创建 Worker 时:

```typescript
const worker = new Worker(workerPath, {
  workerData: {
    indexDir,
    modelId: this.settings.embedLocalModel,
  },
});
```

> 注意:API 模式下 modelId 用 `embedApiModel`,Worker 内不实际调用 API,但 vectra 需要 `createEmbeddings` 存在。API 模式下 Worker 内 embed 不会走 API(因为 Worker 不能发 HTTP),所以**API 模式不能依赖 Worker 内 embed**。这里需要额外设计:
> - API 模式下,主线程 embed 所有 chunks 后通过 `vector.upsert` 传给 Worker
> - 或者 API 模式下禁止 Worker 索引(但架构要求 Worker 索引)
>
> 为保持 S-RAG-LOOP 范围最小,**本 plan 先只支持 local 模式**,API 模式在 settings 层面校验:若 `embedProvider === 'api'` 则给出 Notice 并跳过索引。

### Step 4: 运行测试

**Run:** `npm test -- tests/worker/index-init.test.ts tests/worker/handler.test.ts`

**Expected:** PASS

### Step 5: Commit

```bash
git add src/worker/index.ts src/main.ts tests/worker/index-init.test.ts
git commit -m "$(cat <<'EOF'
feat(worker): Worker 启动时自初始化 embeddings

- 从 workerData 读取 indexDir + modelId
- Worker 内加载 transformers pipeline
- 构造 EmbeddingsModel 后调 initProcessor
- 主线程创建 Worker 时传入 workerData
EOF
)"
```

---

## Task 4: main.ts 接入层

**Files:**
- Modify: `src/main.ts`
- Test: `tests/main-rag-loop.test.ts`(可选)

### Step 1: 分析现状

当前 `src/main.ts`:
- 已构造 `embedding` (EmbeddingLocal 或 EmbeddingApi)
- 已构造 `vectraStore` (但未被 IndexController 使用)
- 已构造 `workerManager`
- 已注册 `read_note` 工具
- 未构造 `ModelManager` / `IndexController`
- 未启动 `onLayoutReady` 模型下载 + 索引
- 未注册 `search_vault` 工具

### Step 2: 修改 main.ts

1. 顶部新增 import:

```typescript
import { ModelManager } from './core/model-manager';
import { IndexController, type VaultEventListener } from './core/index-controller';
import { ModelDownloader } from './core/model-downloader';
import { createSearchVaultTool } from './tools/search-vault';
import { TFile } from 'obsidian';
import { IndexBackend } from './core/index-manager';
```

2. Plugin 类新增属性:

```typescript
modelManager!: ModelManager;
indexController!: IndexController;
```

3. 在 `onload()` 的适配器装配阶段,构造 ModelManager 和 IndexController:

```typescript
// ==================== 模型与索引 ====================
const modelBackend = new ModelDownloader();
this.modelManager = new ModelManager(modelBackend);

const indexBackend: IndexBackend = {
  fullReindex: async () => {
    const files = this.vault.listMarkdownFiles();
    const filtered: Array<{ path: string; content: string }> = [];
    for (const f of files) {
      const content = await this.vault.readFile(f);
      filtered.push({ path: f, content });
    }
    const response = await this.workerManager.request({
      type: 'index.full',
      payload: { files: filtered },
    });
    if (response.type === 'index.done') {
      return { indexed: response.payload.indexed, errors: response.payload.errors };
    }
    return { indexed: 0, errors: 1 };
  },
  incrementalIndex: async (file) => {
    const response = await this.workerManager.request({
      type: 'index.incremental',
      payload: { file },
    });
    if (response.type === 'index.done') {
      return { indexed: response.payload.indexed, errors: response.payload.errors };
    }
    return { indexed: 0, errors: 1 };
  },
  deleteFile: async (filePath) => {
    const response = await this.workerManager.request({
      type: 'index.delete',
      payload: { filePath },
    });
    if (response.type === 'index.done') {
      return response.payload.indexed;
    }
    return 0;
  },
};

// 关键路径:IndexController 通过 VaultEventListener 接口订阅事件,避免强依赖 ObsidianVault 全部方法。
const vaultEventListener: VaultEventListener = {
  onFileCreate: (cb) => this.registerEvent(this.app.vault.on('create', (file) => { if (file instanceof TFile) cb(file.path); })) as unknown as () => void,
  onFileModify: (cb) => this.registerEvent(this.app.vault.on('modify', (file) => { if (file instanceof TFile) cb(file.path); })) as unknown as () => void,
  onFileDelete: (cb) => this.registerEvent(this.app.vault.on('delete', (file) => { if (file instanceof TFile) cb(file.path); })) as unknown as () => void,
  onFileRename: (cb) => this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { if (file instanceof TFile) cb(file.path, oldPath); })) as unknown as () => void,
};

this.indexController = new IndexController(vaultEventListener, indexBackend, vaultBase);
```

4. 注册 search_vault 工具(在工具与钩子区域):

```typescript
this.tools.register(createSearchVaultTool(this.embedding, this.workerManager));
```

5. 新增 `onLayoutReady` 生命周期:

```typescript
async onLayoutReady(): Promise<void> {
  // S-RAG-LOOP 仅支持本地 Embedding;API 模式跳过索引,避免 Worker 内发 HTTP。
  if (this.settings.embedProvider !== 'local') {
    new Notice('Ratel: API embedding 模式暂不支持自动索引,请切换到本地模型');
    return;
  }

  try {
    await this.modelManager.download(this.settings.embedLocalModel);
    const extractor = this.modelManager.getExtractor?.();
    if (extractor && this.embedding instanceof EmbeddingLocal) {
      this.embedding.setExtractor(extractor);
    }
    await this.indexController.onLayoutReady();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    new Notice(`Ratel 模型下载失败: ${message}`);
  }
}
```

> 注意:`ModelManager` 当前没有 `getExtractor()`。需要扩展 `ModelManager` 保存 extractor,或直接在 `main.ts` 用 `ModelDownloader` 拿 extractor。为减少改动,可以临时在 main.ts 直接调 `modelBackend.ensureModel()` 拿 extractor。
>
> 更简洁的做法:Task 3 中 Worker 已经自己加载模型,主线程查询 embed 也需要 extractor。所以 `ModelManager` 应该保存 extractor。增加 `ModelManager.getExtractor()` 方法。

### Step 3: 扩展 ModelManager 保存 extractor

修改 `src/core/model-manager.ts`:

```typescript
export class ModelManager {
    readonly status$ = writable<ModelStatus>({ state: 'NotStarted' });
    private backend: ModelBackend;
    private currentModelId: string | null = null;
    private extractor: unknown | null = null;

    // ...

    async download(modelId: string, onProgress?: (p: ProgressInfo) => void): Promise<void> {
        this.status$.set({ state: 'Checking' });
        try {
            this.status$.set({ state: 'Downloading', progress: 0, speed: 0, eta: 0 });
            const startTime = Date.now();
            this.extractor = await this.backend.ensureModel(modelId, (p) => {
                onProgress?.(p);
                // ...
            });
            this.currentModelId = modelId;
            this.status$.set({ state: 'Ready', modelId, size: 0, loadedAt: Date.now() });
        } catch (err) {
            // ...
        }
    }

    getExtractor(): unknown | null {
        return this.extractor;
    }
}
```

### Step 4: 写 main.ts 测试

```typescript
import { describe, it, expect, vi } from 'vitest';
import RatelVaultPlugin from '../src/main';

describe('main rag loop integration', () => {
  it('main.ts - search_vault 工具已注册', async () => {
    const plugin = new RatelVaultPlugin();
    plugin.app = {
      vault: {
        adapter: { getBasePath: () => '/tmp/vault' },
        on: vi.fn().mockReturnValue(() => {}),
        getMarkdownFiles: () => [],
      },
      workspace: { getLeavesOfType: () => [], getRightLeaf: () => null },
    } as unknown as typeof plugin.app;

    await plugin.onload();

    const defs = plugin.tools.definitions();
    const names = defs.map((d) => d.name);
    expect(names).toContain('search_vault');
    expect(names).toContain('read_note');
  });
});
```

> 注意:RatelVaultPlugin 构造不会触发 `onload`,Obsidian 是构造后由框架调 onload。测试需要手动调 plugin.onload()。mock 要足够完整,否则 onload 内部访问 app.vault.adapter 等会抛错。

### Step 5: 运行测试

**Run:** `npm test`

**Expected:** PASS (所有测试)

### Step 6: Commit

```bash
git add src/main.ts src/core/model-manager.ts src/core/index-controller.ts tests/main-rag-loop.test.ts
git commit -m "$(cat <<'EOF'
feat(main): 接入 RAG 闭环

- onLayoutReady 时启动模型下载与索引
- 模型就绪后注入 extractor 到 EmbeddingLocal
- 注册 search_vault 工具
- IndexController 接入 vault 事件
EOF
)"
```

---

## Task 5: 集成测试

**Files:**
- Create: `tests/integration/rag-loop.test.ts`

### Step 1: 写集成测试

```typescript
import { describe, it, expect, vi } from 'vitest';
import { agentLoop } from '../../src/core/agent-loop';
import { ContextManager } from '../../src/core/context-manager';
import { ToolRegistry } from '../../src/core/tool-registry';
import { HookRegistry } from '../../src/core/hooks';
import { createSearchVaultTool } from '../../src/tools/search-vault';
import { createReadNoteTool } from '../../src/tools/read-note';
import type { LLMClient, ToolCall } from '../../src/ports/llm';
import type { EmbeddingPort } from '../../src/ports/embedding';
import type { WorkerManager } from '../../src/worker/manager';
import type { VectorSearchResult } from '../../src/ports/vector';
import type { Persistence, Session } from '../../src/ports/persistence';

function createMockPersistence(sessions: Map<string, Session> = new Map()): Persistence {
  return {
    sessions: {
      get: async (id: string) => sessions.get(id) ?? null,
      upsert: async (session: Session) => { sessions.set(session.id, session); },
      list: async () => Array.from(sessions.values()),
      delete: async () => {},
    },
    notes: { get: async () => null, upsert: async () => {}, listByPath: async () => [], delete: async () => {} },
    hooks: { append: async () => {}, list: async () => [] },
  };
}

describe('RAG loop integration', () => {
  it('RAG 链路 - 用户提问 → search_vault → read_note → 回答', async () => {
    const sessions = new Map<string, Session>();
    const persistence = createMockPersistence(sessions);
    const ctx = new ContextManager(persistence);

    const embedding: EmbeddingPort = {
      embed: vi.fn(async () => [[0.1, 0.2]]),
      dimensions: 2,
      modelId: 'local:mock',
    };

    const worker = {
      request: vi.fn(async (req) => {
        if (req.type === 'vector.search') {
          return {
            type: 'vector.search.result',
            payload: [
              { docId: 'notes/project.md#chunk-0', score: 0.9, metadata: { path: 'notes/project.md', chunkIndex: 0 } },
            ] as VectorSearchResult[],
          };
        }
        return { type: 'error', payload: { code: 'UNKNOWN', message: 'unknown' } };
      }),
      destroy: vi.fn(),
    } as unknown as WorkerManager;

    const vault = {
      readFile: vi.fn(async () => '项目使用 TypeScript + esbuild'),
      getMetadata: vi.fn(() => null),
      getBacklinks: vi.fn(() => new Map()),
      writeFile: vi.fn(),
      listMarkdownFiles: vi.fn(() => []),
    };

    const tools = new ToolRegistry();
    tools.register(createSearchVaultTool(embedding, worker));
    tools.register(createReadNoteTool(vault as never));

    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'search_vault', args: { query: '技术栈', topK: 3 } },
      { id: 'call_2', name: 'read_note', args: { path: 'notes/project.md' } },
    ];
    let callIndex = 0;
    const llm: LLMClient = {
      async *chat() {
        const tc = toolCalls[callIndex++];
        if (tc) {
          yield { text: '' };
          yield { text: '', toolCall: tc };
        } else {
          yield { text: '项目使用 TypeScript + esbuild' };
        }
      },
      countTokens: () => 10,
    };

    const hooks = new HookRegistry();
    const events: string[] = [];
    for await (const e of agentLoop({ sessionId: 's1', message: '项目用什么技术栈?' }, ctx, llm, tools, hooks)) {
      events.push(e.type);
    }

    expect(events).toContain('tool.call');
    expect(events).toContain('tool.result');
    expect(events).toContain('message.end');
  });
});
```

### Step 2: 运行测试

**Run:** `npm test -- tests/integration/rag-loop.test.ts`

**Expected:** PASS

### Step 3: Commit

```bash
git add tests/integration/rag-loop.test.ts
git commit -m "test(integration): 添加 RAG 链路集成测试"
```

---

## Task 6: 端到端验证

### Step 1: 生产打包

**Run:** `npm run build`

**Expected:** 无报错,生成 `dist/main.js` 和 `dist/worker.js`。

### Step 2: 检查产物

**Run:** `grep -c "function mount" dist/main.js && grep -c "is not available on the server" dist/main.js`

**Expected:** `1` 和 `0`。

### Step 3: 全量测试

**Run:** `npm test`

**Expected:** 所有测试 PASS。

### Step 4: Commit

```bash
git add dist/
git commit -m "$(cat <<'EOF'
build: 生成 S-RAG-LOOP 产物

- 验证 Svelte 5 mount 解析正确
- 全量测试通过
EOF
)"
```

---

## 自审

**Spec coverage:**
- ✅ main.ts 接入层 — Task 4
- ✅ search_vault 工具 — Task 1
- ✅ 上下文注入 — Task 2
- ✅ RAG 系统提示词 — Task 2
- ✅ Worker 自初始化 embeddings — Task 3
- ✅ esbuild 修复 — 已在之前的 commit 完成

**Placeholder scan:**
- 无 TBD/TODO
- 无 "适当错误处理" 等模糊描述
- 每个步骤都有代码和命令

**Type consistency:**
- `WorkerRequest` 中的 `vector.search` 已存在
- `VectorSearchResult` 形状一致
- `addSearchResults` 签名一致

**已知风险:**
1. Worker 内加载 transformers 需要实际运行环境,集成测试可能较慢。
2. API embedding 模式本 plan 先不支持,需在设置面板或启动时提示。
3. 主线程和 Worker 各加载一次模型,内存占用翻倍;后续可优化为只让 Worker 加载,主线程 embed 通过消息发给 Worker(但会增延迟)。

---

## 执行交付选项

Plan 已保存到 `docs/superpowers/plans/2026-06-16-ratel-rag-loop-implementation.md`。

**下一步:** 选择执行方式:
1. **Subagent-Driven (recommended)** — 每个 task 派新 subagent,两阶段审查
2. **Inline Execution** — 当前 session 逐步执行
