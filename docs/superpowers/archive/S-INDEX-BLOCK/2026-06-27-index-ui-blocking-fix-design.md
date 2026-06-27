# Spec:索引阻塞 UI 修复 — 批量 Embedding + Web Worker 推理

**Spec ID**:S-INDEX-BLOCK
**状态**:Active
**日期**:2026-06-27
**关联 ADR**:ADR-005(索引阻塞 UI 的根因与修复策略)、ADR-002(Worker 运行时策略,本 spec 修正其 Web Worker 排除结论)

---

## 背景

用户报告:每次文档新增/变更触发索引时,Obsidian 页面不可点击、文档不可用,持续数秒到数十秒。全量索引期间整个 Obsidian 基本不可用。

AGENTS.md 架构设计明确要求"重活(索引)推给 Worker",`src/worker/index.ts` Worker 入口也存在。实际实现中所有 CPU 密集型操作(文本分块 + ONNX 向量推理)都在主线程同步执行,没有任何让出主线程的机制。

### 两层根因

**根因 1(实现层)**:`IndexProcessor` 逐 chunk 调用 `store.upsert`,每次触发 vectra 内部单独一次 ONNX 推理。`EmbeddingOnnx` 的 `maxBatchSize=16` 分批逻辑因 vectra 逐条调用而从未生效。100 chunk = 100 次独立 ONNX `session.run()`。

**根因 2(架构层)**:ADR-002 因"vectra 需要 fs"排除了 Web Worker,但真正阻塞 UI 的 ONNX 推理不需要 fs。ONNX WASM `session.run()` 是同步调用,执行期间主线程完全阻塞。

详见 ADR-005。

---

## 目标

1. **P0 — 批量 embed**:修复 `IndexProcessor` 逐 chunk upsert 问题,改为一次性批量 embed 所有 chunk,ONNX 调用次数从 N 降到 N/16
2. **P1 — Web Worker 推理**:将 ONNX 推理移入 Web Worker,索引期间主线程零 CPU 阻塞,落实 AGENTS.md"重活推给 Worker"设计意图
3. **不降级**:Web Worker 创建失败直接报错,提示用户配置 API Embedding 端点

## 非目标

- ~~P2(API Embedding 为默认)~~:本地 ONNX 是插件内置能力,保持默认。P1 Web Worker 已解决阻塞
- 不改 `chunkMarkdown` 分块逻辑(保留标题→段落→句子四级回退)
- 不改 `FolderWatcher` / `IndexController` / `IndexManager` 调度逻辑
- 不改 vectra 索引磁盘结构
- 不改 `EmbeddingPort` 接口

---

## 详细设计

### 架构总览

```
┌─── 主线程 ─────────────────────────────────────────────┐
│                                                         │
│  FolderWatcher → IndexController → IndexManager         │
│                                       │                 │
│                                       ▼                 │
│                                  IndexProcessor          │
│                                   │      │              │
│              ┌────────────────────┘      │              │
│              ▼                           ▼              │
│      chunkMarkdown()              EmbeddingWorkerProxy  │
│      (语义分块,保留)              (实现 EmbeddingPort) │
│              │                           │              │
│              │                    postMessage           │
│              │                           │              │
│              │    ┌─── Web Worker ───────▼──────────┐  │
│              │    │  EmbeddingOnnx                   │  │
│              │    │  ├─ BertTokenizer.encode         │  │
│              │    │  └─ ONNX session.run() ← WASM   │  │
│              │    └──────────────┬──────────────────┘  │
│              │           vectors[]│(返回)               │
│              ▼                   │                     │
│      VectraStore.upsertItem()    │                     │
│      (预计算向量写入磁盘)        │                     │
│              │                                         │
│              ▼                                         │
│         vectra LocalIndex (fs IO)                      │
└─────────────────────────────────────────────────────────┘
```

**核心变化:**
1. `EmbeddingWorkerProxy` 替代 `EmbeddingOnnx` 直接调用——实现同一个 `EmbeddingPort` 接口,内部 postMessage 到 Web Worker
2. Web Worker 中跑 `EmbeddingOnnx`(ONNX WASM 推理完全在 Worker 线程)
3. `IndexProcessor` 改为:先 `chunkMarkdown` 分块 → 一次性 `embeddings.embed(allChunkTexts)` 批量推理 → 用 `VectraStore.upsertItem(vector)` 写入预计算向量
4. `VectraStore` 新增 `upsertItem` 方法,绕过 vectra 的 `upsertDocument`(后者内部会调 embedding,我们已自己算好向量)
5. Web Worker 创建失败直接报错,UI 提示用户配置 API Embedding 端点

### P0:批量 embed 替代逐 chunk upsert

#### IndexProcessor 改造

`IndexProcessor` 需要持有 `EmbeddingPort` 引用(而非只持有 `VectraStore`),因为现在由 IndexProcessor 主动调 embed。

```typescript
// src/worker/index-processor.ts — 修改后
export class IndexProcessor {
    constructor(
        public store: VectraStore,
        private embeddings: EmbeddingPort,  // 新增
    ) {}

    async indexIncremental(file: IndexFile): Promise<{indexed: number; errors: number}> {
        const chunks = chunkMarkdown(file.content, 500, 100);
        if (chunks.length === 0) return { indexed: 0, errors: 0 };

        try {
            // 关键路径:一次性批量 embed 所有 chunk 文本,ONNX 调用从 N 降到 N/16
            const chunkTexts = chunks.map(c => c.text);
            const vectors = await this.embeddings.embed(chunkTexts);

            // 用预计算向量写入 vectra,一个文件一个事务
            await this.store.beginFileUpdate();
            for (const [idx, chunk] of chunks.entries()) {
                await this.store.upsertItem(
                    `${file.path}#chunk-${idx}`,
                    vectors[idx],
                    { path: file.path, chunkIndex: idx, startOffset: chunk.startOffset },
                );
            }
            await this.store.endFileUpdate();
            return { indexed: 1, errors: 0 };
        } catch (err) {
            await this.store.cancelFileUpdate();
            devLogger.error('index', `failed to index ${file.path}`, err);
            return { indexed: 0, errors: 1 };
        }
    }

    // indexFull 同理:逐文件 chunkMarkdown → embed → upsertItem
}
```

#### VectraStore 新增方法

```typescript
// src/adapters/vector-vectra.ts — 新增
async beginFileUpdate(): Promise<void> {
    const index = await this.ensureIndex();
    await index.beginUpdate();
}

async endFileUpdate(): Promise<void> {
    const index = await this.ensureIndex();
    await index.endUpdate();
}

async cancelFileUpdate(): Promise<void> {
    const index = await this.ensureIndex();
    index.cancelUpdate();
}

async upsertItem(docId: string, vector: number[], metadata?: Record<string, unknown>): Promise<void> {
    const index = await this.ensureIndex();
    // 关键路径:绕过 upsertDocument(它会调 embedding),直接用 LocalIndex.upsertItem 写入预计算向量
    await index.upsertItem({
        id: docId,
        vector,
        metadata: { ...metadata, docId } as Record<string, MetadataTypes>,
    });
}
```

**关键设计决策:**
- 一个文件的多个 chunk 在同一个事务内写入(`beginFileUpdate` / `endFileUpdate`),避免每 chunk 一次事务
- vectra 的 `LocalDocumentIndex extends LocalIndex`,可以直接调 `upsertItem` / `beginUpdate` / `endUpdate` / `cancelUpdate`
- vectra 的 `LocalDocumentIndex` 不再需要 `embeddings` 配置(我们不调 `upsertDocument` 了),但保留构造时的 `embeddings` 参数以兼容 `queryDocuments`(搜索时仍可能用到)

### P1:ONNX 推理移入 Web Worker

#### 新建:`src/worker/embedding-worker.ts`

Web Worker 入口,加载 ONNX runtime + 处理推理请求。

```typescript
// src/worker/embedding-worker.ts
import { EmbeddingOnnx } from '../adapters/embedding-onnx';

let embeddingOnnx: EmbeddingOnnx | null = null;

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    switch (msg.type) {
        case 'init':
            // 主线程传入 modelBuffer + vocabPath + wasmBinary
            embeddingOnnx = new EmbeddingOnnx(msg.deps, msg.dimensions, msg.maxBatchSize);
            await embeddingOnnx.init();
            self.postMessage({ type: 'ready' });
            break;
        case 'embed':
            if (!embeddingOnnx) {
                self.postMessage({ type: 'error', requestId: msg.requestId, error: 'Worker not initialized' });
                return;
            }
            const vectors = await embeddingOnnx.embed(msg.texts);
            self.postMessage({ type: 'embed:result', requestId: msg.requestId, vectors });
            break;
    }
};
```

**约束:**
- 严禁 `import 'obsidian'`
- 不发 HTTP 请求(只做纯 CPU WASM 推理)
- 不使用 `node:fs` / `node:path`(纯浏览器环境)

**ArrayBuffer 传输注意:** `deps` 中的 `modelBuffer` 和 `wasmBinary` 是 ArrayBuffer。`postMessage` 默认用 structured clone 复制 ArrayBuffer(不转移所有权)。若用 transferable list(`postMessage(msg, [msg.deps.modelBuffer, msg.deps.wasmBinary])`)则转移所有权,主线程不再可用。由于 main.ts 读取后不再需要这两个 buffer(只传给 Worker),**使用 transferable 转移所有权更高效**,避免复制大文件(模型 ~40MB + WASM ~10MB)。

#### 新建:`src/adapters/embedding-worker-proxy.ts`

实现 `EmbeddingPort`,内部 postMessage 到 Worker。

```typescript
// src/adapters/embedding-worker-proxy.ts
export class EmbeddingWorkerProxy implements EmbeddingPort {
    readonly dimensions: number;
    readonly modelId: string;
    private worker: Worker;
    private ready: Promise<void>;
    private pending = new Map<string, (vectors: number[][]) => void>();
    private pendingError = new Map<string, (err: Error) => void>();
    private requestCounter = 0;

    constructor(workerUrl: string, deps: EmbeddingOnnxDeps, dimensions: number, maxBatchSize = 16) {
        this.dimensions = dimensions;
        this.modelId = deps.modelId ?? 'local:bge-small-zh-v1.5';
        this.worker = new Worker(workerUrl);

        this.ready = new Promise((resolve, reject) => {
            const onMessage = (e: MessageEvent) => {
                if (e.data.type === 'ready') {
                    resolve();
                } else if (e.data.type === 'error' && !e.data.requestId) {
                    reject(new Error(e.data.error));
                }
            };
            this.worker.addEventListener('message', onMessage);
        });

        // 常规消息处理(init 完成后)
        this.worker.addEventListener('message', (e: MessageEvent) => {
            if (e.data.type === 'embed:result') {
                const resolve = this.pending.get(e.data.requestId);
                if (resolve) {
                    resolve(e.data.vectors);
                    this.pending.delete(e.data.requestId);
                    this.pendingError.delete(e.data.requestId);
                }
            } else if (e.data.type === 'error' && e.data.requestId) {
                const reject = this.pendingError.get(e.data.requestId);
                if (reject) {
                    reject(new Error(e.data.error));
                    this.pending.delete(e.data.requestId);
                    this.pendingError.delete(e.data.requestId);
                }
            }
        });

        this.worker.addEventListener('error', (err) => {
            // Worker 崩溃:所有 pending 请求 reject
            for (const [id, reject] of this.pendingError) {
                reject(new Error(`Embedding Worker 崩溃: ${err.message}`));
            }
            this.pending.clear();
            this.pendingError.clear();
        });

        // 传入模型依赖,Worker 内部初始化
        this.worker.postMessage({ type: 'init', deps, dimensions, maxBatchSize });
    }

    async embed(texts: string[]): Promise<number[][]> {
        await this.ready;
        if (texts.length === 0) return [];

        const requestId = `embed_${++this.requestCounter}`;
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, resolve);
            this.pendingError.set(requestId, reject);
            this.worker.postMessage({ type: 'embed', texts, requestId });
        });
    }

    terminate(): void {
        this.worker.terminate();
    }
}
```

#### esbuild 新增打包入口

```javascript
// esbuild.config.mjs — 新增第三个 context
const embeddingWorkerContext = await esbuild.context({
    entryPoints: ['src/worker/embedding-worker.ts'],
    bundle: true,
    platform: 'browser',  // 关键:Web Worker,不是 node
    format: 'iife',       // Worker 需要自执行
    target: 'es2021',
    outfile: 'dist/embedding-worker.js',
    minify: prod,
    sourcemap: prod ? false : 'inline',
    alias: {
        'onnxruntime-web': path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'),
    },
    plugins: [externalOnnxruntimeNodePlugin()],
});
```

**注意:** `platform: 'browser'` 而非 `'node'`,因为 Web Worker 不需要 Node API。ONNX WASM 二进制通过 `ort.env.wasm.wasmBinary` 注入,Worker 内通过 `fetch` 或主线程传入加载。

#### main.ts 初始化流程

```typescript
// src/main.ts — 修改后
private async createEmbeddings(): Promise<EmbeddingPort> {
    // 关键路径:主线程加载模型依赖(ModelManager 不变)
    const { vocabPath, modelBuffer, wasmBinary } = await this.modelManager.load();

    // 创建 Web Worker proxy
    const workerUrl = this.app.vault.adapter.resourcePathNormalized(
        this.manifest.dir + '/dist/embedding-worker.js'
    );

    try {
        const proxy = new EmbeddingWorkerProxy(workerUrl, { vocabPath, modelBuffer, wasmBinary }, 512);
        await proxy.ready;  // 等待 Worker init 完成
        return proxy;
    } catch (err) {
        // 不降级,直接报错
        throw new Error(
            '本地 Embedding Worker 初始化失败,无法使用本地向量化。' +
            '请在设置中配置 API Embedding 端点(如 Ollama)后重启插件。'
        );
    }
}
```

#### handler.ts 改造

`initProcessorWithStore` 需要额外接收 `embeddings` 参数,传给 `IndexProcessor`:

```typescript
// src/worker/handler.ts — 修改后
export function initProcessorWithStore(store: VectraStore, embeddings: EmbeddingPort): void {
    processor = new IndexProcessor(store, embeddings);
}
```

#### Worker 生命周期

| 事件 | 行为 |
|------|------|
| `onload` | 主线程加载模型 → 创建 Worker → postMessage init → await ready |
| 索引期间 | IndexProcessor 调 `proxy.embed(texts)` → Worker 推理 → 返回向量 |
| 搜索期间 | SearchVault 工具调 `proxy.embed(query)` → Worker 推理 → 返回查询向量 |
| `onunload` | `proxy.terminate()` → Worker 线程释放 |

### 错误处理

| 场景 | 处理 |
|------|------|
| Web Worker 创建失败 | 直接抛错,提示"配置 API Embedding 端点" |
| Worker init 失败(模型加载) | `ready` Promise reject,主线程捕获后抛错 |
| Worker embed 请求超时(30s) | reject 对应 Promise,IndexProcessor 捕获后该文件标记 errors |
| Worker 崩溃(worker.onerror) | 所有 pending 请求 reject,UI 显示"Embedding Worker 崩溃" |
| Worker terminate(onunload) | 正常清理,无错误 |
| 单文件索引失败 | 不挂整批,继续后续文件 |

---

## 影响面

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/worker/embedding-worker.ts` | Web Worker 入口,加载 ONNX + 处理 embed 请求 |
| `src/adapters/embedding-worker-proxy.ts` | `EmbeddingPort` 代理实现,postMessage 到 Worker |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/worker/index-processor.ts` | 逐 chunk upsert → 批量 embed + upsertItem;构造函数新增 `embeddings` 参数 |
| `src/adapters/vector-vectra.ts` | 新增 `upsertItem` / `beginFileUpdate` / `endFileUpdate` / `cancelFileUpdate` |
| `src/worker/handler.ts` | `initProcessorWithStore` 新增 `embeddings` 参数 |
| `src/worker/inline-worker.ts` | `initWithStore` 新增 `embeddings` 参数传递 |
| `src/main.ts` | 创建 `EmbeddingWorkerProxy` 替代直接 `EmbeddingOnnx`;传给 handler init |
| `esbuild.config.mjs` | 新增 embedding-worker.js 打包入口 |
| `src/ports/vector.ts` | `VectorStore` 端口新增 `upsertItem` 等方法签名(如需要) |

### 不变的文件

- `src/ports/embedding.ts`(`EmbeddingPort` 接口不变)
- `src/adapters/embedding-onnx.ts`(`EmbeddingOnnx` 实现不变,只是从主线程移到 Worker 线程)
- `src/worker/chunker.ts`(`chunkMarkdown` 分块逻辑不变)
- `src/core/folder-watcher.ts`(去抖逻辑不变)
- `src/core/index-controller.ts`(调度逻辑不变)
- `src/core/index-manager.ts`(队列消费逻辑不变)

---

## 测试策略

### P0 单元测试

| 测试文件 | 关键用例 |
|----------|----------|
| `tests/worker/index-processor.test.ts` | ① 100 chunk 只调 1 次 `embed`(非 100 次)② embed 返回向量数与 chunk 数一致 ③ upsertItem 写入预计算向量 ④ 单文件失败不挂整批 ⑤ 空文件不触发 embed |
| `tests/adapters/vector-vectra.test.ts` | ① `upsertItem` 预计算向量正确写入 ② 事务回滚(`cancelFileUpdate`) ③ docId 去重 |

### P1 单元测试

| 测试文件 | 关键用例 |
|----------|----------|
| `tests/adapters/embedding-worker-proxy.test.ts` | ① init 完成前 `embed` await `ready` ② embed 请求/响应 `requestId` 关联 ③ Worker `onerror` 时 pending reject ④ 并发 embed 请求不串 ⑤ `terminate` 后不再处理消息 |
| `tests/worker/embedding-worker.test.ts` | ① init 后收到 ready ② embed 请求返回正确维度向量 ③ 未 init 时 embed 返回 error |

### 测试策略

- Worker mock:测试中用 `MockWorker` 类模拟 Worker postMessage/onmessage
- `EmbeddingOnnx` 不在 P1 测试中 mock(已在 `embedding-onnx.test.ts` 覆盖)
- 回归测试:现有 `index-processor.test.ts` 更新 mock,从 `store.upsert` 改为 `store.upsertItem` + `embeddings.embed`

### 不测什么

- ONNX 推理本身(已在 `embedding-onnx.test.ts` 覆盖)
- vectra 磁盘 IO(集成测试,需真实 fs)
- Web Worker 创建是否成功(环境依赖,手动验证)

---

## 对 ADR-002 的修正

ADR-002 的"不采纳"中:
> **方案 C:Web Worker + fs 代理**:vectra 深层 fs 调用难完全代理,工作量大,性能差

这个排除是**过度泛化**的。vectra 的 fs 调用确实不适合代理,但 ONNX 推理不需要 fs。本 spec 纠正为:**Web Worker 用于 ONNX 推理(无 fs 依赖),vectra 留在主线程(有 fs)**。

ADR-002 的 InlineWorker 保留给 `worker.js`(Worker Threads 入口产物),但 embedding 独立走 Web Worker。

---

## 参考文件

- ADR-002:`docs/adr/2026-06-18-worker-runtime-strategy.md`(Worker 运行时策略)
- ADR-005:`docs/adr/2026-06-27-index-ui-blocking.md`(索引阻塞 UI 根因与修复策略)
- `src/worker/index-processor.ts`(索引批处理,当前逐 chunk upsert)
- `src/adapters/embedding-onnx.ts`(ONNX 推理实现,将移入 Worker)
- `src/adapters/vector-vectra.ts`(vectra 包装,新增 upsertItem)
- `src/ports/embedding.ts`(EmbeddingPort 接口,不变)
- `esbuild.config.mjs`(打包配置,新增 Worker 入口)
- `node_modules/vectra/lib/LocalDocumentIndex.js`(vectra upsertDocument 内部逻辑)
- `node_modules/vectra/lib/LocalIndex.d.ts`(upsertItem / beginUpdate / endUpdate API)
- AGENTS.md:"重活(索引)推给 Worker"、"Embedding API 调用要批量"
