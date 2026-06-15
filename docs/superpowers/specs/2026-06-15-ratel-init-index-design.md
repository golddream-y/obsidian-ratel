# S-INIT-INDEX — 初始化嵌入 + 自动索引(合并)

| 字段 | 值 |
|---|---|
| Spec ID | S-INIT-INDEX |
| 状态 | Active |
| 创建 | 2026-06-15 |
| 取代 | [S-INIT-EMBED](file:///Users/golddream/code/git-public/Ratel-CLI/docs/superpowers/specs/2026-06-15-ratel-init-embedding-design.md) · [S-INDEX-AUTO](file:///Users/golddream/code/git-public/Ratel-CLI/docs/superpowers/specs/2026-06-15-ratel-auto-indexing-design.md) — 两 spec 内容已合并 |
| 关联 PRD | [`docs/PRD.md` § F6 Worker 后台索引](file:///Users/golddream/code/git-public/Ratel-CLI/docs/PRD.md) · [`docs/PRD.md` § F10 初始化嵌入](file:///Users/golddream/code/git-public/Ratel-CLI/docs/PRD.md) |
| 关联架构 | [`docs/ARCHITECTURE.md` § 5 索引管线](file:///Users/golddream/code/git-public/Ratel-CLI/docs/ARCHITECTURE.md) · [`docs/architecture/vector-index.md` 向量化与索引架构](file:///Users/golddream/code/git-public/Ratel-CLI/docs/architecture/vector-index.md) · [`docs/architecture/tool-dispatch.md` § 6 嵌入管线复用](file:///Users/golddream/code/git-public/Ratel-CLI/docs/architecture/tool-dispatch.md) |
| 调研参考 | [Smart Connections v4 源码](https://github.com/brianpetro/obsidian-smart-connections) — `SmartEnv` 生命周期 · `process_watch` 增量 · `pause_controls` 暂停 · `.scignore` 排除 |

---

## 1. 背景

### 1.1 当前实现状态(2026-06-15 实测)

PRD F6 / F10 已承诺「模型本地化 + 自动索引 + 进度可见」,但**实测 0 实现**:

| 能力 | 文件 | 状态 |
|---|---|---|
| `VectraStore` 适配器 | [src/adapters/vector-vectra.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/adapters/vector-vectra.ts) | ✅ 接口完整(upsert / search / delete / status) |
| `EmbeddingLocal` 适配器 | [src/adapters/embedding-local.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/adapters/embedding-local.ts) | ⚠️ 接口在,但**懒加载**且**不暴露进度** |
| Worker 消息协议 | [src/types.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/types.ts#L47-L66) | ✅ 6 个 type 已定义 |
| **Worker handler 实现** | [src/worker/handler.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/worker/handler.ts#L30-L34) | ❌ **`NOT_IMPLEMENTED` 占位** |
| **main.ts 首扫触发** | [src/main.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/main.ts) | ❌ **没调** `index.full`;装完插件索引为空 |
| **FolderWatcher(vault 事件)** | 仓库无此文件 | ❌ **整个模块缺失** |
| **进度推 UI** | [src/worker/handler.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/worker/handler.ts#L23-L28) | ❌ `index.status` 返死值 |
| **VectraStore 注入** | [src/main.ts](file:///Users/golddream/code/git-public/Ratel-CLI/src/main.ts) | ❌ 没构造,`indexDir` 未定 |
| **模型下载管理** | 仓库无此模块 | ❌ 不自动下载 / 无进度 / 无磁盘检测 / 无重试 |

### 1.2 核心问题(用户能感知)

| # | 场景 | 现状 | 用户体感 |
|---|---|---|---|
| 1 | 装完插件首次启动 | 索引是空 | `search_semantic` 返 0 结果,`get_recent_notes` 返全部 |
| 2 | 用户写了 100 篇笔记 | 索引未更新 | 智能检索无响应 |
| 3 | 用户删了一篇笔记 | 索引残留 | 检索返「死链」 |
| 4 | vault 1000+ 笔记,首扫 | 进度不可见 | 用户以为「卡死」 |
| 5 | 用户不想索引某些文件夹 | 没机制 | 私人日记被向量化 |
| 6 | 模型下载静默失败 | 进度走 console | 用户看不到,看着像「卡死」 |
| 7 | 模型下到一半爆盘 | 无检测 | 半下载垃圾,需手动清 |
| 8 | 网络抖一下模型重下 | 无重试机制 | 用户抓狂 |

### 1.3 调研结论(Smart Connections 模式)

| 借鉴 | 详情 |
|---|---|
| **延迟初始化** | `onload` 不干重活,`app.workspace.onLayoutReady` 触发起飞 |
| **SmartEnv 中心化** | 索引 / 事件 / 设置集中到 `SmartEnv`,调用方 `await wait_for({ loaded: true })` |
| **事件总线** | `this.env.events.emit(...)` — 解耦的 progress / 状态通知 |
| **`.scignore` 排除** | gitignore 语法,主动排除 |
| **`.smart-env` 目录** | 索引数据独立目录,自动 gitignore |
| **pause_controls** | 用户主动暂停索引(写笔记时不想让索引抢占资源) |
| **process_watch** | vault 事件 → 队列 → 批量处理(去抖) |

### 1.4 合并理由(为什么一个 spec)

S-INIT-EMBED 讲「模型怎么下」,S-INDEX-AUTO 讲「索引怎么起」;两者**强依赖**(下不了模型就起不了索引)、**共享事件总线**、**共享 Svelte store 状态机**。拆开 = 实施时跨 spec 协调成本高;合并 = 单一 spec 描述单一职责(从装插件到索引就绪的端到端流程)。

---

## 2. 目标

设计一套**零感知**的「模型下载 + 索引同步」端到端系统,让用户**永远不卡在配置 / 下载 / 索引**这一步,索引永远跟 vault 状态同步。

**验收**(每条都可量化):

1. 首次启动 → 默认模型自动下,索引自动起,**不阻塞** onload
2. 1000 篇笔记首扫 < 10 分钟,进度推到 UI
3. 默认小模型 ≤ 100MB,**5 分钟内**下载完成
4. 用户新建 / 修改 / 删除笔记 → **5 秒内**索引更新(去抖)
5. 用户可主动「暂停 / 恢复 / 重新索引」,不强制重启
6. 用户可写 `.ratelignore` 排除文件(支持 gitignore 语法)
7. 索引数据存 `.obsidian/plugins/ratel-vault/.index/`,自动 gitignore
8. 模型下载 / 索引失败 → 不挂 Chat,降级到关键词检索
9. 磁盘不足 / 网络断 → 明确报错,用户可手动重试,不留半下载垃圾

---

## 3. 非目标

明确**不做**(防 scope creep):

- ❌ 跨 vault 索引
- ❌ 实时协同(多人同时编辑)
- ❌ 增量重建(用户手动 `reindex` 走全量)
- ❌ 复杂的过滤 DSL(只用 `.ratelignore` gitignore 语法)
- ❌ 索引分片(单文件 vectra,够用)
- ❌ 跨插件共享索引(只供 Ratel 内部用)
- ❌ 模型训练 / 微调
- ❌ 自定义模型仓库(只用 HuggingFace 官方 + Xenova 镜像)
- ❌ 模型版本自动升级
- ❌ TensorRT / GPU 加速(ONNX WASM 跑 CPU,够用)
- ❌ 自定义量化策略(只支持 q8 / fp32)
- ❌ 模型热切换(必须重建 pipeline)
- ❌ 离线模式下的模型"自带"

---

## 4. 详细设计

### 4.1 端到端状态机

```
[Plugin Load]
    │
    │  onload
    ▼
[Main Init]                  ← 构造 ModelManager / IndexManager / Worker
    │                          ← 都不干重活
    │  app.workspace.onLayoutReady
    ▼
[Model: NotStarted]──┐
                     │  ModelManager.init()
                     ▼
[Model: Checking]──磁盘够→ [Downloading]──完成→ [Model: Ready]
                       │                  │
                       │ 磁盘不够         │ 失败
                       ▼                  ▼
                  [Model: Failed]←────重试─┘
                     │
                     │ 仅在 Model: Ready 时
                     ▼
[Index: Init]──enqueue all→ [Index: Scanning]──完成→ [Index: Ready]
                    │                          │
                    │ 失败                      │ 失败
                    ▼                          ▼
              [Index: Failed]←─────重试────────┘
                                         │
                                         │  FolderWatcher 触发
                                         ▼
                                  [Index: Queueing]→[Processing]→[Ready] (循环)
                                         │
                                         │  跨所有状态可被:
                                         ├─ 用户「暂停」→ [Index: Paused]
                                         ├─ 用户「恢复」→ 追平队列
                                         └─ 用户「重新索引」→ [Scanning] (清空)
```

**关键路径**:
- **起飞点**:`onLayoutReady`,**不**在 onload
- **依赖关系**:Index 必须等 Model: Ready 才进 Init(嵌入 API 不可用时启动索引是浪费)
- **失败可恢复**:Model 和 Index 各自有 Failed 状态,用户可单独重试,互不影响

### 4.2 状态枚举与 UI 映射

#### Model 状态(6 个)

| 状态 | UI 显示 | 行为 |
|---|---|---|
| `NotStarted` | 「模型未下载,点此下载」按钮 | 静默 |
| `Checking` | 「正在检查磁盘 / 模型元信息」 | 瞬时 |
| `Downloading` | 进度条 + 「下载中 X%」+ 速度 / 剩余时间 | 后台 |
| `Ready` | ✓「已就绪:模型名 + 大小 + 加载时间」 | 检索可用 |
| `Failed` | ✗「下载失败:原因」+ 「重试」按钮 | 等待用户 |
| `Switching` | 「正在切换模型…」 | 当前 batch 完成后生效 |

#### Index 状态(9 个)

| 状态 | UI 显示 | 行为 |
|---|---|---|
| `Idle` | 不显示(瞬时) | onload 触发后立刻进 Init |
| `Init` | 「正在准备索引…」 | 扫目录 + 完整性检查,瞬时 |
| `Scanning` | 「正在索引 235/1000 (23%)」进度条 | 全量,Worker 推进度 |
| `Queueing` | 「有 5 个文件待索引」 | 增量队列非空 |
| `Processing` | 「正在索引 5 个文件」 | 单 batch 处理,通常 < 1s |
| `Ready` | 不显示(静默) | 队列空,索引就绪 |
| `Paused` | ⚠「索引已暂停」+ 「恢复」按钮 | 用户主动暂停 |
| `Failed` | ✗「索引失败:原因」+ 「重试」 | 等用户手动 |
| `Unloaded` | 不显示 | 插件卸载 |

### 4.3 三层组件

```
┌──────────────────────────────────────────────────────────────┐
│                        主线程(Main)                            │
│                                                              │
│  ModelManager                          IndexManager            │
│  ┌──────────────────────┐              ┌────────────────────┐ │
│  │ Model: NotStarted    │              │ Index: Idle         │ │
│  │      ↓               │              │      ↓              │ │
│  │      Checking        │──Ready 触发→│      Init            │ │
│  │      ↓               │              │      ↓              │ │
│  │      Downloading     │              │      Scanning       │ │
│  │      ↓               │              │      ↓              │ │
│  │      Ready           │              │      Ready          │ │
│  └────────┬─────────────┘              └────────┬───────────┘ │
│           │                                     │             │
│           ▼                                     ▼             │
│  ModelDownloader                        FolderWatcher         │
│  (包装 transformers 进度回调)             (vault 事件去抖 5s)  │
│           │                                     │             │
└───────────┼─────────────────────────────────────┼─────────────┘
            │ postMessage                          │ postMessage
            ▼                                      ▼
┌──────────────────────────────────────────────────────────────┐
│                     Worker(纯 IO,无 HTTP)                     │
│                                                              │
│  ┌──────────────────────┐    ┌──────────────────────────┐    │
│  │ IndexProcessor       │    │ VectraStore              │    │
│  │ - 收已分块已嵌入     │    │ - upsert                 │    │
│  │ - vectra.upsert      │──▶ │ - delete                 │    │
│  │ - 推 _progress       │    │ - search (cosine)        │    │
│  └──────────────────────┘    └────────┬─────────────────┘    │
│                                       │                       │
│                                       ▼                       │
│                       .obsidian/plugins/ratel-vault/         │
│                       .index/ (vectors + chunks)             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 4.4 组件职责

| 组件 | 职责 | 状态 |
|---|---|---|
| **ModelManager** | 状态机 / 下载触发 / 切换 / 清理 / 磁盘检测 | 新建 |
| **ModelDownloader** | 包装 transformers pipeline + progress_callback | 新建 |
| **IndexManager** | 状态机 / FolderWatcher 注册 / 暂停恢复 / 重新索引 | 新建 |
| **FolderWatcher** | vault 事件去抖 5s | 新建 |
| **EmbeddingLocal** | 不再懒加载,接受 ModelManager 注入 | 改造 |
| **EmbeddingApi** | 不动(远端 API,无下载) | 既有 |
| **VectraStore** | upsert / delete / search / status | 既有 |
| **WorkerManager** | 6 个消息 type 真实现 | 改造 |

### 4.5 启动期时序

```
main.ts onload
  │
  ├─ loadSettings
  ├─ new VectraStore(pluginsDir + '/.index')
  ├─ new ModelManager(...)
  ├─ new IndexManager(...)
  ├─ new WorkerManager(workerPath, onProgress)
  ├─ this.registerEvent(workspace.onLayoutReady(() => {
  │     modelManager.init();         // 触发默认模型下载
  │     indexManager.onLayoutReady(); // 等 Model: Ready 后才进 Init
  │   }))
  ├─ registerView / addCommand
  └─ return (onload 完成,不阻塞)

───── onLayoutReady ─────

ModelManager.init()
  │
  ├─ 扫 .cache/huggingface/ → installed
  ├─ 检查默认模型
  ├─ 缺 → download('Xenova/bge-small-zh-v1.5')
  │     │
  │     └─ checkDisk → 磁盘够 → ModelDownloader.ensureModel()
  │         │
  │         └─ transformers pipeline 加载(q8 量化)
  │             │
  │             └─ progress_callback → status$ → UI 进度条
  │
  └─ Ready 时:indexManager.onLayoutReady()

IndexManager.onLayoutReady()
  │
  ├─ 状态 → Init
  ├─ Worker:index.status → vectra 探活
  ├─ 比对 vault 笔记数 vs vectra 已索引
  ├─ 缺失 → enqueue 全部
  ├─ 状态 → Scanning
  └─ Worker:index.full
       │
       └─ for each path (10/批):分块(主线程)→ 嵌入(主线程)→ upsert(Worker)
           │
           └─ _progress { scanned, total, currentFile }
```

### 4.6 增量同步(FolderWatcher)

**事件映射**:

| Obsidian 事件 | 行为 |
|---|---|
| `create` | enqueue(path, upsert),**立即**(不去抖) |
| `modify` | enqueue(path, upsert),**5s 去抖** |
| `delete` | enqueue(path, delete),立即 |
| `rename` | 等价 `delete(old) + create(new)` |

**5s 单文件去抖**(借鉴 Smart Connections process_watch):

```typescript
watch(path: string, op: 'upsert' | 'delete') {
  // 关键路径:同 path 多次 modify,只保留最后一次;5s 后才真触发
  const existing = this.pending.get(path);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    this.flushOne(path, op);
    this.pending.delete(path);
  }, 5_000);
  this.pending.set(path, { op, timer });
}
```

**为什么不走「批量 5 秒窗口」**(更激进)?

- 多数 vault 改动是**单文件**(用户编辑 / 删除)
- 5 秒单文件去抖够用,**不**需要等批量窗口
- 「批量窗口」延迟体感差(用户改完 5 秒才看到索引动)

### 4.7 模型下载机制

**默认模型**:`Xenova/bge-small-zh-v1.5`(~90MB,512 维)

| 模型 | 大小(q8) | 维度 | 适用 |
|---|---|---|---|
| **bge-small-zh-v1.5**(默认) | ~90MB | 512 | 90% 用户,笔记本 |
| bge-base-zh-v1.5 | ~210MB | 768 | 准度优先 |
| bge-large-zh-v1.5 | ~650MB | 1024 | 服务器 |
| BAAI/bge-m3 | ~600MB | 1024 | 跨语言 |
| all-MiniLM-L6-v2 | ~25MB | 384 | 纯英文 |

**磁盘空间检测**(阻断性):

```
if (model.size * 1.2 > available) {
  throw InsufficientDiskError(need, available);
}
```

- **1.2 倍缓冲**:transformers 缓存会写中间文件
- Node.js `fs.statfs()` 跨平台

**失败重试 + 断点续传**:

| 场景 | 行为 |
|---|---|
| 网络断开 | transformers 缓存校验:只下未完成部分(HuggingFace 支持 Range) |
| 磁盘满 | 抛 `InsufficientDiskError`;UI 提示清理 + 「重试」 |
| 用户取消 | 保留半下载,下次续传 |
| 文件损坏 | 删掉损坏 + 重新下载 |
| 元数据不匹配 | 提示「模型已更新,是否重新下载?」 |

**多模型并存**(F10.8):settings `embedModelActive` 字段;切换不需重启插件,但等当前 batch 完成后才生效。

**卸载清理**:`.cache/huggingface/` 二次确认清空。

### 4.8 `.ratelignore` 排除

**位置**:vault 根目录(跟 `.obsidian/` 同级)
**语法**:gitignore 兼容(`ignore` npm 包,~5KB)
**默认**:

```gitignore
.obsidian/
.trash/
.augmented-canvas/
.obsidian-canvas/
.obsidian-snippets/
```

**为什么不复用 `.gitignore`**:

- 用户可能没用 git,或只想 ignore git
- 单独文件语义清晰(专门控制索引)
- 不冲突

**热重载**:启动期读 + 解析;文件变更 → 重解析(用 `vault.on('modify', '/.ratelignore')`)

### 4.9 暂停 / 恢复 / 重新索引

| 操作 | 行为 |
|---|---|
| **暂停** | 状态 → Paused;Worker 继续完成当前 batch;新事件入队**不消费** |
| **恢复** | Paused → 上一个非 Paused 状态;队列追平 |
| **重新索引** | 清空 `.index/` + 状态 → Scanning;走全量 |

**关键设计**:**暂停 ≠ 卸载事件**。暂停时 vault 事件继续监听(累积 `pending`),恢复后批量追平。

### 4.10 失败与降级矩阵

| 失败点 | 降级策略 |
|---|---|
| **Worker 崩溃** | `WorkerManager` 重建;IndexManager 状态 → Failed |
| **嵌入 API 不可用** | `search_semantic` 返 `INDEX_NOT_READY`;`search_notes` 仍可用 |
| **磁盘满** | vectra upsert 抛错;IndexManager 状态 → Failed,提示清理 .index/ |
| **模型下到一半爆盘** | `InsufficientDiskError`;UI 提示清理 + 重试 |
| **内容超大(> 10MB)** | 跳过 + 记日志 |
| **文件无 read 权限** | 跳过 + 记日志 |
| **`.ratelignore` 语法错** | 回退到「不 ignore」+ 警告,不让整个索引挂 |
| **模型未就绪** | 工具层 `INDEX_NOT_READY`;Chat 仍可用(关键词兜底) |
| **网络断(模型下载)** | 留半下载 + 续传 + 用户重试 |

**核心原则**:**索引挂 ≠ Chat 挂**。

### 4.11 自动 gitignore

启动期写:

```gitignore
# Ratel Vault
.obsidian/plugins/ratel-vault/.index/
.obsidian/plugins/ratel-vault/cache/
```

**借鉴 Smart Connections `add_to_gitignore`**,但只写自己的目录。

### 4.12 索引目录结构

```
.obsidian/plugins/ratel-vault/
├── data.json                       # 既有:settings + 会话
├── .index/                         # 既有 vectra 产物(自动 gitignore)
│   ├── index.json                  # vectra 元数据
│   ├── vectors.bin                 # 向量
│   └── chunks.json                 # 文本块
├── .ratelignore                    # 用户配置(可选,自动 gitignore)
└── ...
```

---

## 5. 关键代码骨架

### 5.1 ModelManager

```typescript
/**
 * @file src/core/model-manager.ts
 * @description 本地 Embedding 模型生命周期管理
 * @module core/model-manager
 * @depends adapters/embedding-local, ports/embedding
 */

type ModelStatus =
  | { state: 'NotStarted' }
  | { state: 'Checking' }
  | { state: 'Downloading'; progress: number; speed: number; eta: number }
  | { state: 'Ready'; modelId: string; size: number; loadedAt: number }
  | { state: 'Failed'; reason: string }
  | { state: 'Switching'; from: string; to: string };

interface ModelInfo {
  id: string;
  sizeBytes: number;
  dimensions: number;
  description: string;
  recommended: boolean;
}

class ModelManager {
  /** 当前状态(响应式:UI 订阅 status$ ) */
  readonly status$ = writable<ModelStatus>({ state: 'NotStarted' });

  /** 已下载模型目录(.cache/huggingface/ 扫描) */
  private installed = new Map<string, ModelInfo>();

  /** 启动时调用:扫描已下模型 + 触发默认下载 */
  async init(): Promise<void>;

  /** 用户主动触发:下载指定模型(后台) */
  async download(modelId: string): Promise<void>;

  /** 用户主动触发:切换当前模型(等 batch 完成) */
  async switchTo(modelId: string): Promise<void>;

  /** 用户主动触发:删除指定模型(清理磁盘) */
  async remove(modelId: string): Promise<void>;

  /** 用户主动触发:一键清理所有本地模型 */
  async cleanup(): Promise<void>;
}
```

### 5.2 ModelDownloader

```typescript
/**
 * @file src/core/model-downloader.ts
 * @description 模型下载器(包装 transformers pipeline 加载)
 */

class ModelDownloader {
  /**
   * 启动 pipeline 加载(transformers 内部按需下载 + 缓存)
   * @param modelId - HuggingFace model id
   * @param onProgress - 进度回调(0-1 + 文件名 + 速度)
   * @throws InsufficientDiskError 磁盘不足
   * @throws NetworkError 永久失败(连续 N 次)
   */
  async ensureModel(
    modelId: string,
    onProgress?: (p: { file: string; progress: number; speed: number }) => void
  ): Promise<FeatureExtractor>;

  /** 检测磁盘空间(预估 + 实际 + 1.2 倍缓冲) */
  private async checkDisk(modelId: string): Promise<void>;
}
```

### 5.3 IndexManager

```typescript
/**
 * @file src/core/index-manager.ts
 * @description 自动索引管理器 — 状态机 + FolderWatcher + 进度推送
 * @module core/index-manager
 * @depends worker/manager, ports/vault, svelte/store
 */

type IndexStatus =
  | { state: 'Idle' }
  | { state: 'Init' }
  | { state: 'Scanning'; scanned: number; total: number; currentFile?: string }
  | { state: 'Queueing'; pending: number }
  | { state: 'Processing'; currentBatch: string[] }
  | { state: 'Ready'; totalDocs: number; lastIndexTime: number }
  | { state: 'Paused'; previousState: IndexStatus }
  | { state: 'Failed'; reason: string }
  | { state: 'Unloaded' };

class IndexManager {
  /** 状态流(响应式) */
  readonly status$ = writable<IndexStatus>({ state: 'Idle' });

  /** 待处理队列 */
  private queue = new Map<string, { op: 'upsert' | 'delete' }>();

  /** 启动时调用:onload 后立刻执行(只做轻量探活) */
  async init(): Promise<void>;

  /** 布局就绪时调用(等 Model: Ready 才真起飞) */
  async onLayoutReady(): Promise<void>;

  /** FolderWatcher 触发:入队 */
  enqueue(path: string, op: 'upsert' | 'delete'): void;

  /** 用户主动操作 */
  pause(): void;
  resume(): void;
  async reindex(): Promise<void>;
}
```

### 5.4 FolderWatcher

```typescript
/**
 * @file src/core/folder-watcher.ts
 * @description vault 事件去抖监听
 * @module core/folder-watcher
 */

class FolderWatcher {
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  /** 启动监听(在 onload 注册到 this.registerEvent) */
  start(handlers: { onUpsert: (path: string) => void; onDelete: (path: string) => void }): void;

  /** 5 秒去抖(同 path 多次 modify 只触发 1 次) */
  private watch(path: string, op: 'upsert' | 'delete', handler: (path: string) => void): void;
}
```

### 5.5 Worker handler 改造(关键 6 消息 type)

```typescript
/**
 * @file src/worker/handler.ts(改造)
 * @description 真实实现 index.full / index.incremental / vector.upsert
 */

case 'index.full': {
  // 1. 主线程已传 vaultPath + embedderHandle
  // 2. 扫 .index/ 比对 vectra 状态
  // 3. 推 .ratelignore 过滤后的 markdown 文件列表
  // 4. 分批(chunked 10/批)→ 嵌入 → upsert
  // 5. 每个 batch 推一次 _progress 消息
  // 6. 完成后发 done
}

case 'index.incremental': {
  // 单文件去抖后入队,跟 index.full 共享 processFile()
}

case 'vector.upsert': { /* 调 vectra.upsert */ }
case 'vector.delete': { /* 调 vectra.delete */ }
case 'vector.search': { /* 调 vectra.search,返 hits */ }
case 'index.status':  { /* 返 totalDocs / lastIndexTime */ }
```

---

## 6. 跟现有架构的衔接

| 组件 | 衔接方式 |
|---|---|
| **VectraStore** | 现有接口够用;新注入到 main.ts |
| **WorkerManager** | 现有协议不变;新增 `index:progress` 消息 |
| **EmbeddingPort** | 主线程调,Worker 收已经向量化的 chunk |
| **ObsidianVault** | 提供 `listMarkdownFiles` / `readFile` / `deleteFile`(F7 新增) |
| **Settings** | 加 `indexPaused` / `embedModelActive` 字段 |
| **.obsidian/plugins/ratel-vault/.index/** | 启动期检查存在性,首次自动创建 |
| **.obsidian/plugins/ratel-vault/.gitignore** | 启动期自动写 |

**复用,不重写**:
- `VectraStore` 接口完整
- `WorkerManager` 协议成熟
- `EmbeddingPort` 双 adapter(local / api)
- `chunkMarkdown` 已有

---

## 7. 用户感知层

### 7.1 设置面板「模型管理」tab

| 区块 | 内容 |
|---|---|
| **当前模型** | 名称 + 大小 + 维度 + 状态(✓ / 下载中 / 失败) |
| **进度条** | 百分比 + 已下载 / 总大小 + 速度(MB/s) + 剩余时间估算 |
| **可下载模型列表** | 默认小模型(✓ 已下) / BGE-base / BGE-large / BGE-m3 / MiniLM — 状态 + 「下载」/「切换」/「删除」按钮 |
| **磁盘空间** | `.cache/huggingface/` 已占空间 + 系统可用空间 |
| **重置** | 「清理所有本地模型」按钮(二次确认) |

### 7.2 设置面板「索引」tab

| 区块 | 内容 |
|---|---|
| **当前状态** | ✓ 就绪 / ⚠ 暂停 / ✗ 失败 |
| **进度** | Scanned 235 / Total 1000(全量时)或 Pending 5(增量时) |
| **统计** | 总文档数 / 上次索引时间 / 平均增量延迟 |
| **控制** | 「暂停」/「恢复」/「重新索引」三个按钮 |
| **磁盘空间** | `.index/` 已占空间 |
| **忽略规则** | 「编辑 .ratelignore」链接 |

### 7.3 Chat 侧栏状态提示

**Model 状态**:
- `Ready` → 不显示
- `Downloading` → 顶部小 banner:「正在准备语义检索(85%)…」
- `Failed` → 顶部 banner:「语义检索不可用,关键词检索仍可用」+ 「重试」链接
- `NotStarted` → 首次启动:「正在下载默认模型…」

**Index 状态**:
- `Ready` → 不显示
- `Scanning` / `Processing` → 顶部小 banner:「正在索引 235/1000…」
- `Queueing` → 「有 5 个文件待索引」
- `Paused` → ⚠「索引已暂停」+ 「恢复」按钮
- `Failed` → ✗「索引失败」+ 「重试」

### 7.4 Ribbon 角标(可选)

模型 / 索引未就绪时 Ribbon 图标加小红点 + Tooltip「模型 / 索引准备中」

---

## 8. 关键决策记录

| 决策 | 选项 | 选择 | 理由 |
|---|---|---|---|
| **Spec 拆分** | 1 个 vs 2 个(S-INIT-EMBED + S-INDEX-AUTO) | **1 个 S-INIT-INDEX** | 强依赖,共享事件总线,合并后端到端流程清晰 |
| **起飞时机** | onload vs onLayoutReady | **onLayoutReady** | 不阻塞 UI;借鉴 Smart Connections |
| **起飞依赖** | 立即起飞 vs 等 Model: Ready | **等 Model: Ready** | 嵌入 API 不可用时启动索引是浪费 |
| **去抖策略** | 5s 单文件 vs 5s 批量窗口 | **5s 单文件** | 体感优先 |
| **分块 + 向量化** | 主线程 vs Worker | **主线程** | Worker 不发 HTTP(AGENTS.md 硬约束) |
| **Worker 职责** | 全做 vs 仅 IO | **仅 IO** | 纯 upsert/delete/search,无 HTTP |
| **排除机制** | `.ratelignore` vs 复用 `.gitignore` | **新建 `.ratelignore`** | 语义清晰,不冲突 |
| **索引目录** | 插件目录 vs vault 根 | **插件目录** | 不污染 vault,自动 gitignore |
| **进度推送** | 轮询 vs 事件 | **事件**(Svelte store) | 实时,无轮询 |
| **暂停机制** | 卸载事件 vs 累积 | **累积** | 恢复后追平 |
| **失败重试** | 自动 vs 手动 | **手动** | 索引 / 模型失败原因复杂,自动可能循环 |
| **失败降级** | 强阻塞 vs 弱降级 | **弱降级** | Chat 永远可用,关键词兜底 |
| **进度精度** | chunk 级 vs 文档级 | **文档级** | 用户感知;chunk 级太细无意义 |
| **默认模型** | bge-small(90MB) vs BGE-M3(600MB) | **bge-small** | 90% 用户零感知下载;高级用户可升级 |
| **磁盘缓冲** | 1.0x vs 1.2x | **1.2x** | transformers 缓存会写中间文件 |

---

## 9. 性能预算

| 场景 | 目标 | 验证方式 |
|---|---|---|
| 1000 笔记首扫 | < 10 分钟 | 集成测试(嵌入 API 500ms / 文档) |
| 增量同步(单文件) | < 5s 去抖 + < 1s 索引 | 集成测试 |
| `search_semantic` 检索 | < 200ms | 单元测试(mock embedding) |
| 默认模型下载(90MB) | < 5 分钟(5G 网络) | 集成测试 |
| 索引占磁盘 | < 50MB / 1000 文档 | 集成测试 |
| 索引占内存(vectra) | < 100MB | 集成测试 |
| 启动期(只探活) | < 500ms | 集成测试 |
| 状态切换延迟 | < 50ms | 单元测试 |

---

## 10. 测试要求

| 类别 | 测试用例 |
|---|---|
| **Model 状态机** | NotStarted → Downloading → Ready 全链路;Failed 路径;Switching 路径 |
| **Index 状态机** | Idle → Init → Scanning → Ready;Paused 中间插入;Failed 恢复 |
| **FolderWatcher 去抖** | 同 path 1s 内多次 modify → 5s 后只触发 1 次;不同 path 并行 |
| **批量处理** | index.full 1000 文件进度正确;失败不挂后续 |
| **`.ratelignore`** | 解析正确;语法错回退;热重载 |
| **磁盘检测** | 不足时阻断 + 错误类型;刚好够;1.2 倍临界 |
| **下载进度** | 回调被正确触发;失败时回滚状态 |
| **多模型切换** | 切完维度同步更新;切一半中断可恢复 |
| **降级** | 模型 Failed 时 `search_semantic` 返 `INDEX_NOT_READY`;`search_notes` 仍可用 |
| **暂停/恢复** | Paused 时事件入队不消费;Resume 后批量追平 |
| **清理** | cleanup 后磁盘释放;settings 状态重置 |
| **gitignore** | 启动期检查 .gitignore 行存在;重复启动幂等 |
| **状态机并发** | 多 vault 事件并发时只触发 1 次 upsert(同 path) |
| **i18n** | 所有 UI 文案走 `plugin.i18n`;错误消息 key 化 |

**测试隔离**:
- `vi.mock('app.vault.on')` 模拟 vault 事件
- `vi.mock('@huggingface/transformers')` 跳过真实嵌入

---

## 11. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| vault 1w+ 笔记首扫爆内存 | 中 | 分批 10/次;流式处理 |
| 嵌入 API 限流 | 中 | 退避重试(1s / 2s / 4s);失败降级到关键词 |
| Worker 假死 | 中 | `WorkerManager` 超时 + 重建 |
| HuggingFace CDN 不可达 | 中 | 提示用 HF Mirror;允许自定义 base URL |
| 用户磁盘太小(< 200MB) | 中 | 默认模型 90MB,90% 用户够;不足时阻断 + 引导 |
| 进程崩溃导致半下载 | 低 | transformers 缓存机制天然支持断点续传 |
| ONNX 推理慢(CPU) | 低 | 默认小模型 + q8 量化,500 token < 100ms |
| 切换模型时正在跑 batch | 中 | `Switching` 状态等当前 batch 完成才生效 |
| 用户装了 5 个模型 = 2.5GB | 低 | 设置面板「磁盘空间」区块展示;主动「清理」按钮 |
| transformers 库版本升级破坏 API | 中 | pin 住版本;失败时降级到 `api:` provider |
| `.ratelignore` 误配 | 低 | 启动期警告 + 不阻塞 |
| 跨平台路径(Windows `\` vs Unix `/`) | 中 | `path.posix` 统一 |
| 索引数据被 git commit 误传 | 中 | 启动期自动加 gitignore |
| 暂停时仍有未完成 batch | 低 | Worker 完成当前 batch 后才真正停接活 |
| 大 vault 增量爆炸(批量粘贴 1000 文件) | 中 | 队列 + 串行;UI 显示真实进度 |
| Obsidian 关闭时未完成 | 低 | `onunload` 主动 `await flushQueue()`,超时 5s 强制停 |

---

## 12. 实施分批

按 YAGNI + 渐进交付,**8 批次**:

| 批次 | 范围 | 估时 |
|---|---|---|
| **M-0:基础接线** | main.ts 注入 VectraStore + 自动 gitignore + .ratelignore 解析 | 1d |
| **M-1:Worker 真接 vectra** | handler.ts 6 个 case 真实现(无 HTTP,只 IO) | 1.5d |
| **M-2:IndexManager + 状态机** | 状态机 + 事件总线 + 进度推送 | 1.5d |
| **M-3:FolderWatcher + 去抖** | vault 事件监听 + 5s 去抖 + 队列 | 1d |
| **M-4:用户控制 + 降级** | 暂停/恢复/重新索引 + Chat banner | 1d |
| **M-5:ModelManager + 状态机** | 模型状态机 + 磁盘检测 + 进度 UI | 1d |
| **M-6:EmbeddingLocal 改造** | 去掉懒加载,接受注入;返 `INDEX_NOT_READY` 错误 | 0.5d |
| **M-7:多模型 + 切换 + 清理** | 多模型并存 + 切换 + 卸载清理 | 0.5d |
| **M-8:测试 + 灰度** | 状态机 / 降级 / 磁盘 / 切换 / 清理单测 + BRAT 灰度 | 2d |

**总估时**:**~ 10 工作日**

---

## 13. 验收标准

- [ ] M-0: 启动期自动加 gitignore;`.ratelignore` 解析支持 gitignore 语法
- [ ] M-1: 6 个 Worker 消息 type 全部真实现;不再有 `NOT_IMPLEMENTED`
- [ ] M-2: Index 状态机完整;UI 订阅 status$ 实时更新
- [ ] M-3: vault create/modify/delete/rename 全部走 FolderWatcher;5s 去抖验证
- [ ] M-4: Settings tab「索引」区块有「暂停 / 恢复 / 重新索引」按钮
- [ ] M-4: Chat 顶部 banner 在 Scanning / Queueing / Paused 状态显示
- [ ] M-5: Model 状态机完整;启动期自动触发默认模型下载
- [ ] M-5: 首次启动后 30 秒内开始下载;90MB 模型 5 分钟内完成
- [ ] M-5: 进度推到设置面板,UI 不阻塞
- [ ] M-5: 磁盘不足时阻断 + 明确报错,不留半下载垃圾
- [ ] M-6: 模型未就绪时 Chat 可发起,UI 提示降级状态
- [ ] M-6: `search_semantic` 返 `INDEX_NOT_READY`;`search_notes` 不受影响
- [ ] M-7: 模型切换不重启插件,等当前 batch 完成才生效
- [ ] M-7: 「清理所有本地模型」按钮可一键释放磁盘
- [ ] M-8: 1000 模拟文件首扫进度推到 UI;降级路径(嵌入 API 挂)返 `INDEX_NOT_READY`
- [ ] M-8: ≥ 25 个新测试通过
- [ ] M-8: i18n 完整覆盖所有 UI 文案
- [ ] M-8: BRAT 灰度 1 周无 P0 bug

---

## 14. 参考

### 内部参考

- [PRD F6 / F10](file:///Users/golddream/code/git-public/Ratel-CLI/docs/PRD.md) — 需求源头
- [ARCHITECTURE.md § 5 索引管线](file:///Users/golddream/code/git-public/Ratel-CLI/docs/ARCHITECTURE.md) — 顶层架构
- [architecture/vector-index.md](file:///Users/golddream/code/git-public/Ratel-CLI/docs/architecture/vector-index.md) — 向量化与索引架构(下钻层)
- [VectraStore 当前实现](file:///Users/golddream/code/git-public/Ratel-CLI/src/adapters/vector-vectra.ts) — 改造基线
- [EmbeddingLocal 当前实现](file:///Users/golddream/code/git-public/Ratel-CLI/src/adapters/embedding-local.ts) — 改造基线
- [Worker handler 当前](file:///Users/golddream/code/git-public/Ratel-CLI/src/worker/handler.ts) — 改造基线
- [main.ts onload](file:///Users/golddream/code/git-public/Ratel-CLI/src/main.ts) — 加 ModelManager / IndexManager 钩子
- [已归档 S-MODEL-001](file:///Users/golddream/code/git-public/Ratel-CLI/docs/superpowers/archive/S-MODEL-001/) — 已有模型配置能力,本 spec 接力运行时下载管理

### 外部参考

- [Smart Connections v4 源码](https://github.com/brianpetro/obsidian-smart-connections) — `SmartEnv` 生命周期
- [obsidian-smart-env 源码](https://github.com/brianpetro/obsidian-smart-env) — 索引核心
- [@huggingface/transformers v4 文档](https://huggingface.co/docs/transformers.js) — pipeline 加载机制
- [Xenova 镜像](https://huggingface.co/Xenova) — ONNX 量化模型仓库
- [BGE 模型 MTEB 榜](https://huggingface.co/BAAI/bge-small-zh-v1.5) — 中文检索精度参考
- [transformers 缓存机制](https://huggingface.co/docs/transformers.js/guides/remote-tracking) — `.cache/huggingface/` 行为
- [ignore npm 包](https://www.npmjs.com/package/ignore) — gitignore 语法解析
- [Node.js fs.statfs](https://nodejs.org/api/fs.html#fsstatspath-options-callback) — 跨平台磁盘空间检测
- [vectra 文档](https://github.com/Stevenic/vectra) — LocalDocumentIndex

---

## 15. 修订历史

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-06-15 | 0.1 | 合并 S-INIT-EMBED + S-INDEX-AUTO,统一端到端流程;8 批次 10d 实施 | Agent(Erwin) |
