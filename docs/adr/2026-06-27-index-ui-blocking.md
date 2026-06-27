# ADR-005:索引阻塞 UI 的根因与修复策略

**状态**:Proposed
**日期**:2026-06-27
**关联**:ADR-002(Worker 运行时策略)、ADR-003(本地 Embedding 架构)
**状态变更**:对 ADR-002 的修正——Web Worker 方案重新纳入考量

---

## Context(背景)

用户报告:每次文档新增/变更触发索引时,Obsidian 页面不可点击、文档不可用,持续数秒到数十秒。全量索引(onLayoutReady)期间整个 Obsidian 基本不可用。

AGENTS.md 架构设计明确要求"重活(索引)推给 Worker",`src/worker/index.ts` Worker 入口也存在。问题是:为什么架构规划了子线程,实际却在主线程阻塞?

### 两层根因

#### 根因 1(实现层):IndexProcessor 逐 chunk 调用 upsert,绕过了 vectra 的批量推理

`index-processor.ts:82-89`:
```typescript
const chunks = chunkMarkdown(file.content, 500, 100);   // 自己分块
for (const [idx, chunk] of chunks.entries()) {
    await this.store.upsert(`${file.path}#chunk-${idx}`, chunk.text, {...});  // 逐 chunk 调 vectra
}
```

vectra 的 `upsertDocument`(`LocalDocumentIndex.js:167-240`)内部逻辑:
1. 用 `TextSplitter` 对传入文本分块(我们传入的是单 chunk,分块结果还是 1 条)
2. 按 `maxTokens` 批量分组(chunkBatches)
3. 对每个 batch 调 `this._embeddings.createEmbeddings(batch)`

因为每个 `store.upsert` 只传 1 个 chunk,vectra 的批量分组永远是 `[[1条文本]]`,**`EmbeddingOnnx` 的 `maxBatchSize=16` 分批逻辑根本不生效**。

```
当前:100 chunk → 100 次 store.upsert → 100 次 ONNX session.run() → 主线程阻塞 2-5 秒
应做:1 次完整文本 → vectra 内部分块+批量 → ~7 次 ONNX(100/16) → 阻塞减少 85%
```

#### 根因 2(架构层):ADR-002 的推理盲区——ONNX 推理不需要 fs,可以进 Web Worker

ADR-002 的推理链:

> vectra 需要 `fs` → Web Worker 无 Node 集成 → Web Worker 不可用 → 全部主线程执行

这个推理**把两件事混为一谈**:

| 工作 | 需要 `fs`? | CPU 密集? | 能去 Web Worker? |
|------|-----------|----------|----------------|
| vectra 磁盘 IO(读写索引文件) | ✅ 是 | ❌ 否 | ❌ 不能 |
| ONNX WASM 推理(`session.run()`) | ❌ 否 | ✅ **是** | ✅ **能** |

**真正阻塞 UI 的是 ONNX 推理,它根本不需要 `fs`。** ADR-002 因为 vectra 需要 fs 就否定了 Web Worker,但没有考虑"只把 ONNX 推理拆到 Web Worker,vectra 留在主线程"的中间方案。

方案:`EmbeddingsPort` 的 Web Worker 代理实现——
- vectra 留在主线程(有 fs,负责磁盘 IO + 文本分块)
- vectra 调 `embeddings.createEmbeddings(batch)` 时,实际把 batch 发给 Web Worker
- Web Worker 跑 ONNX `session.run()`,返回向量
- vectra 收到向量,写入磁盘

Web Worker 只做纯 CPU 计算(WASM 推理),不需要任何 Node API。

### 完整阻塞链路(修复前)

```
文件变更 → FolderWatcher(5s 单文件去抖) → IndexController
  → IndexManager.flush(while 循环连续消费)
    → WorkerManager.request → InlineWorker.postMessage(setTimeout(0))
      → handleMessage → IndexProcessor.indexIncremental
        ├─ chunkMarkdown()           ← 同步 CPU,大文件产生数百 chunk
        └─ for (chunk) store.upsert   ← 每个 chunk 单独触发 ONNX 推理 ★ 根因 1
              └─ vectra.upsertDocument
                    └─ embeddings.createEmbeddings([chunk.text])
                          └─ ONNX session.run()  ← 主线程同步 WASM ★ 根因 2
```

### ONNX 推理的阻塞特性

`onnxruntime-web` 的 `session.run(feeds)` 是 WASM 同步调用:
- `numThreads=1`(见 `embedding-onnx.ts:99`),无法并行
- WASM 执行期间主线程完全阻塞,无法响应任何事件
- 单条文本(512 token)推理时间约 20-50ms,100 chunk = 2-5 秒纯阻塞
- 大文件(数百 chunk)可达 10+ 秒

### 次要问题

| # | 位置 | 问题 | 严重度 |
|---|------|------|--------|
| **D** | `index-manager.ts:131-141` | `flush()` while 循环连续消费队列,N 个文件连续阻塞 | 严重 |
| **E** | `folder-watcher.ts:32-34` | 5s 去抖是**单文件**的,无全局合并;`delete` 不去抖 | 中等 |
| **G** | 整条链路 | **零 yield 机制**——无 `setTimeout(0)` 切片、无 `requestIdleCallback` | 致命(根因 2 未解决时的缓解) |

---

## 产品设计权衡(brainstorming 关键决策)

以下决策在 brainstorming 阶段确认,作为后续实现的硬约束。

### 决策 1:本地 ONNX 是插件内置能力,保持默认 — 不改 API Embedding 为默认

**决策**:P2(API Embedding 为默认)**移除**。本地 ONNX 保持默认,API Embedding 仅作为可选项。

**理由**:知识助手必须内置向量化能力。一个知识管理插件如果连向量化都要用户自己配 API 端点,能力边界不清晰。本地 ONNX 是插件的核心能力之一,不是"降级方案"。

**影响**:P1(Web Worker)解决了本地 ONNX 的阻塞问题后,API Embedding 不再是"解决阻塞"的必要手段,而是"可选的增强"。后续不做"自动推荐切换 API Embedding"的设计。

### 决策 2:Web Worker 创建失败不降级 — 直接报错引导用户接 API Embedding

**决策**:Web Worker 创建/初始化失败时,**不降级到 InlineWorker**(ONNX 在主线程),而是直接抛错,提示用户配置 API Embedding 端点。

**理由**:插件绝不能让笔记不可用。如果安装插件后 Obsidian 卡死,用户体验是灾难性的。与其"勉强能用但很卡",不如"明确不可用并给出解决方案"。用户看到错误提示后可以配置 API Embedding 端点(Ollama / 远端),这比"不知道为什么卡"好得多。

**影响**:`EmbeddingWorkerProxy` 构造失败时 `throw new Error(...)`,main.ts 捕获后向用户展示配置引导。ADR-002 的 InlineWorker 保留给 `worker.js`(索引调度),不用于 embedding 降级。

### 决策 3:保留 chunkMarkdown 语义分块 — 不用 vectra 内置 TextSplitter

**决策**:P0 修复时保留 `chunkMarkdown(500, 100)` 的标题→段落→句子四级回退分块,不切换到 vectra 内置的 token 级 `TextSplitter`。

**理由**:vectra 的 `TextSplitter` 是 token 级分块,分块质量依赖模型能力。弱模型的向量切分不见得有按段落分块好。`chunkMarkdown` 按标题/段落/句子切分,保留语义边界,不依赖模型能力,分块质量更稳定可控。

**影响**:P0 修复方式不是"把完整文本交给 vectra upsertDocument",而是"自己分块 → 批量 embed → 用 vectra upsertItem 写入预计算向量"。保留 `chunkMarkdown` 的同时实现批量推理。

### 决策 4:主线程加载模型 + postMessage 传入 Worker — 不是因为改动小,而是因为状态判定

**决策**:ONNX 模型(modelBuffer + vocabPath + wasmBinary)在主线程加载,通过 postMessage(transferable)传入 Web Worker。Worker 不自行加载模型。

**理由**:模型加载的成功/失败状态在主线程判定更可靠。如果 Worker 自行加载,主线程只能通过 Worker 的 postMessage 间接感知状态,错误处理链路更长、更难调试。主线程加载好再传入,Worker 只负责推理,职责清晰。

**影响**:`ModelManager` 流程不变(主线程读取模型文件),`EmbeddingWorkerProxy` 构造时接收 deps 并 postMessage 给 Worker。ArrayBuffer 用 transferable 转移所有权,避免复制大文件(模型 ~40MB + WASM ~10MB)。

---

## Decision(决策)

**两层修复(P0 + P1),P2 移除:**

### P0:批量 embed 替代逐 chunk upsert(保留 chunkMarkdown)

停止 `IndexProcessor` 逐 chunk 调用 `store.upsert`(每次触发 vectra 内部单独一次 ONNX 推理)。改为:

1. 保留 `chunkMarkdown(500, 100)` 语义分块(决策 3)
2. 一次性 `embeddings.embed(allChunkTexts)` 批量推理
3. 用 `VectraStore.upsertItem(vector)` 写入预计算向量,绕过 vectra 的 `upsertDocument`(后者内部会调 embedding)

**预期效果**:ONNX 调用次数从 N(chunk 数)降到 N/16,总阻塞时间减少 ~85%。

### P1:ONNX 推理移入 Web Worker

实现 `EmbeddingsPort` 的 Web Worker 代理:

```
主线程                                    Web Worker
──────                                    ──────────
IndexProcessor
  ├─ chunkMarkdown() 分块(保留语义分块)
  ├─ embeddings.embed(allChunks)  ──→   EmbeddingOnnx.embed()
  │                                       ├─ tokenizer.encode
  │                                       └─ ONNX session.run() ← WASM
  │    ←── vectors[]  ──────────────
  └─ vectra.upsertItem(vector) 写入磁盘
```

**实现要点:**
1. 新建 `src/worker/embedding-worker.ts` — Web Worker 入口,加载 ONNX runtime + 处理推理
2. 新建 `src/adapters/embedding-worker-proxy.ts` — 实现 `EmbeddingPort`,postMessage 到 Worker
3. `main.ts` 创建 Web Worker proxy,传给 IndexProcessor
4. 模型依赖由主线程加载后 postMessage 传入 Worker(决策 4)
5. Web Worker 创建失败直接报错,不降级(决策 2)

**这直接落实 AGENTS.md 的"重活推给 Worker"设计意图。**

**预期效果**:索引期间主线程零 CPU 阻塞(ONNX 在 Worker 线程),仅 vectra 磁盘 IO 在主线程(轻量)。

### ~~P2:API Embedding 为默认~~ — 移除(决策 1)

本地 ONNX 是插件内置能力,保持默认。P1 Web Worker 已解决阻塞,API Embedding 不再是"解决阻塞"的必要手段。

### 不采纳(修正 ADR-002 的部分结论)

- ~~**Web Worker + fs 代理**~~:ADR-002 排除了这个,结论仍然正确——vectra 的 fs 调用确实不适合代理到 Web Worker。但 ADR-002 **错误地把"vectra 需要 fs"推广到"Web Worker 完全不可用"**。我们用 Web Worker 只做 ONNX 推理(无 fs),不代理 vectra。
- **恢复 `worker_threads`**:ADR-002 确认 V8 平台级限制,仍然不可用
- **仅靠 `setTimeout(0)` 任务切片**:治标不治本,ONNX 推理仍在主线程,只是分段阻塞
- **降级到 InlineWorker**:不降级(决策 2)。插件绝不能让笔记不可用,不可用就明确报错

---

## Consequences(后果)

### P0(批量 embed + 保留 chunkMarkdown)

**正面**:
- ONNX 调用减少 ~85%(从 N 次降到 N/16 次)
- 保留 `chunkMarkdown` 语义分块,分块质量不依赖模型能力(决策 3)
- `EmbeddingOnnx` 的 `maxBatchSize=16` 分批逻辑终于生效

**负面**:
- 需绕过 vectra 的 `upsertDocument`,改用底层 `upsertItem`(需处理事务管理)
- IndexProcessor 需持有 `EmbeddingPort` 引用,构造函数签名变化

### P1(ONNX 移入 Web Worker)

**正面**:
- **落实架构设计意图**——AGENTS.md"重活推给 Worker"终于落地
- 索引期间主线程零 CPU 阻塞
- 全量索引不再卡死 Obsidian

**负面**:
- 新增 Web Worker 产物(embedding-worker.js),esbuild 配置需扩展
- Worker 通信有序列化开销(文本 → Worker → 向量),但远小于 ONNX 推理时间
- Web Worker 创建失败时插件不可用(决策 2:不降级,直接报错引导用户接 API Embedding)

---

## 对 ADR-002 的修正

ADR-002 的核心结论(`worker_threads` 不可用 → InlineWorker)在 `worker_threads` 层面仍然正确。但 ADR-002 的"不采纳"中:

> **方案 C:Web Worker + fs 代理**:vectra 深层 fs 调用难完全代理,工作量大,性能差

这个排除是**过度泛化**的。vectra 的 fs 调用确实不适合代理,但 ONNX 推理不需要 fs。本 ADR 纠正为:**Web Worker 用于 ONNX 推理(无 fs 依赖),vectra 留在主线程(有 fs)**。

ADR-002 的 Consequences 中的承诺:
> 后续需要额外优化(任务切片、分批 yield、进度条)来缓解阻塞

本 ADR 将"任务切片"升级为"ONNX 移入 Web Worker",从缓解变为根治。

---

## 影响面

### P0 改动文件

| 文件 | 改动 |
|------|------|
| `src/ports/vector.ts` | `VectorStore` 端口新增 `upsertItem` / `beginFileUpdate` / `endFileUpdate` / `cancelFileUpdate` 签名 |
| `src/adapters/vector-vectra.ts` | 实现上述新方法,绕过 vectra `upsertDocument` |
| `src/worker/index-processor.ts` | 保留 `chunkMarkdown` 分块,改为批量 `embeddings.embed` + `upsertItem`;构造函数新增 `embeddings` 参数 |
| `tests/worker/index-processor.test.ts` | 更新测试适配批量 embed + upsertItem |
| `tests/adapters/vector-vectra.test.ts` | 新增 upsertItem + 事务回滚测试 |

### P1 改动文件

| 文件 | 改动 |
|------|------|
| `src/worker/embedding-worker.ts`(新建) | Web Worker 入口,加载 ONNX + 处理推理请求 |
| `src/adapters/embedding-worker-proxy.ts`(新建) | `EmbeddingPort` 代理实现,postMessage 到 Worker |
| `src/worker/handler.ts` | `initProcessorWithStore` 新增 `embeddings` 参数 |
| `src/worker/inline-worker.ts` | `initWithStore` 新增 `embeddings` 参数传递 |
| `src/main.ts` | 创建 `EmbeddingWorkerProxy` 替代直接 `EmbeddingOnnx`;传给 handler init |
| `esbuild.config.mjs` | 新增 embedding-worker.js 打包入口(platform: browser, format: iife) |

### 不变的部分

- `WorkerLike` 接口与 `WorkerManager` 协议不变
- vectra 索引结构不变
- `src/worker/index.ts`(Worker Threads 入口)保留,未来非 Obsidian 环境可用

---

## 参考

- ADR-002:Ratel Vault Worker 运行时策略(InlineWorker 决策)——本 ADR 修正其 Web Worker 排除结论
- ADR-003:Ratel Vault 本地 Embedding 运行时策略(ONNX 选型)
- AGENTS.md:"重活(索引)推给 Worker"、"Embedding API 调用要批量"
- `src/worker/index-processor.ts`(索引批处理,逐 chunk upsert — 根因 1)
- `src/worker/inline-worker.ts`(主线程 Worker 模拟 — 根因 2 的载体)
- `src/adapters/embedding-onnx.ts`(ONNX 推理,`session.run()` 同步 WASM)
- `src/adapters/vector-vectra.ts`(vectra `upsertDocument` 内部触发 embedding)
- `node_modules/vectra/lib/LocalDocumentIndex.js:167-240`(vectra 内部分块+批量推理逻辑)
- `src/core/index-manager.ts`(`flush()` while 循环)
- `src/core/folder-watcher.ts`(5s 单文件去抖)
