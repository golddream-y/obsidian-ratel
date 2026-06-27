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

## Decision(决策)

**三层修复,按优先级递进:**

### P0:修复逐 chunk upsert(立即,本次实施)

停止在 `IndexProcessor` 中预分块 + 逐 chunk `store.upsert`。改为:
- 一次调用 `store.upsert(filePath, fullContent, metadata)`,让 vectra 内部完成分块 + 批量 embedding
- 或:自己分块后,一次性传所有 chunk 文本给 vectra(需确认 vectra API 支持)

**预期效果**:ONNX 调用次数从 N(chunk 数)降到 N/16,总阻塞时间减少 ~85%。

**注意**:需要配置 vectra 的 `chunkingConfig` 使其分块策略与当前 `chunkMarkdown(500, 100)` 一致,或接受 vectra 的 token 级分块(更精确)。

### P1:ONNX 推理移入 Web Worker(短期,本次或下次实施)

实现 `EmbeddingsPort` 的 Web Worker 代理:

```
主线程                          Web Worker
──────                          ──────────
vectra.upsertDocument(text)
  → TextSplitter 分块
  → createEmbeddings(batch)  ──→  ONNX session.run(batch)
                                ←──  返回 vectors[]
  → 写入磁盘(LocalIndex)
```

**实现要点:**
1. 新建 `src/worker/embedding-worker.ts` — Web Worker 入口,加载 ONNX runtime + 模型
2. 新建 `src/adapters/embedding-worker-proxy.ts` — 实现 `EmbeddingsPort`,内部 postMessage 到 Web Worker
3. `main.ts` 创建 Web Worker,传给 proxy,proxy 传给 VectraStore
4. `onnxruntime-web` 原生支持 Web Worker 环境(WASM 在 Worker 中跑)

**这直接落实 AGENTS.md 的"重活推给 Worker"设计意图。** ADR-002 的 InlineWorker 保留给降级场景(Web Worker 创建失败时)。

**预期效果**:索引期间主线程零 CPU 阻塞(ONNX 在 Worker 线程),仅 vectra 磁盘 IO 在主线程(轻量)。

### P2:API Embedding 为默认(长期,后续 spec)

默认推荐 API Embedding 模式(Ollama / 远端端点):
- 向量计算在服务端执行,连 Web Worker 都不需要
- 本地 ONNX 仅作离线降级

### 不采纳(修正 ADR-002 的部分结论)

- ~~**Web Worker + fs 代理**~~:ADR-002 排除了这个,结论仍然正确——vectra 的 fs 调用确实不适合代理到 Web Worker。但 ADR-002 **错误地把"vectra 需要 fs"推广到"Web Worker 完全不可用"**。我们用 Web Worker 只做 ONNX 推理(无 fs),不代理 vectra。
- **恢复 `worker_threads`**:ADR-002 确认 V8 平台级限制,仍然不可用
- **仅靠 `setTimeout(0)` 任务切片**:治标不治本,ONNX 推理仍在主线程,只是分段阻塞。可作为 P0/P1 未落地前的临时缓解

---

## Consequences(后果)

### P0(修复逐 chunk upsert)

**正面**:
- ONNX 调用减少 ~85%,阻塞时间大幅下降
- 改动面极小(只改 `index-processor.ts` 的 upsert 调用方式)
- vectra 的批量分批逻辑终于生效

**负面**:
- 放弃自定义 `chunkMarkdown(500, 100)`,改用 vectra 的 `TextSplitter`(token 级分块)
- 需确认 vectra chunkingConfig 配置,使分块大小符合预期
- chunk 级 metadata(如 `startOffset`)可能丢失,需评估影响

### P1(ONNX 移入 Web Worker)

**正面**:
- **落实架构设计意图**——AGENTS.md"重活推给 Worker"终于落地
- 索引期间主线程零 CPU 阻塞
- 全量索引不再卡死 Obsidian
- ADR-002 的 InlineWorker 保留为降级,向后兼容

**负面**:
- 新增 Web Worker 产物(embedding-worker.js),esbuild 配置需扩展
- ONNX 模型需在 Worker 中重新加载(内存占用略增,但避免主线程阻塞)
- Worker 通信有序列化开销(文本 → Worker → 向量),但远小于 ONNX 推理时间

### P2(API Embedding)

**正面**:
- 主线程零 CPU 阻塞,不依赖 ONNX runtime
- 可利用更强大的远端模型

**负面**:
- 需要网络连接,离线场景不可用
- 本地 ONNX 仍需维护作为降级

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
| `src/worker/index-processor.ts` | 移除 `chunkMarkdown` 预分块,改为单次 `store.upsert` 传完整文本 |
| `src/adapters/vector-vectra.ts` | 确认/配置 vectra `chunkingConfig` |
| `tests/worker/index-processor.test.ts` | 更新测试适配新调用方式 |

### P1 改动文件

| 文件 | 改动 |
|------|------|
| `src/worker/embedding-worker.ts`(新建) | Web Worker 入口,加载 ONNX + 处理推理请求 |
| `src/adapters/embedding-worker-proxy.ts`(新建) | `EmbeddingsPort` 代理实现 |
| `src/main.ts` | 创建 Web Worker,注入 proxy 到 VectraStore |
| `esbuild.config.ts` | 新增 embedding-worker.js 打包入口 |
| `src/worker/inline-worker.ts` | 保留,作为 Web Worker 创建失败时的降级 |

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
