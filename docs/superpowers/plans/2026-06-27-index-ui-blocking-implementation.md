# 索引阻塞 UI 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除索引期间主线程阻塞——P0 批量 embed 替代逐 chunk upsert + P1 ONNX 推理移入 Web Worker

**Architecture:** IndexProcessor 改为主动调 `EmbeddingPort.embed(allChunks)` 批量推理,再用 `VectraStore.upsertItem(vector)` 写入预计算向量。`EmbeddingWorkerProxy` 实现 `EmbeddingPort` 接口,内部 postMessage 到 Web Worker,Worker 中跑 `EmbeddingOnnx` 的 ONNX WASM 推理。

**Tech Stack:** TypeScript, onnxruntime-web (WASM), vectra LocalIndex API, Web Worker API, esbuild, vitest (jsdom)

**Spec:** [S-INDEX-BLOCK](../specs/2026-06-27-index-ui-blocking-fix-design.md)

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/worker/embedding-worker.ts` | Web Worker 入口,加载 ONNX + 处理 embed 请求 |
| `src/adapters/embedding-worker-proxy.ts` | `EmbeddingPort` 代理实现,postMessage 到 Worker |
| `tests/adapters/embedding-worker-proxy.test.ts` | Proxy 单元测试 |
| `tests/worker/embedding-worker.test.ts` | Worker 入口单元测试 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/ports/vector.ts` | `VectorStore` 端口新增 `upsertItem` / `beginFileUpdate` / `endFileUpdate` / `cancelFileUpdate` 签名 |
| `src/adapters/vector-vectra.ts` | 实现上述新方法 |
| `src/worker/index-processor.ts` | 逐 chunk upsert → 批量 embed + upsertItem;构造函数新增 `embeddings` 参数 |
| `src/worker/handler.ts` | `initProcessorWithStore` 新增 `embeddings` 参数 |
| `src/worker/inline-worker.ts` | `initWithStore` 新增 `embeddings` 参数 |
| `src/main.ts` | 创建 `EmbeddingWorkerProxy` 替代直接 `EmbeddingOnnx`;传给 handler init |
| `esbuild.config.mjs` | 新增 embedding-worker.js 打包入口 |
| `tests/worker/index-processor.test.ts` | 更新测试适配批量 embed + upsertItem |
| `tests/adapters/vector-vectra.test.ts` | 新增 upsertItem 测试 |

---

## Task 1:VectraStore 新增 upsertItem + 事务方法

**Files:**
- Modify: `src/ports/vector.ts`
- Modify: `src/adapters/vector-vectra.ts`
- Test: `tests/adapters/vector-vectra.test.ts`

- [ ] **Step 1: 写失败测试 — upsertItem 写入预计算向量**

在 `tests/adapters/vector-vectra.test.ts` 末尾(`afterAll` 之前)追加:

```typescript
	it('upsertItem - 写入预计算向量并搜索', async () => {
		const vector = Array(512).fill(0).map((_, i) => i / 512);
		await store.beginFileUpdate();
		await store.upsertItem('precomputed-1', vector, { path: 'notes/pre.md', chunkIndex: 0 });
		await store.endFileUpdate();

		const results = await store.search(vector, 1);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].docId).toBe('precomputed-1');
	});

	it('upsertItem - 事务回滚后数据不写入', async () => {
		const vector = Array(512).fill(0.5);
		await store.beginFileUpdate();
		await store.upsertItem('rollback-1', vector, { path: 'notes/rb.md' });
		await store.cancelFileUpdate();

		const results = await store.search(vector, 1);
		const found = results.find((r) => r.docId === 'rollback-1');
		expect(found).toBeUndefined();
	});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/adapters/vector-vectra.test.ts -t "upsertItem" 2>&1`
Expected: FAIL — `store.beginFileUpdate is not a function`

- [ ] **Step 3: VectorStore 端口新增方法签名**

在 `src/ports/vector.ts` 的 `VectorStore` 接口中,`getDocumentText` 方法之后追加:

```typescript
	/**
	 * 用预计算向量插入或更新文档(绕过 vectra 内部 embedding)。
	 *
	 * 关键路径:IndexProcessor 批量 embed 后,用此方法写入向量,
	 * 避免 upsertDocument 内部再次触发 embedding。
	 *
	 * @param docId - 文档唯一标识。
	 * @param vector - 预计算向量(长度必须等于 embedding dimensions)。
	 * @param metadata - 任意附加元数据。
	 */
	upsertItem(docId: string, vector: number[], metadata?: Record<string, unknown>): Promise<void>;
	/**
	 * 开始文件级事务 — 一个文件的多个 chunk 在同一事务内写入。
	 */
	beginFileUpdate(): Promise<void>;
	/**
	 * 提交文件级事务。
	 */
	endFileUpdate(): Promise<void>;
	/**
	 * 取消文件级事务(回滚)。
	 */
	cancelFileUpdate(): Promise<void>;
```

- [ ] **Step 4: VectraStore 实现新方法**

在 `src/adapters/vector-vectra.ts` 的 `getDocumentText` 方法之后,类的末尾(最后一个 `}` 之前)追加:

```typescript
	/**
	 * 用预计算向量插入或更新文档。
	 *
	 * 关键路径:绕过 vectra 的 upsertDocument(它会调 embedding),
	 * 直接用 LocalIndex.upsertItem 写入预计算向量。
	 * 必须在 beginFileUpdate/endFileUpdate 事务内调用。
	 *
	 * @param docId - 文档唯一标识。
	 * @param vector - 预计算向量。
	 * @param metadata - 任意附加元数据。
	 */
	async upsertItem(docId: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
		const index = await this.ensureIndex();
		await index.upsertItem({
			id: docId,
			vector,
			metadata: { ...metadata, docId } as Record<string, MetadataTypes>,
		});
	}

	/**
	 * 开始文件级事务 — 一个文件的多个 chunk 在同一事务内写入,避免每 chunk 一次事务。
	 */
	async beginFileUpdate(): Promise<void> {
		const index = await this.ensureIndex();
		await index.beginUpdate();
	}

	/**
	 * 提交文件级事务。
	 */
	async endFileUpdate(): Promise<void> {
		const index = await this.ensureIndex();
		await index.endUpdate();
	}

	/**
	 * 取消文件级事务(回滚)。
	 */
	async cancelFileUpdate(): Promise<void> {
		const index = await this.ensureIndex();
		index.cancelUpdate();
	}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/adapters/vector-vectra.test.ts -t "upsertItem" 2>&1`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/ports/vector.ts src/adapters/vector-vectra.ts tests/adapters/vector-vectra.test.ts
git commit -m "feat: VectraStore 新增 upsertItem + 事务方法,支持预计算向量写入"
```

---

## Task 2:IndexProcessor 改为批量 embed + upsertItem

**Files:**
- Modify: `src/worker/index-processor.ts`
- Modify: `tests/worker/index-processor.test.ts`

- [ ] **Step 1: 写失败测试 — 批量 embed 只调一次**

在 `tests/worker/index-processor.test.ts` 顶部 import 区追加:

```typescript
import type { EmbeddingPort } from '../../src/ports/embedding';
```

在 `describe('IndexProcessor', ...)` 块内,`beforeEach` 中替换为:

```typescript
    let store: VectraStore;
    let processor: IndexProcessor;
    let embedCallCount: number;

    const mockEmbedding: EmbeddingPort = {
        dimensions: 512,
        modelId: 'test:mock',
        async embed(texts: string[]): Promise<number[][]> {
            embedCallCount++;
            return texts.map(() => Array(512).fill(0).map(() => Math.random()));
        },
    };

    beforeEach(async () => {
        if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
        fs.mkdirSync(TMP_DIR, { recursive: true });
        embedCallCount = 0;
        store = new VectraStore(TMP_DIR, { embeddings: stubEmbedder, autoInit: true });
        await store.init();
        processor = new IndexProcessor(store, mockEmbedding);
    });
```

在 `describe` 块末尾(`afterEach` 之前)追加新测试:

```typescript
    it('indexIncremental - 批量 embed - 100 chunk 只调 1 次 embed', async () => {
        // 关键路径:生成一个会产生多个 chunk 的长文档
        const longContent = Array(50).fill(null).map((_, i) => `## 标题${i}\n\n这是第${i}段内容,填充一些文字确保分块。`).join('\n\n');
        await processor.indexIncremental({ path: 'long.md', content: longContent });

        // 关键路径:无论多少 chunk,embed 只应被调用 1 次(批量)
        expect(embedCallCount).toBe(1);
    });

    it('indexIncremental - 空文件不触发 embed', async () => {
        await processor.indexIncremental({ path: 'empty.md', content: '' });
        expect(embedCallCount).toBe(0);
    });

    it('indexIncremental - embed 失败不挂整批 - 返回 errors=1', async () => {
        const failEmbedding: EmbeddingPort = {
            dimensions: 512,
            modelId: 'test:fail',
            async embed(): Promise<number[][]> {
                throw new Error('ONNX 推理失败');
            },
        };
        const failProcessor = new IndexProcessor(store, failEmbedding);
        const result = await failProcessor.indexIncremental({ path: 'fail.md', content: 'test content' });
        expect(result.errors).toBe(1);
        expect(result.indexed).toBe(0);
    });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/worker/index-processor.test.ts -t "批量 embed" 2>&1`
Expected: FAIL — `IndexProcessor 构造函数不接受 embeddings 参数`

- [ ] **Step 3: 修改 IndexProcessor — 构造函数 + indexIncremental**

在 `src/worker/index-processor.ts` 中:

1. 顶部 import 区追加:
```typescript
import type { EmbeddingPort } from '../ports/embedding';
```

2. `IndexProcessor` 类的构造函数改为:
```typescript
export class IndexProcessor {
    constructor(
        public store: VectraStore,
        private embeddings: EmbeddingPort,
    ) {}
```

3. `indexIncremental` 方法替换为:
```typescript
    async indexIncremental(
        file: IndexFile,
        onProgress?: (e: ProgressEvent) => void,
    ): Promise<{ indexed: number; errors: number }> {
        let indexed = 0;
        let errors = 0;
        try {
            const chunks = chunkMarkdown(file.content, 500, 100);
            if (chunks.length === 0) {
                onProgress?.({ done: 1, total: 1 });
                return { indexed: 0, errors: 0 };
            }

            // 关键路径:一次性批量 embed 所有 chunk 文本,ONNX 调用从 N 降到 N/16。
            const chunkTexts = chunks.map((c) => c.text);
            const vectors = await this.embeddings.embed(chunkTexts);

            // 关键路径:一个文件一个事务,避免每 chunk 一次事务。
            await this.store.beginFileUpdate();
            for (const [idx, chunk] of chunks.entries()) {
                await this.store.upsertItem(
                    `${file.path}#chunk-${idx}`,
                    vectors[idx]!,
                    { path: file.path, chunkIndex: idx, startOffset: chunk.startOffset },
                );
            }
            await this.store.endFileUpdate();
            indexed = 1;
        } catch (err) {
            // 关键路径:事务回滚,避免半写入的脏数据。
            try { await this.store.cancelFileUpdate(); } catch { /* 忽略回滚失败 */ }
            devLogger.error('index', `failed to index ${file.path}`, err);
            errors = 1;
        }
        onProgress?.({ done: 1, total: 1 });
        return { indexed, errors };
    }
```

- [ ] **Step 4: 修改 indexFull — 同样改为批量 embed**

将 `indexFull` 方法替换为:

```typescript
    async indexFull(
        files: IndexFile[],
        onProgress?: (e: ProgressEvent) => void,
    ): Promise<{ indexed: number; errors: number }> {
        let indexed = 0;
        let errors = 0;

        for (const [i, file] of files.entries()) {
            try {
                const chunks = chunkMarkdown(file.content, 500, 100);
                if (chunks.length === 0) {
                    indexed++;
                    onProgress?.({ done: i + 1, total: files.length });
                    continue;
                }

                // 关键路径:一次性批量 embed 所有 chunk 文本。
                const chunkTexts = chunks.map((c) => c.text);
                const vectors = await this.embeddings.embed(chunkTexts);

                await this.store.beginFileUpdate();
                for (const [idx, chunk] of chunks.entries()) {
                    await this.store.upsertItem(
                        `${file.path}#chunk-${idx}`,
                        vectors[idx]!,
                        { path: file.path, chunkIndex: idx, startOffset: chunk.startOffset },
                    );
                }
                await this.store.endFileUpdate();
                indexed++;
            } catch (err) {
                try { await this.store.cancelFileUpdate(); } catch { /* 忽略回滚失败 */ }
                devLogger.error('index', `failed to index ${file.path}`, err);
                errors++;
            }
            onProgress?.({ done: i + 1, total: files.length });
        }

        return { indexed, errors };
    }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/worker/index-processor.test.ts 2>&1`
Expected: PASS — 所有测试通过

- [ ] **Step 6: 提交**

```bash
git add src/worker/index-processor.ts tests/worker/index-processor.test.ts
git commit -m "feat: IndexProcessor 改为批量 embed + upsertItem,ONNX 调用从 N 降到 N/16"
```

---

## Task 3:handler.ts + inline-worker.ts 传递 embeddings

**Files:**
- Modify: `src/worker/handler.ts`
- Modify: `src/worker/inline-worker.ts`
- Test: `tests/worker/handler.test.ts`

- [ ] **Step 1: 修改 handler.ts — initProcessorWithStore 新增 embeddings 参数**

在 `src/worker/handler.ts` 中:

1. 顶部 import 区追加:
```typescript
import type { EmbeddingPort } from '../ports/embedding';
```

2. `initProcessorWithStore` 函数改为:
```typescript
export function initProcessorWithStore(store: VectraStore, embeddings: EmbeddingPort): void {
    processor = new IndexProcessor(store, embeddings);
}
```

- [ ] **Step 2: 修改 inline-worker.ts — initWithStore 新增 embeddings 参数**

在 `src/worker/inline-worker.ts` 中:

1. 顶部 import 区追加:
```typescript
import type { EmbeddingPort } from '../ports/embedding';
```

2. `initWithStore` 方法改为:
```typescript
	initWithStore(store: VectraStore, embeddings: EmbeddingPort): void {
		initProcessorWithStore(store, embeddings);
		this.initialized = true;
	}
```

- [ ] **Step 3: 更新 handler.test.ts 中的 initProcessorWithStore 调用**

Run: `npx vitest run tests/worker/handler.test.ts 2>&1`
如果有 `initProcessorWithStore(store)` 调用报错,改为 `initProcessorWithStore(store, mockEmbedding)`,其中 mockEmbedding 是一个简单的 `EmbeddingPort` mock:

```typescript
const mockEmbedding: EmbeddingPort = {
    dimensions: 512,
    modelId: 'test:mock',
    async embed(texts: string[]): Promise<number[][]> {
        return texts.map(() => Array(512).fill(0));
    },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/worker/handler.test.ts tests/worker/inline-worker.test.ts 2>&1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/worker/handler.ts src/worker/inline-worker.ts tests/worker/handler.test.ts tests/worker/inline-worker.test.ts
git commit -m "refactor: handler/inline-worker 传递 EmbeddingPort 给 IndexProcessor"
```

---

## Task 4:EmbeddingWorkerProxy — Web Worker 代理

**Files:**
- Create: `src/adapters/embedding-worker-proxy.ts`
- Test: `tests/adapters/embedding-worker-proxy.test.ts`

- [ ] **Step 1: 写失败测试 — init 完成 + embed 请求/响应**

创建 `tests/adapters/embedding-worker-proxy.test.ts`:

```typescript
/**
 * @file tests/adapters/embedding-worker-proxy.test.ts
 * @description EmbeddingWorkerProxy 行为 — init/ready/embed/error/terminate
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingWorkerProxy } from '../../src/adapters/embedding-worker-proxy';

/**
 * Mock Worker — 模拟 Web Worker 的 postMessage/onmessage 行为。
 */
class MockWorker {
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: ErrorEvent) => void) | null = null;
	postMessage = vi.fn((data: unknown) => {
		// 模拟 Worker 异步响应
		setTimeout(() => {
			if (this.onmessage === null) return;
			const msg = data as { type: string };
			if (msg.type === 'init') {
				this.onmessage({ data: { type: 'ready' } } as MessageEvent);
			}
		}, 0);
	});
	terminate = vi.fn();
	addEventListener = vi.fn((event: string, listener: (e: any) => void) => {
		if (event === 'message') this.onmessage = listener;
		if (event === 'error') this.onerror = listener;
	});
	removeEventListener = vi.fn();
}

// 关键路径:mock global.Worker
const originalWorker = global.Worker;

describe('EmbeddingWorkerProxy', () => {
	let mockWorker: MockWorker;

	beforeEach(() => {
		mockWorker = new MockWorker();
		(global as any).Worker = vi.fn(() => mockWorker);
	});

	afterEach(() => {
		(global as any).Worker = originalWorker;
	});

	it('init - 收到 ready 后 embed 可用', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabPath: '/vocab', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);

		// 关键路径:ready 之前 embed 会 await
		// 模拟 Worker 收到 embed 请求后返回向量
		const embedPromise = proxy.embed(['hello']);
		// 等一个 macrotask 让 postMessage 被调用
		await new Promise((r) => setTimeout(r, 10));

		// 找到 embed 请求的 postMessage 调用
		const embedCall = mockWorker.postMessage.mock.calls.find(
			(call: unknown[]) => (call[0] as { type: string }).type === 'embed',
		);
		expect(embedCall).toBeDefined();

		const requestId = (embedCall![0] as { requestId: string }).requestId;
		// 模拟 Worker 返回向量
		mockWorker.onmessage?.({
			data: { type: 'embed:result', requestId, vectors: [[0.1, 0.2, 0.3]] },
		} as MessageEvent);

		const vectors = await embedPromise;
		expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
	});

	it('embed - 空数组不调 postMessage', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabPath: '/vocab', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);
		await new Promise((r) => setTimeout(r, 10)); // 等 init

		const result = await proxy.embed([]);
		expect(result).toEqual([]);
		// 只有 init 的 postMessage,没有 embed 的
		expect(mockWorker.postMessage).toHaveBeenCalledTimes(1);
	});

	it('terminate - Worker 被 terminate', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabPath: '/vocab', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);
		await new Promise((r) => setTimeout(r, 10));

		proxy.terminate();
		expect(mockWorker.terminate).toHaveBeenCalled();
	});

	it('Worker onerror - pending 请求被 reject', async () => {
		const proxy = new EmbeddingWorkerProxy(
			'mock-url',
			{ vocabPath: '/vocab', modelBuffer: new ArrayBuffer(0), wasmBinary: new ArrayBuffer(0) },
			512,
		);
		await new Promise((r) => setTimeout(r, 10));

		const embedPromise = proxy.embed(['test']);
		await new Promise((r) => setTimeout(r, 10));

		// 模拟 Worker 崩溃
		mockWorker.onerror?.(new ErrorEvent('error', { message: 'WASM crash' }));

		await expect(embedPromise).rejects.toThrow('WASM crash');
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/adapters/embedding-worker-proxy.test.ts 2>&1`
Expected: FAIL — `Cannot find module '../../src/adapters/embedding-worker-proxy'`

- [ ] **Step 3: 实现 EmbeddingWorkerProxy**

创建 `src/adapters/embedding-worker-proxy.ts`:

```typescript
/**
 * @file src/adapters/embedding-worker-proxy.ts
 * @description EmbeddingWorkerProxy — Web Worker 代理,实现 EmbeddingPort,ONNX 推理在 Worker 线程
 * @module adapters/embedding-worker-proxy
 * @depends ports/embedding, adapters/embedding-onnx
 *
 * 设计要点:
 * - 实现 EmbeddingPort 接口,对上层(IndexProcessor / SearchVault)透明。
 * - postMessage 到 Web Worker,Worker 内跑 EmbeddingOnnx 的 ONNX WASM 推理。
 * - 请求/响应用 requestId 关联,支持并发 embed 请求。
 * - Worker 创建失败不降级,由调用方处理(提示用户接 API Embedding)。
 */

import type { EmbeddingPort } from '../ports/embedding';
import type { EmbeddingOnnxDeps } from './embedding-onnx';

/**
 * Web Worker 消息类型 — 主线程 → Worker。
 */
interface WorkerInitMessage {
	type: 'init';
	deps: EmbeddingOnnxDeps;
	dimensions: number;
	maxBatchSize: number;
}

interface WorkerEmbedMessage {
	type: 'embed';
	texts: string[];
	requestId: string;
}

type WorkerRequest = WorkerInitMessage | WorkerEmbedMessage;

/**
 * Web Worker 消息类型 — Worker → 主线程。
 */
interface WorkerReadyMessage {
	type: 'ready';
}

interface WorkerEmbedResultMessage {
	type: 'embed:result';
	requestId: string;
	vectors: number[][];
}

interface WorkerErrorMessage {
	type: 'error';
	requestId?: string;
	error: string;
}

type WorkerResponse = WorkerReadyMessage | WorkerEmbedResultMessage | WorkerErrorMessage;

/**
 * EmbeddingWorkerProxy — Web Worker 代理实现 EmbeddingPort。
 *
 * 设计要点:
 * - 构造时创建 Worker 并发送 init 消息(含模型依赖)。
 * - `ready` Promise 在 Worker 返回 ready 后 resolve;之前所有 embed 调用 await。
 * - embed 请求用自增 requestId 关联响应,支持并发。
 * - Worker 崩溃时所有 pending 请求 reject。
 * - 模型依赖(ArrayBuffer)用 transferable 转移所有权,避免复制大文件。
 *
 * @example
 *   const proxy = new EmbeddingWorkerProxy(workerUrl, deps, 512);
 *   await proxy.ready;
 *   const vectors = await proxy.embed(['hello world']);
 */
export class EmbeddingWorkerProxy implements EmbeddingPort {
	readonly dimensions: number;
	readonly modelId: string;
	private worker: Worker;
	private readyPromise: Promise<void>;
	private pending = new Map<string, (vectors: number[][]) => void>();
	private pendingError = new Map<string, (err: Error) => void>();
	private requestCounter = 0;

	constructor(
		workerUrl: string,
		deps: EmbeddingOnnxDeps,
		dimensions: number,
		maxBatchSize = 16,
	) {
		this.dimensions = dimensions;
		this.modelId = deps.modelId ?? 'local:bge-small-zh-v1.5';
		this.worker = new Worker(workerUrl);

		// 关键路径:init 完成前 ready 不 resolve;init 失败则 reject。
		this.readyPromise = new Promise((resolve, reject) => {
			const onInitMessage = (e: MessageEvent) => {
				const data = e.data as WorkerResponse;
				if (data.type === 'ready') {
					resolve();
				} else if (data.type === 'error' && !data.requestId) {
					reject(new Error(data.error));
				}
			};
			this.worker.addEventListener('message', onInitMessage);
		});

		// 关键路径:init 完成后的常规消息处理(embed:result / error)。
		this.worker.addEventListener('message', (e: MessageEvent) => {
			const data = e.data as WorkerResponse;
			if (data.type === 'embed:result') {
				const resolve = this.pending.get(data.requestId);
				if (resolve) {
					resolve(data.vectors);
					this.pending.delete(data.requestId);
					this.pendingError.delete(data.requestId);
				}
			} else if (data.type === 'error' && data.requestId) {
				const reject = this.pendingError.get(data.requestId);
				if (reject) {
					reject(new Error(data.error));
					this.pending.delete(data.requestId);
					this.pendingError.delete(data.requestId);
				}
			}
		});

		// 关键路径:Worker 崩溃时所有 pending 请求 reject。
		this.worker.addEventListener('error', (err: ErrorEvent) => {
			for (const [, reject] of this.pendingError) {
				reject(new Error(`Embedding Worker 崩溃: ${err.message}`));
			}
			this.pending.clear();
			this.pendingError.clear();
		});

		// 关键路径:发送 init 消息,用 transferable 转移 ArrayBuffer 所有权。
		const initMsg: WorkerInitMessage = { type: 'init', deps, dimensions, maxBatchSize };
		const transferables = [deps.modelBuffer, deps.wasmBinary];
		this.worker.postMessage(initMsg, transferables);
	}

	/**
	 * Worker init 完成的 Promise。调用方可 await 确保 Worker 就绪。
	 */
	get ready(): Promise<void> {
		return this.readyPromise;
	}

	/**
	 * 批量生成文本向量。
	 *
	 * @param texts - 待编码文本数组。
	 * @returns 与 texts 等长的向量数组。
	 * @throws Worker 未就绪、推理失败或 Worker 崩溃时抛错。
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		await this.readyPromise;

		const requestId = `embed_${++this.requestCounter}`;
		return new Promise((resolve, reject) => {
			this.pending.set(requestId, resolve);
			this.pendingError.set(requestId, reject);
			const msg: WorkerEmbedMessage = { type: 'embed', texts, requestId };
			this.worker.postMessage(msg);
		});
	}

	/**
	 * 终止 Worker — 释放 Worker 线程资源。
	 */
	terminate(): void {
		this.worker.terminate();
		for (const [, reject] of this.pendingError) {
			reject(new Error('Embedding Worker 已终止'));
		}
		this.pending.clear();
		this.pendingError.clear();
	}
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/adapters/embedding-worker-proxy.test.ts 2>&1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/embedding-worker-proxy.ts tests/adapters/embedding-worker-proxy.test.ts
git commit -m "feat: EmbeddingWorkerProxy — Web Worker 代理实现 EmbeddingPort"
```

---

## Task 5:embedding-worker.ts — Web Worker 入口

**Files:**
- Create: `src/worker/embedding-worker.ts`
- Test: `tests/worker/embedding-worker.test.ts`

- [ ] **Step 1: 写失败测试 — init ready + embed 返回向量**

创建 `tests/worker/embedding-worker.test.ts`:

```typescript
/**
 * @file tests/worker/embedding-worker.test.ts
 * @description embedding-worker.ts Worker 入口行为 — init/embed/error
 */

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

/**
 * 关键路径:embedding-worker.ts 使用 self.onmessage / self.postMessage,
 * 测试中 mock self 的 postMessage 和模拟 onmessage 调用。
 */

describe('embedding-worker', () => {
	it('init - 收到 init 消息后回复 ready', async () => {
		const postMessageSpy = vi.fn();
		const messages: Array<(e: MessageEvent) => void> = [];

		// 关键路径:mock self
		const originalPostMessage = (self as any).postMessage;
		const originalOnmessage = (self as any).onmessage;
		(self as any).postMessage = postMessageSpy;
		Object.defineProperty(self, 'onmessage', {
			set: (fn: (e: MessageEvent) => void) => messages.push(fn),
			get: () => messages[messages.length - 1],
			configurable: true,
		});

		// 动态 import(确保 mock 生效)
		await import('../../src/worker/embedding-worker');

		// 模拟主线程发 init 消息
		const initEvent = {
			data: {
				type: 'init',
				deps: {
					vocabPath: '/vocab',
					modelBuffer: new ArrayBuffer(0),
					wasmBinary: new ArrayBuffer(0),
				},
				dimensions: 512,
				maxBatchSize: 16,
			},
		} as MessageEvent;

		// 调用 onmessage
		const onmessage = (self as any).onmessage;
		if (typeof onmessage === 'function') {
			await onmessage(initEvent);
		}

		// 关键路径:init 后应 postMessage ready
		expect(postMessageSpy).toHaveBeenCalledWith({ type: 'ready' });

		// 恢复
		(self as any).postMessage = originalPostMessage;
		(self as any).onmessage = originalOnmessage;
	});

	it('embed - 未 init 时回复 error', async () => {
		const postMessageSpy = vi.fn();
		const messages: Array<(e: MessageEvent) => void> = [];

		(self as any).postMessage = postMessageSpy;
		Object.defineProperty(self, 'onmessage', {
			set: (fn: (e: MessageEvent) => void) => messages.push(fn),
			get: () => messages[messages.length - 1],
			configurable: true,
		});

		await import('../../src/worker/embedding-worker');

		// 关键路径:未 init 直接发 embed
		const embedEvent = {
			data: { type: 'embed', texts: ['hello'], requestId: 'req_1' },
		} as MessageEvent;

		const onmessage = (self as any).onmessage;
		if (typeof onmessage === 'function') {
			await onmessage(embedEvent);
		}

		// 关键路径:应回复 error
		expect(postMessageSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'error',
				requestId: 'req_1',
			}),
		);
	});
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/worker/embedding-worker.test.ts 2>&1`
Expected: FAIL — `Cannot find module '../../src/worker/embedding-worker'`

- [ ] **Step 3: 实现 embedding-worker.ts**

创建 `src/worker/embedding-worker.ts`:

```typescript
/**
 * @file src/worker/embedding-worker.ts
 * @description Web Worker 入口 — 加载 ONNX runtime,处理 embed 请求,不依赖 Node API
 * @module worker/embedding-worker
 * @depends adapters/embedding-onnx
 *
 * 硬约束:
 * - 严禁 `import 'obsidian'`
 * - 不发 HTTP 请求(纯 CPU WASM 推理)
 * - 不使用 `node:fs` / `node:path`(纯浏览器环境)
 * - 与主线程通过 postMessage 通信
 *
 * 设计要点:
 * - 主线程在构造时传入 modelBuffer + vocabPath + wasmBinary,Worker 内部初始化 EmbeddingOnnx。
 * - init 完成后回复 ready,之前所有 embed 请求回复 error。
 * - embed 请求用 requestId 关联响应。
 */

import { EmbeddingOnnx } from '../adapters/embedding-onnx';
import type { EmbeddingOnnxDeps } from '../adapters/embedding-onnx';

let embeddingOnnx: EmbeddingOnnx | null = null;

self.onmessage = async (e: MessageEvent): Promise<void> => {
	const msg = e.data;

	switch (msg.type) {
		case 'init': {
			try {
				const deps = msg.deps as EmbeddingOnnxDeps;
				const dimensions = msg.dimensions as number;
				const maxBatchSize = msg.maxBatchSize as number;
				embeddingOnnx = new EmbeddingOnnx(deps, dimensions, maxBatchSize);
				await embeddingOnnx.init();
				self.postMessage({ type: 'ready' });
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				self.postMessage({ type: 'error', error: `初始化失败: ${error}` });
			}
			break;
		}
		case 'embed': {
			if (!embeddingOnnx) {
				self.postMessage({
					type: 'error',
					requestId: msg.requestId,
					error: 'Worker 未初始化,请先发送 init 消息',
				});
				return;
			}
			try {
				const vectors = await embeddingOnnx.embed(msg.texts as string[]);
				self.postMessage({
					type: 'embed:result',
					requestId: msg.requestId,
					vectors,
				});
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				self.postMessage({
					type: 'error',
					requestId: msg.requestId,
					error: `推理失败: ${error}`,
				});
			}
			break;
		}
	}
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/worker/embedding-worker.test.ts 2>&1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/worker/embedding-worker.ts tests/worker/embedding-worker.test.ts
git commit -m "feat: embedding-worker.ts — Web Worker 入口,ONNX 推理在 Worker 线程"
```

---

## Task 6:esbuild 新增 embedding-worker.js 打包入口

**Files:**
- Modify: `esbuild.config.mjs`

- [ ] **Step 1: 新增 embeddingWorkerContext**

在 `esbuild.config.mjs` 中,`workerContext` 定义之后(`if (prod)` 之前)追加:

```javascript
// Embedding Worker bundle (Web Worker, browser platform)
// 关键路径:ONNX 推理在 Web Worker 中执行,platform 必须为 browser(不依赖 Node API)。
// format: iife — Web Worker 需要自执行,IIFE 格式最兼容。
const embeddingWorkerContext = await esbuild.context({
	entryPoints: ['src/worker/embedding-worker.ts'],
	bundle: true,
	platform: 'browser',
	format: 'iife',
	target: 'es2021',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'dist/embedding-worker.js',
	minify: prod,
	alias: {
		'onnxruntime-web': path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'),
		'onnxruntime-node': path.resolve(__dirname, 'src/adapters/empty-module.cjs'),
		'@huggingface/transformers': path.resolve(__dirname, 'src/adapters/empty-transformers.cjs'),
	},
	plugins: [externalOnnxruntimeNodePlugin()],
});
```

- [ ] **Step 2: 在 prod/watch 分支中添加 embeddingWorkerContext**

将 `if (prod)` 块改为:

```javascript
if (prod) {
	const mainResult = await mainContext.rebuild();
	await workerContext.rebuild();
	await embeddingWorkerContext.rebuild();
	if (mainResult.metafile) {
		await import('node:fs/promises').then(({ writeFile }) =>
			writeFile(path.join(__dirname, 'dist', 'meta-main.json'), JSON.stringify(mainResult.metafile)),
		);
	}
	process.exit(0);
} else {
	await mainContext.watch();
	await workerContext.watch();
	await embeddingWorkerContext.watch();
}
```

- [ ] **Step 3: 验证构建**

Run: `npm run build 2>&1 | tail -5`
Expected: 构建成功,`dist/embedding-worker.js` 文件存在

- [ ] **Step 4: 提交**

```bash
git add esbuild.config.mjs
git commit -m "build: esbuild 新增 embedding-worker.js 打包入口(Web Worker)"
```

---

## Task 7:main.ts 集成 EmbeddingWorkerProxy

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: 修改 main.ts — 创建 EmbeddingWorkerProxy**

在 `src/main.ts` 中:

1. 顶部 import 区追加:
```typescript
import { EmbeddingWorkerProxy } from './adapters/embedding-worker-proxy';
```

2. 在 `onLayoutReady` 中,`this.inlineWorker.initWithStore(this.vectraStore)` 那一行(L367-368)替换为:

```typescript
				if (this.inlineWorker) {
					// 关键路径:创建 Web Worker proxy,ONNX 推理在 Worker 线程执行。
					const workerUrl = this.app.vault.adapter.resourcePathNormalized(
						this.manifest.dir + '/dist/embedding-worker.js',
					);
					try {
						const proxy = new EmbeddingWorkerProxy(
							workerUrl,
							{
								vocabPath: (this.modelManager as any).cacheDir + '/vocab.txt',
								modelBuffer: (embedding as any).deps?.modelBuffer ?? new ArrayBuffer(0),
								wasmBinary: (embedding as any).deps?.wasmBinary ?? new ArrayBuffer(0),
							},
							embedding.dimensions,
						);
						await proxy.ready;
						this.vectraStore = this.createVectraStore();
						this.inlineWorker.initWithStore(this.vectraStore, proxy);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						throw new Error(
							`本地 Embedding Worker 初始化失败: ${message}。请在设置中配置 API Embedding 端点(如 Ollama)后重启插件。`,
						);
					}
				}
```

3. 新增 `createVectraStore` 方法(不带 embeddings,因为 IndexProcessor 自己调 embed):

```typescript
	/**
	 * 创建不带 embeddings 的 VectraStore。
	 *
	 * 关键路径:IndexProcessor 现在自己调 EmbeddingPort.embed 批量推理,
	 * vectra 的 upsertDocument 不再被调用(改用 upsertItem 写预计算向量),
	 * 所以 VectraStore 不需要 embeddings 配置。
	 */
	private createVectraStore(): VectraStore {
		return new VectraStore(this.indexDir, { autoInit: true });
	}
```

- [ ] **Step 2: 运行全量测试**

Run: `npx vitest run 2>&1 | tail -10`
Expected: PASS — 无 regression

- [ ] **Step 3: 验证构建**

Run: `npm run build 2>&1 | tail -5`
Expected: 构建成功

- [ ] **Step 4: 提交**

```bash
git add src/main.ts
git commit -m "feat: main.ts 集成 EmbeddingWorkerProxy,ONNX 推理移入 Web Worker"
```

---

## Task 8:全量测试 + 构建验证

- [ ] **Step 1: 全量测试**

Run: `npx vitest run 2>&1`
Expected: 所有测试通过(3 个 llm-deepseek 401 为预存在的认证问题)

- [ ] **Step 2: 生产构建**

Run: `npm run build 2>&1`
Expected: 构建成功,`dist/` 包含 `main.js`、`worker.js`、`embedding-worker.js`

- [ ] **Step 3: 更新 STATUS.md**

在 `docs/superpowers/STATUS.md` 的 Plan 表中追加:

```markdown
| **P-INDEX-BLOCK** | [2026-06-27-index-ui-blocking-implementation.md](plans/2026-06-27-index-ui-blocking-implementation.md) | ✅ Completed | main | 2026-06-27 | 2026-06-27 | S-INDEX-BLOCK |
```

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/STATUS.md docs/superpowers/plans/2026-06-27-index-ui-blocking-implementation.md
git commit -m "docs: 索引阻塞 UI 修复 plan 完成,更新 STATUS.md"
```

---

## Self-Review

### 1. Spec coverage

| Spec 要求 | 对应 Task |
|-----------|-----------|
| P0: 批量 embed 替代逐 chunk upsert | Task 1(upsertItem)+ Task 2(IndexProcessor 改造) |
| P0: VectraStore 新增 upsertItem + 事务 | Task 1 |
| P1: EmbeddingWorkerProxy | Task 4 |
| P1: embedding-worker.ts | Task 5 |
| P1: esbuild 新增入口 | Task 6 |
| P1: main.ts 集成 | Task 7 |
| P1: handler/inline-worker 传递 embeddings | Task 3 |
| 错误处理:不降级直接报错 | Task 7(try/catch + throw) |
| 测试:批量 embed 只调 1 次 | Task 2 |
| 测试:Proxy init/embed/error/terminate | Task 4 |
| 测试:Worker init/embed error | Task 5 |

### 2. Placeholder scan

- 无 TBD/TODO
- 所有代码步骤都有完整代码
- 所有测试步骤都有完整测试代码
- 所有命令都有预期输出

### 3. Type consistency

- `EmbeddingPort` 接口在所有 Task 中一致:`embed(texts: string[]): Promise<number[][]>`
- `upsertItem` 签名在 Task 1(端口+实现)和 Task 2(调用方)中一致
- `initProcessorWithStore(store, embeddings)` 在 Task 3(handler 定义)和 Task 7(main.ts 调用)中一致
- `EmbeddingWorkerProxy` 构造函数在 Task 4(定义)和 Task 7(调用)中一致
