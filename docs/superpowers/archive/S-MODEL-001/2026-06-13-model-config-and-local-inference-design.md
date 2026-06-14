# Ratel 模型配置与本地推理设计

> 日期: 2026-06-13
> 状态: Approved
> 关联: 2026-06-13-rag-enhancement-roadmap-design.md / ARCHITECTURE.md

---

## 1. 背景

Ratel W1 已完成，使用 DeepSeek API 做 Chat。W2 将引入 Embedding + 向量检索。本文档解决三个问题：

1. **Embedding 最小化默认方案** — 用户不配 API Key 也能用
2. **Rerank 可选方案** — 不占内存，配了就用
3. **模型配置统一** — Chat / Embedding / Rerank 三类模型的设置面板设计

## 2. 设计决策

### D1: Embedding 双模式 — 内置本地 + 外部 API

| 模式 | 实现 | 默认模型 | 配置要求 |
|---|---|---|---|
| **Local（默认）** | `@huggingface/transformers` ONNX WASM | `Xenova/bge-small-zh-v1.5` (~90MB) | 零配置 |
| **API** | OpenAI-compatible `/v1/embeddings` | `bge-m3` | API Base + Key + Model |

**为什么选 bge-small-zh-v1.5：**
- 中文场景为主，bge-micro-v2 是英文蒸馏模型，中文效果差
- ~90MB ONNX 量化，内存 ~200-300MB，1k 笔记可接受
- 512 维向量，检索精度够用

**为什么只有两种模式（不做单独的 Ollama adapter）：**
- Ollama 的 embedding API 就是 OpenAI-compatible `/v1/embeddings`
- SiliconFlow / OpenAI / 任何兼容端点都用同一个 API adapter
- 减少维护负担

### D2: Rerank 外部 API only

| 模式 | 实现 | 配置要求 |
|---|---|---|
| **API（可选）** | Cohere / Jina / SiliconFlow rerank API | API Base + Key + Model |

**为什么不做本地 Rerank：**
- bge-reranker-base ONNX ~420MB，运行时内存 500-800MB，对 Obsidian 用户太重
- Rerank 本身是可选增强，不配就不走 rerank 步骤
- `@huggingface/transformers` 可以做本地 rerank，但内存代价不值得

### D3: `@huggingface/transformers` 不违反零 native 约束

- `@huggingface/transformers` v3 是纯 JS + WASM
- 底层用 `onnxruntime-web`（WASM 后端），不是 C++ addon
- 可以在 Electron/Node.js 环境运行
- 作为 devDependency，esbuild 打包进 main.js

## 3. 架构变更

### 3.1 新增 Port

**`ports/embedding.ts`**

```typescript
export interface EmbeddingPort {
  /** 生成文本的嵌入向量 */
  embed(texts: string[]): Promise<number[][]>;

  /** 嵌入向量维度 */
  dimensions: number;

  /** 模型标识（用于日志和缓存 key） */
  modelId: string;
}
```

**`ports/reranker.ts`**

```typescript
export interface RerankerPort {
  /** 对文档列表重排序 */
  rerank(query: string, documents: string[], topK: number): Promise<RerankResult[]>;
}

export interface RerankResult {
  index: number;
  score: number;
  text: string;
}
```

### 3.2 新增 Adapter

| Adapter | Port | 说明 |
|---|---|---|
| `adapters/embedding-local.ts` | EmbeddingPort | `@huggingface/transformers` ONNX 本地推理 |
| `adapters/embedding-api.ts` | EmbeddingPort | OpenAI-compatible `/v1/embeddings` |
| `adapters/reranker-api.ts` | RerankerPort | 外部 Rerank API（Cohere/Jina/SiliconFlow） |

### 3.3 修改

| 文件 | 变更 |
|---|---|
| `ports/llm.ts` | 移除 `embed()` 方法（独立到 EmbeddingPort） |
| `adapters/llm-deepseek.ts` | 移除 `embed()` 实现 |
| `settings.ts` | 新增 Embedding Provider + Reranker 配置 |
| `main.ts` | 根据 settings 创建对应 Embedding/Reranker adapter |
| `worker/manager.ts` | Embedding 调用在主线程，Worker 只做向量搜索 |

### 3.4 Embedding 本地 adapter 实现要点

```typescript
// adapters/embedding-local.ts
import { pipeline, type PipelineType } from '@huggingface/transformers';

export class EmbeddingLocal implements EmbeddingPort {
  private extractor: Awaited<ReturnType<typeof pipeline>> | null = null;
  readonly modelId: string;
  readonly dimensions: number;

  constructor(modelId = 'Xenova/bge-small-zh-v1.5', dimensions = 512) {
    this.modelId = modelId;
    this.dimensions = dimensions;
  }

  private async init() {
    if (!this.extractor) {
      this.extractor = await pipeline('feature-extraction', this.modelId, {
        dtype: 'q8',           // 8-bit 量化，体积小
        progress_callback: (p) => { /* 下载进度通知 */ },
      });
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.init();
    const results = await this.extractor(texts, {
      pooling: 'mean',
      normalize: true,
    });
    // 转换为 number[][]
    return results.tolist();
  }
}
```

**模型下载策略：**
- `@huggingface/transformers` 自动缓存到 `.cache/huggingface/`
- 首次使用时下载，后续走缓存
- 下载进度通过 Obsidian Notice 通知用户

### 3.5 Embedding API adapter 实现要点

```typescript
// adapters/embedding-api.ts
export class EmbeddingApi implements EmbeddingPort {
  constructor(
    private apiBase: string,    // e.g. http://localhost:11434/v1
    private apiKey: string,     // Ollama 可留空
    private model: string,      // e.g. bge-m3
    readonly dimensions: number,
    readonly modelId: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.apiBase}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });
    if (!response.ok) throw new Error(`Embedding API error: ${response.status}`);
    const data = await response.json();
    return data.data.map((d: { embedding: number[] }) => d.embedding);
  }
}
```

## 4. 设置面板设计

```
Chat Model
  ├── API Base (默认: https://api.deepseek.com)
  ├── API Key (password)
  └── Model (默认: deepseek-chat)

Embedding Model
  ├── Provider: Local / API (下拉, 默认: Local)
  ├── [Local] Model (默认: Xenova/bge-small-zh-v1.5)
  ├── [API] API Base (默认: http://localhost:11434/v1)
  ├── [API] API Key (password, Ollama 可留空)
  └── [API] Model (默认: bge-m3)

Reranker (可选)
  ├── Enable Reranker (开关, 默认关)
  ├── Provider: Cohere / Jina / SiliconFlow (下拉)
  ├── API Base (根据 Provider 自动填充)
  ├── API Key (password)
  └── Model (根据 Provider 自动填充)
```

### 4.1 Settings 类型更新

```typescript
export interface RatelVaultSettings {
  // Chat (已有)
  chatApiBase: string;
  chatApiKey: string;
  chatModel: string;

  // Embedding (新增)
  embedProvider: 'local' | 'api';
  embedLocalModel: string;
  embedApiBase: string;
  embedApiKey: string;
  embedApiModel: string;

  // Reranker (新增)
  rerankerEnabled: boolean;
  rerankerProvider: 'cohere' | 'jina' | 'siliconflow' | 'custom';
  rerankerApiBase: string;
  rerankerApiKey: string;
  rerankerModel: string;

  // Index (已有)
  indexBatchSize: number;
  indexAutoReindex: boolean;
}
```

### 4.2 默认值

```typescript
export const DEFAULT_SETTINGS: RatelVaultSettings = {
  chatApiBase: 'https://api.deepseek.com',
  chatApiKey: '',
  chatModel: 'deepseek-chat',

  embedProvider: 'local',
  embedLocalModel: 'Xenova/bge-small-zh-v1.5',
  embedApiBase: 'http://localhost:11434/v1',
  embedApiKey: '',
  embedApiModel: 'bge-m3',

  rerankerEnabled: false,
  rerankerProvider: 'cohere',
  rerankerApiBase: 'https://api.cohere.ai/v1',
  rerankerApiKey: '',
  rerankerModel: 'rerank-v3.5',

  indexBatchSize: 10,
  indexAutoReindex: true,
};
```

## 5. 数据流

### 5.1 索引流程（Embedding 调用）

```
Worker: chunkMarkdown(note) → chunks[]
Main:   embed(chunks) → vectors[]        ← EmbeddingPort (local or API)
Main → Worker: vector.upsert(docId, text, vector)
```

**关键：Embedding 在主线程调用，向量传给 Worker 存储。** Worker 不做 HTTP，不做 Embedding。

### 5.2 检索流程（含可选 Rerank）

```
用户问题 → embed(query) → vector
         → Worker: vector.search(queryVector, topK=20) → candidates[]
         → [可选] rerank(query, candidates, topK=5)    ← RerankerPort (API only)
         → 塞入 Context → LLM 回答
```

**Rerank 不配置时跳过，直接用向量搜索 topK=10。**

## 6. 风险

| 风险 | 缓解 |
|---|---|
| `@huggingface/transformers` 打包后 main.js 体积增大 | tree-shaking 只打包 `feature-extraction` pipeline，预计增加 ~2MB |
| 首次下载 ONNX 模型慢（~90MB） | 下载进度通知 + 后台下载不阻塞 UI |
| bge-small-zh-v1.5 中文效果不如 bge-m3 | 设置里一键切 API 模式 |
| Rerank API 免费额度有限 | 默认关闭，用户明确需要时才开 |
| Embedding 维度不一致（local 512 vs API 1024） | 切换 Provider 时提示需要重建索引 |

## 7. 对现有路线图的更新

| 周 | 原里程碑 | 更新后 |
|---|---|---|
| W2 | vectra 索引 + search_vault + 嵌入调用 | + EmbeddingPort + 本地 embedding adapter + 设置面板更新 |
| W3 | 混合检索 + 流式输出 + 引用标记 | 不变 |
| W4+ | Subagent: Indexer | + RerankerPort + API adapter（可选） |
