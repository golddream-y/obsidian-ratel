# 索引启动智能重算 — Smart Reindex + Manifest

- **Spec ID**: S-INDEX-STARTUP
- **创建日期**: 2026-06-28
- **状态**: Active
- **关联**: 无前置 spec
- **关联 Plan**: 待 writing-plans 生成

---

## 1. 背景

当前索引启动路径有两个 bug:

1. **P2 — 每次启动全库重 embed**:关闭 Obsidian 再打开,即使没改任何笔记,状态条也要等几分钟才能 Ready。期间 `search_vault` 被硬拦(`INDEX_NOT_READY`),用户没法搜。库越大越慢,5000 笔记要等数分钟。
2. **P3 — API embedding 模式完全不索引**:`embedProvider === 'api'` 时,`main.onLayoutReady` early return,把"索引启动"也一起跳过。用户切到 API 模式重启后,搜索永远返回空。

### 1.1 P2 根因(代码证据)

启动路径写死全量,且无 hash 检查:

- `src/main.ts` `onLayoutReady` → `indexController.onLayoutReady()`
- `src/core/index-manager.ts:51-66` `onLayoutReady()` 无条件调 `backend.fullReindex()`
- `src/worker/index-processor.ts:43-84` `indexFull` 逐文件 `chunkMarkdown → embeddings.embed(allChunkTexts) → upsertItem`,**每个文件都重新跑 ONNX 推理**
- 向量其实已落盘在 `.index/`(vectra `LocalDocumentIndex` 持久化),`VectraStore.init()` 也加载了,但启动决策**不参考**已有索引

讽刺的是:`sha256()` 工具(`src/utils/hash.ts:21`)已实现,`NoteMeta { path, hash, mtime }` 端口(`src/ports/persistence.ts:82`)注释明确写"hash 用来判断文件内容是否变更(增量索引)" —— **端口层早为增量索引设计好了,实现层没接**。

### 1.2 P3 根因(代码证据)

`src/main.ts:357`:

```typescript
if (this.settings.embedProvider !== 'local') {
  return;  // early return,跳过整个 onLayoutReady
}
```

这个 early return 原意是"API 模式不需要下载本地模型",但它把**索引启动**也一起跳过了。后果:

- `indexController.onLayoutReady()` 从不调用 → `FolderWatcher` 未启动 → vault 事件(create/modify/delete)不监听
- 即使 vault 改了文件,索引也不更新
- 用户重启后状态条可能卡在"未就绪",`search_vault` 被拦

### 1.3 三个问题的耦合(为什么放一个 spec)

P1(发版阻塞,local embedding 产物不在三件套)已由 ADR-006 落地,不在本 spec。

P2 修在 `onLayoutReady → fullReindex` 路径,P3 修在 `onLayoutReady` 的 early return。两个改动都在 `main.ts onLayoutReady` + `index-manager.ts onLayoutReady`,拆开做 = 同一批文件改两遍 + 合并冲突。

## 2. 目标

- **P2**:热启动(无文件变更)时索引秒级 Ready,零 embed 调用;文件变更时仅对变更文件 incremental
- **P3**:API embedding 模式启动时正常建立索引 + FolderWatcher 监听 vault 事件
- **chunk 残留**:文件变短时旧 chunk 不残留(vectra `deleteByPath`)
- **模型/参数切换**:embedding 模型或 chunk 参数变更时自动全量重建,避免向量空间不兼容
- **容错**:manifest 损坏 / 索引损坏 / embed 失败时保守降级,不让用户每次启动都全量

## 3. 非目标

- 不做设置切换即时重建(等重启走 smartReindex,见 §7)
- 不做 diff 期间搜索降级提示(diff 秒级完成,不值得加复杂度)
- 不接 `indexPaused` 设置(无明确用例,留 0.2.x)
- 不改 `chat-send-gate.ts` / `search-vault.ts`(搜索门控逻辑复用现有 `isSearchReady`)
- 不改 `NoteMeta` 端口(manifest 独立于 persistence,见 §4.1)
- 不做并发索引(单线程 smartReindex,0.1.x 够用)

## 4. 详细设计 — Manifest 数据结构

### 4.1 存哪:独立文件,不用 NoteMetaRepository

| 选项 | 结论 |
|---|---|
| ❌ 复用 `NoteMetaRepository`(走 `persistence-json.ts` → Obsidian `loadData/saveData`) | data.json 与会话历史混存,每次写 manifest 都全量序列化整个 data.json。大库(>1000 笔记)时 data.json 膨胀,读写变慢,且会话历史写入会被 manifest 写阻塞 |
| ✅ 独立文件 `pluginDir/index-manifest.json` | 独立 fs 读写,与 data.json 解耦。与 `.index/` 同目录,生命周期一致(模型切换/重置时一起清) |

**位置:** `<vault>/.obsidian/plugins/ratel-vault/index-manifest.json`(与 `.index/` 同级,与 `data.json` 同级)。

**gitignore:** `ensurePluginGitignore(pluginDir)` 已忽略整个 pluginDir,manifest 自动被忽略,无需额外处理。

### 4.2 字段定义

```typescript
// 新文件: src/core/index-manifest.ts

/**
 * 索引清单条目 — 记录单个文件在向量索引中的元数据。
 *
 * 设计要点:
 * - hash 用来判断内容是否变更(sha256),未变则跳过 re-embed
 * - chunkCount 用来检测文件变短导致的 chunk 残留(见 §8)
 * - mtime 仅作辅助快速跳过(若 mtime 未变则不必算 hash),不单独依赖
 */
interface IndexManifestEntry {
  /** 文件相对 vault 根的路径(如 "notes/foo.md"),作为 key */
  path: string;
  /** sha256(content),内容指纹 */
  hash: string;
  /** 文件最后修改时间戳(ms),快速跳过用 */
  mtime: number;
  /** 该文件被切成的 chunk 数,用于检测变短残留 */
  chunkCount: number;
}

/**
 * 索引清单 — 全局元数据 + 每文件条目。
 *
 * 设计要点:
 * - 全局参数(embedModelId/chunkSize/chunkOverlap)变化时整个 manifest 失效,
 *   触发全量重建,避免新旧 chunk 混入同一索引
 * - version 字段用于未来 manifest 格式升级时迁移
 */
interface IndexManifest {
  /** manifest 格式版本,初始为 1 */
  version: 1;
  /** 当前索引使用的 embedding 模型 ID(local 模式)或端点+模型名(api 模式) */
  embedModelId: string;
  /** chunkMarkdown 的 chunkSize 参数,变更时全量重建 */
  chunkSize: number;
  /** chunkMarkdown 的 chunkOverlap 参数,变更时全量重建 */
  chunkOverlap: number;
  /** 最近一次全量/增量索引完成时间(ms),用于诊断面板展示 */
  lastIndexTime: number;
  /** 每文件条目,key = 文件相对路径 */
  entries: Record<string, IndexManifestEntry>;
}
```

### 4.3 embedModelId 怎么填

两种 provider 不同:

| provider | embedModelId 取值 | 切换检测 |
|---|---|---|
| `local` | `ModelManager` 下载的 ONNX 模型 ID(如 `bge-small-zh-v1.5`) | 设置里换模型 → ModelManager 重新下载 → ID 变 → manifest 失效 → 全量 |
| `api` | `${apiBase}::${modelName}`(如 `http://localhost:11434::nomic-embed-text`) | 改端点或模型名 → 字符串变 → manifest 失效 → 全量 |

### 4.4 生命周期

```
首次安装(.index 不存在)
  → 全量索引 → 写 manifest

热启动(无文件变更)
  → 读 manifest + listMarkdownFiles + sha256 diff → 0 embed → Ready

文件修改
  → incremental → 更新该 entry(hash/chunkCount/mtime)

文件删除
  → vectra cleanup → 删除该 entry

模型/chunk 参数切换
  → 清 .index/ + 清 manifest → 全量重建 → 写新 manifest

reindex 命令(用户手动)
  → 清 .index/ + 清 manifest → 全量重建(绕过 hash diff)

manifest 损坏(JSON 解析失败)
  → 当作不存在 → 全量重建(容错,见 §9)
```

### 4.5 与已有端口的关系

| 已有组件 | 关系 |
|---|---|
| `NoteMeta { path, hash, mtime }` (`src/ports/persistence.ts:82`) | **不复用**。NoteMeta 是会话/笔记元数据端口,走 data.json;manifest 是索引专用,走独立文件。字段相似但生命周期不同 |
| `sha256()` (`src/utils/hash.ts:21`) | **复用**。manifest 的 hash 字段直接调这个 |
| `VectraStore.isIndexCreated()` | **复用**。判断是否首次(要不要全量) |

### 4.6 新模块

```
src/core/index-manifest.ts   # IndexManifest 类:load/save/diff/recordEntry/removeEntry/invalidate
tests/core/index-manifest.test.ts  # 单测:diff 算法 / 模型切换失效 / 损坏容错 / 空库
```

**`IndexManifest` 类职责:**

- `load()` — 从磁盘读 + JSON 解析(失败返回 null,调用方走全量)
- `save()` — 序列化写盘(原子写:写临时文件 → rename,避免半写)
- `diff(currentFiles: {path, content, mtime}[])` — 返回 `{ toAdd: [], toUpdate: [], toDelete: [], unchanged: [] }`
- `recordEntry(path, hash, mtime, chunkCount)` — 增量更新后调
- `removeEntry(path)` — 删除文件后调
- `invalidate()` — 清空 entries(模型切换时调,保留全局参数待重新填)
- `shouldFullRebuild(newEmbedModelId, newChunkSize, newChunkOverlap)` — 全局参数对比

## 5. 详细设计 — 启动流程 smart reindex

### 5.1 改造前 vs 改造后

**改造前(当前):**

```
onLayoutReady
  └─ if (embedProvider !== 'local') return    ← P3 bug:API 模式整个跳过
  └─ modelManager.download()
  └─ indexController.onLayoutReady()
       └─ IndexManager.onLayoutReady()
            └─ backend.fullReindex()           ← P2 bug:无条件全量
                 └─ listMarkdownFiles → 全部 embed → upsert
```

**改造后:**

```
onLayoutReady
  ├─ if (embedProvider === 'local') modelManager.download()  ← 只跳过模型下载,不跳过索引
  └─ indexController.onLayoutReady()                         ← 两条 provider 都走
       └─ IndexManager.onLayoutReady()
            └─ backend.smartReindex()                        ← 替换 fullReindex
```

### 5.2 smartReindex 时序

```
smartReindex 入口
  → VectraStore.init() + isIndexCreated()
  → 索引存在?
     ├─ 否 → 全量索引(首次/重置/损坏)
     └─ 是 → manifest.load()
            → manifest 存在且全局参数匹配?
               ├─ 否(参数变)→ 清 .index/ + manifest.invalidate() → 全量
               └─ 是 → listMarkdownFiles() + 读 content + mtime
                      → manifest.diff(files) → toAdd/toUpdate/toDelete/unchanged
                      → 有待处理项?
                         ├─ 否(热启动)→ status → Ready(零 embed)
                         └─ 是 → 批量处理 toAdd+toUpdate + 逐个 delete
                                → manifest.recordEntry / removeEntry → manifest.save()
                                → status → Ready + lastIndexTime 更新
```

### 5.3 五种启动场景

| 场景 | 索引存在 | manifest 状态 | 行为 | embed 调用数 | Ready 耗时 |
|---|---|---|---|---|---|
| 首次安装 | ❌ | 无 | 全量 | N(全部文件) | 慢(取决于库大小) |
| 热启动(无变更) | ✅ | 完整 | hash diff → 0 待处理 | 0 | **秒级**(纯 hash) |
| 单文件修改 | ✅ | 完整 | hash diff → 1 toUpdate | 1(只该文件) | 秒级 + 1 文件 embed |
| 模型/chunk 参数切换 | ✅ | 完整但参数不匹配 | 清索引 + 全量 | N | 慢 |
| manifest 损坏 | ✅ | JSON 解析失败 | 当作不存在 → 全量 | N | 慢(容错降级) |

### 5.4 diff 期间搜索可用性

**策略:diff 跑完才 Ready(保守方案)。**

理由:
- diff 是纯 hash 计算(读文件 + sha256),无 ONNX,大库也只需秒级
- diff 期间若允许搜索,可能命中:已被删除文件的幽灵 chunk / 已修改但未 re-embed 的过期向量
- 保守方案的代价仅是"秒级延迟搜索",可接受

`isSearchReady()` 现有逻辑不用改:diff 期间 status 非 Ready,搜索被拦;diff 完成 status → Ready,搜索可用。

### 5.5 批量处理策略(toAdd + toUpdate)

**不逐文件 embed,批量处理:**

```typescript
// 伪代码 — smartReindex 核心循环
const toEmbed: Array<{path, content}> = [...toAdd, ...toUpdate];
if (toEmbed.length > 0) {
  // 性能:一次性发全部待 embed 内容,IndexProcessor 内部 maxBatchSize=16 自动分批
  const response = await workerManager.request({
    type: 'index.batch',  // 新增消息类型
    payload: { files: toEmbed },
  });
  // 批量记录 manifest(用返回的 chunkCount)
  for (const file of toEmbed) {
    manifest.recordEntry(file.path, file.hash, file.mtime, response.chunkCounts[file.path]);
  }
}

// 逐个 delete(vectra cleanup 需按文件维度)
for (const path of toDelete) {
  await workerManager.request({ type: 'index.delete', payload: { filePath: path } });
  manifest.removeEntry(path);
}

manifest.save();
```

**为什么不复用 `index.full`:** `index.full` 把"读文件 + embed + upsert"耦合在一起,且不返回 chunkCount。smart reindex 需要:主线程先读文件算 hash(决定要不要 embed)→ 只把待 embed 文件发给 worker → 拿回 chunkCount 更新 manifest。所以新增 `index.batch` 消息类型。

### 5.6 状态机变化

`IndexManager` 当前状态:`Idle → Indexing → Ready`。改造后:

```
Idle → Diffing → (有工作) → Indexing → Ready
                → (无工作) → Ready
```

新增 `Diffing` 状态(用户感知:"正在检查变更"),避免 "Indexing" 误导用户以为在重算。状态条文案:
- `Diffing`: "正在检查 vault 变更..."
- `Indexing`: "正在索引 X/Y 个文件..."(X/Y 来自 toAdd+toUpdate 计数)

### 5.7 autoIndex 设置接线

当前 `settings.autoIndex`(默认 `true`)未 gate 索引消费。改造后:

| autoIndex | onLayoutReady 行为 |
|---|---|
| `true`(默认) | 走 smartReindex + 启动 FolderWatcher |
| `false` | 不启动自动索引,但 **保留** FolderWatcher(用户手动改文件仍增量)+ 保留手动 `/reindex` 命令 |

理由:`autoIndex=false` 的语义是"不要自动全量扫描",不是"完全不索引"。用户改文件时的增量仍该生效,否则索引永远过期。

`indexPaused` 暂不接线(无明确用例,留 0.2.x)。

## 6. 详细设计 — API 模式 watcher(P3)

### 6.1 解耦"模型下载"与"索引启动"

**改造点(`src/main.ts onLayoutReady`):**

```typescript
async onLayoutReady(): Promise<void> {
  // 模型下载:仅 local 模式需要
  if (this.settings.embedProvider === 'local') {
    await this.modelManager.download();
    // ... 重建 EmbeddingOnnx + 注入 worker(现有逻辑)
  }
  // api 模式:EmbeddingApi 已在 onload 装配,无需下载

  // 索引启动:两条 provider 都走(P3 修复)
  await this.indexController.onLayoutReady();
}
```

**改动量极小:** 把 early return 改成"只跳过模型下载分支",索引启动移到 if 块外。

### 6.2 FolderWatcher 统一启动

`IndexController.onLayoutReady()` 内部会启动 `FolderWatcher`(vault 事件监听)。改造后两条 provider 都进入这个方法:

| provider | onLayoutReady 行为 |
|---|---|
| `local` | 模型下载 → smartReindex → FolderWatcher 启动 |
| `api` | (无模型下载)→ smartReindex → FolderWatcher 启动 |

**API 模式首次跑 smartReindex 时**,因为之前从没建过索引(`isIndexCreated()` 返回 false),会走全量路径 —— 首次启动会花时间 embed 整个库。这是**正确行为**(API 模式从没索引过,首次必须全量)。之后热启动就走 hash diff。

### 6.3 API 模式的特殊错误处理

API 模式 embed 会发 HTTP,相比 local 模式多了网络失败风险:

| 错误 | 处理 |
|---|---|
| HTTP 401/403(API Key 错) | smartReindex 失败 → `status$.set(Failed)` + 诊断面板显示"嵌入 API 认证失败" |
| HTTP 429(限流) | 指数退避重试 3 次(复用 `EmbeddingApi` 现有重试逻辑,无需新增) |
| 网络超时 | 同上,复用现有重试 |
| 端点不可达(Ollama 没起) | smartReindex 失败 → `status$.set(Failed)` + 提示"嵌入服务不可达,检查 Ollama 是否运行" |

**关键:** smartReindex 失败时**不清 manifest**(保留旧 hash 表),下次启动重试。已成功 embed 的文件不重算(因为 manifest 已 recordEntry)。

### 6.4 设置切换时的行为

用户在设置面板切换 `embedProvider` 或 embedding 端点:

| 切换类型 | 即时行为 | 重启后行为 |
|---|---|---|
| local → api | 不即时重建(等重启) | smartReindex 检测 embedModelId 变 → 全量 |
| api → local | 不即时重建(等重启) | smartReindex 检测 embedModelId 变 → 全量(需先下载 ONNX 模型) |
| 同 provider 内换模型 | 不即时重建 | smartReindex 检测 embedModelId 变 → 全量 |
| 改 chunkSize | 不即时重建 | smartReindex 检测 chunkSize 变 → 全量 |

**不即时重建的理由:** 设置切换时索引可能在用(用户正在搜),即时清索引会中断。等重启走 smartReindex 是安全时机。设置面板可加一行提示:"更改此项需重启 Obsidian 生效"。

### 6.5 与 search_vault 的关系

`src/ui/chat/chat-send-gate.ts` 的 `isSearchReady()` 检查 `index === 'ready'`。改造后:

- API 模式首次启动:索引未建 → `isSearchReady()` false → `search_vault` 返回 `INDEX_NOT_READY`(现有行为,无需改)
- API 模式热启动:hash diff 秒级完成 → Ready → 搜索可用
- API 模式 smartReindex 失败:status `Failed` → `isSearchReady()` false → 搜索被拦(合理,索引坏了不该搜)

**搜索门控逻辑无需改动。**

## 7. 非目标补充:设置切换不即时重建

用户在设置面板改 `embedProvider` / embedding 端点 / chunkSize / chunkOverlap 时,**不即时触发重建**,等重启走 smartReindex。

理由:
- 设置切换时索引可能在用(用户正在搜),即时清索引会中断
- 即时重建需要中断 in-flight 的 smartReindex + 清索引 + 重新下载模型(local),复杂度高
- 等重启是安全时机,且 smartReindex 会自动检测参数变化

设置面板对应项加一行提示:"更改此项需重启 Obsidian 生效"。

## 8. 详细设计 — chunk 残留修复

### 8.1 问题

当前 `indexIncremental` 用 `${path}#chunk-${idx}` 作 vectra docId。若文件从 5 chunk 变成 3 chunk,upsert 只覆盖 `#chunk-0/1/2`,`#chunk-3/4` **残留**在索引里。搜索时会命中幽灵片段,返回已不存在的内容。

### 8.2 修复:reembed 前先 deleteByPath

在 `indexProcessor` 增量/批量处理一个文件前,**先删该文件的旧 chunk**:

```typescript
// src/worker/index-processor.ts — 批量处理前
async function reembedFile(filePath: string, content: string, store, embeddings) {
  // 关键路径:先删旧 chunk,防止文件变短时残留。
  await store.deleteByPath(filePath);
  const chunks = chunkMarkdown(content, chunkSize, chunkOverlap);
  const vectors = await embeddings.embed(chunks.map(c => c.text));
  chunks.forEach((chunk, idx) => {
    store.upsertItem({
      docId: `${filePath}#chunk-${idx}`,
      vector: vectors[idx],
      metadata: { path: filePath, chunkIndex: idx, ...chunk },
    });
  });
  return chunks.length;  // 返回 chunkCount 给 manifest
}
```

### 8.3 VectraStore 新增方法

```typescript
// src/adapters/vector-vectra.ts
/**
 * 删除指定文件路径下的所有 chunk。
 *
 * 关键路径:文件变短时,旧 chunk 残留会导致搜索命中幽灵片段。
 * 此方法在 reembed 前调用,确保旧 chunk 全部清除。
 *
 * @param filePath - 文件相对路径(如 "notes/foo.md")
 * @returns 删除的 chunk 数(用于诊断日志)
 */
async deleteByPath(filePath: string): Promise<number>;
```

### 8.4 manifest 与 chunk 残留的关系

- 修 manifest 之前:`chunkCount` 字段记录历史,可用于"删 `chunkCount..N` 旧 id" —— 但这依赖 chunk id 连续,不够稳健
- 修 `deleteByPath` 之后:**先全删再重插**,彻底解决残留,`chunkCount` 字段降级为诊断信息(诊断面板显示"该文件 X chunks")

**两个修复都做**,`deleteByPath` 是根治,`chunkCount` 是可观测性。

## 9. 错误处理矩阵

| 错误场景 | 处理 | manifest 行为 | 状态条 |
|---|---|---|---|
| manifest JSON 解析失败 | 当作不存在 → 全量 | 全量后重写 | `Indexing` → `Ready` |
| manifest 写盘失败(磁盘满) | 日志告警,不阻塞索引 | 内存中保留,下次启动重写 | `Ready`(索引本身成功) |
| `.index/` 目录损坏(vectra 加载失败) | 清 `.index/` + manifest → 全量 | 清空后重写 | `Indexing` → `Ready` |
| 单文件 embed 失败(ONNX 崩溃/API 错) | 跳过该文件,记入 errors,继续其他文件 | **不 recordEntry**(保留旧 hash) | `Ready` + 诊断面板显示失败文件 |
| 全部文件 embed 失败 | smartReindex 失败 | **不清 manifest**(保留旧 hash 表) | `Failed` + 错误信息 |
| sha256 计算失败(文件读错) | 跳过该文件,记入 errors | 不 recordEntry | `Ready` + 诊断面板 |
| `listMarkdownFiles` 失败(vault 异常) | smartReindex 失败 | 不清 manifest | `Failed` |
| Worker 无响应(超时) | smartReindex 失败 | 不清 manifest | `Failed` + "索引服务无响应" |

**核心原则:** 失败时**保守保留** manifest,让下次启动重试。绝不"失败就清空",那会让用户每次启动都全量。

### 9.1 原子写:manifest 写盘安全

```typescript
// src/core/index-manifest.ts
async save(): Promise<void> {
  const tmpPath = this.path + '.tmp';
  const data = JSON.stringify(this.data, null, 2);
  // 关键路径:先写临时文件,再 rename,避免半写状态导致 manifest 损坏。
  // rename 在同分区是原子操作。
  await fs.promises.writeFile(tmpPath, data, 'utf8');
  await fs.promises.rename(tmpPath, this.path);
}
```

Obsidian/Electron 环境 `fs.promises.rename` 在同目录下是原子的(同分区),可防半写。

## 10. 测试计划

### 10.1 单元测试(新文件)

**`tests/core/index-manifest.test.ts`:**

| 测试用例 | 验证点 |
|---|---|
| `load - 文件不存在 - 返回 null` | 首次启动路径 |
| `load - JSON 损坏 - 返回 null` | 容错降级 |
| `load - 正常文件 - 返回 manifest` | happy path |
| `diff - 全新文件 - 进 toAdd` | 首次索引后增量 |
| `diff - hash 未变 - 进 unchanged` | 热启动 0 embed |
| `diff - hash 变 - 进 toUpdate` | 文件修改 |
| `diff - mtime 变 hash 不变 - 进 unchanged` | mtime 不单独依赖 |
| `diff - manifest 有 vault 无 - 进 toDelete` | 文件删除 |
| `shouldFullRebuild - embedModelId 变 - 返回 true` | 模型切换 |
| `shouldFullRebuild - chunkSize 变 - 返回 true` | 参数切换 |
| `shouldFullRebuild - 全部不变 - 返回 false` | 热启动 |
| `save - 原子写 - 临时文件 rename 成功` | 写盘安全 |
| `save - 写盘失败 - 抛错不损坏原文件` | 容错 |

**`tests/adapters/vector-vectra.test.ts`(扩展):**

| 测试用例 | 验证点 |
|---|---|
| `deleteByPath - 删除指定文件所有 chunk` | chunk 残留修复 |
| `deleteByPath - 文件不存在 - 返回 0 不抛错` | 容错 |
| `deleteByPath - 删除后搜索不命中该文件` | 端到端验证 |

### 10.2 集成测试(新文件)

**`tests/integration/index-startup.test.ts`:**

| 测试场景 | 验证点 |
|---|---|
| 冷启动(空 .index)→ 全量 | 首次路径,manifest 写入 |
| 热启动(无变更)→ 0 embed 调用 | mock `embeddings.embed` 计数 |
| 单文件修改 → 仅该文件 embed | manifest hash 更新 |
| 文件删除 → vectra cleanup + manifest 移除 | 无幽灵 chunk |
| 模型切换 → 清 .index + 全量 | embedModelId 失效 |
| chunkSize 变更 → 全量 | 参数失效 |
| manifest 损坏 → 全量重建 | 容错降级 |
| API 模式启动 → 索引建立 | P3 修复 |
| API 模式热启动 → 0 embed | P3 + P2 叠加 |
| 文件变短(5→3 chunk)→ 无残留 | deleteByPath 修复 |

### 10.3 手动验证(Obsidian 内)

| 场景 | 预期 |
|---|---|
| 首次安装,500 笔记 | 索引完成,搜索可用 |
| 关闭 Obsidian 再开 | 状态条秒级 Ready(不等 embed) |
| 改一个笔记保存 | 状态条短暂 Indexing,仅该文件 |
| 删一个笔记 | 搜索不再命中该笔记 |
| 设置切 chunkSize 重启 | 全量重建,状态条显示 Indexing |
| API 模式(Ollama)启动 | 索引建立,搜索可用(P3 验证) |

## 11. 影响面

### 11.1 新增文件

- `src/core/index-manifest.ts` — IndexManifest 类
- `tests/core/index-manifest.test.ts` — 单测
- `tests/integration/index-startup.test.ts` — 集成测试

### 11.2 修改文件

| 文件 | 改动 |
|---|---|
| `src/main.ts` | onLayoutReady 解耦模型下载与索引启动;实例化 IndexManifest |
| `src/core/index-manager.ts` | onLayoutReady 调 smartReindex;新增 Diffing 状态 |
| `src/core/index-controller.ts` | smartReindex 编排:load manifest → diff → batch embed → recordEntry |
| `src/worker/index-processor.ts` | 新增 reembedFile(先 deleteByPath 再 embed);返回 chunkCount |
| `src/worker/handler.ts` | 新增 `index.batch` 消息处理(批量 embed 指定文件);`index.full` 保留(首次全量用) |
| `src/adapters/vector-vectra.ts` | 新增 deleteByPath 方法 |
| `tests/adapters/vector-vectra.test.ts` | deleteByPath 单测 |

**文档文件(ARCHITECTURE.md / vector-index.md / user-guide.md / ADR)不在 plan 内更新**,统一在 `finishing-a-development-branch` 阶段按 §12 清单执行。理由:AGENTS.md 文档同步规则明确"唯一触发点:finishing-a-development-branch 技能启动时",plan 阶段只改代码 + 测试。

### 11.3 不动文件

- `src/ports/persistence.ts` — NoteMeta 端口不动(manifest 独立)
- `src/ui/chat/chat-send-gate.ts` — 搜索门控逻辑复用 isSearchReady
- `src/tools/search-vault.ts` — INDEX_NOT_READY 行为不变
- `src/settings.ts` — autoIndex 接线逻辑在 index-manager,settings 接口不变

### 11.4 STATUS.md 登记

spec 合入后,在 `docs/superpowers/STATUS.md` 主表新增一行:

```
| S-INDEX-STARTUP | docs/superpowers/specs/2026-06-28-index-startup-smart-reindex-design.md | Active | 索引启动智能重算 — Smart Reindex + Manifest |
```

## 12. 文档同步评估

按 AGENTS.md 文档同步规则,本 spec 完成后(`finishing-a-development-branch` 启动时)需评估。

**自审发现:架构文档多处与当前代码已不一致,spec 落地后会进一步放大偏差。** 以下清单是 plan 完成后必须同步的详细项。

### 12.1 文档同步总表

| 文档 | 触发条件 | 是否需同步 |
|---|---|---|
| README | 无功能清单/安装/隐私变化 | ❌ 不需要 |
| user-guide | 状态条新增 `Diffing` 状态;FAQ 可能补"为什么启动快了" | ✅ 需同步(状态条解读 + FAQ) |
| CHANGELOG | feat(索引热启动)+ fix(API 模式不索引)+ fix(chunk 残留) | ✅ 标记下次发版覆盖 |
| ARCHITECTURE.md | §6.2/6.3/7.1/7.2/7.3 多处与实现不符(见 12.2) | ✅ 需同步(改前确认) |
| docs/architecture/rag/vector-index.md | §3.1 标题 + 新增 §3.4 + §4.1 状态机(见 12.3) | ✅ 需同步 |
| adr/ | 引入"manifest 独立文件 vs 复用 NoteMetaRepository"决策 | ✅ 新增 ADR |

### 12.2 ARCHITECTURE.md 详细更新清单

| 章节 | 当前内容(与实现不符) | spec 落地后应为 | 冲突类型 |
|---|---|---|---|
| §6.2 增量索引流程 | `onFileModify → sha256 → hash 未变则跳过` | 启动 smartReindex 用 sha256 diff;运行时 modify 事件走 FolderWatcher(无 sha256,事件本身即变更信号) | 文档描述的功能当前未实现,spec 后只在启动路径实现 |
| §6.3 首扫索引流程 | `index.full → 每个文件 sha256 → index.incremental` | §6.3 保留为首扫/重置流程(`index.full`,无 sha256);新增 §6.4 smart reindex(启动 hash diff) | 文档把"首扫"等同于"启动全量",spec 后启动不再无条件全量 |
| §7.1 三层存储 | FS / JSON / vectra | FS / JSON / **manifest** / vectra 四层(manifest 独立文件,不走 data.json) | 新增存储层 |
| §7.2 存储架构图 | 画了 data.json + index/ | 加 `index-manifest.json` 节点(与 data.json 同级,与 index/ 同级) | 新增节点 |
| §7.3 Content-Hash 双键策略 | "path + content hash 双键 → 100% 幂等" | 修订为"manifest hash diff 策略":manifest 记 hash 用于启动 diff,非"双键"概念 | 概念修订 |

### 12.3 vector-index.md 详细更新清单

| 章节 | 当前内容 | spec 落地后应为 | 冲突类型 |
|---|---|---|---|
| §3.1 标题 | "全量索引(首次打开 vault)" | "全量索引(首次 / 重置 / 参数切换)" | 标题不准 |
| §3.1 序列图 | `onLayoutReady → enqueue(所有文件) → index.full` | 保留为"首次全量"路径;新增 §3.4 smart reindex(热启动 hash diff) | 缺热启动路径 |
| 新增 §3.4 | 无 | smart reindex 序列图:`onLayoutReady → manifest.load → diff → toAdd/toUpdate/toDelete → index.batch` | 新增章节 |
| §4.1 状态机 | 9 态:`Idle → Init → Scanning → Queueing → Processing → Ready` | 加 `Diffing` 状态:`Idle → Diffing → (有工作) → Indexing → Ready / (无工作) → Ready` | 新增状态 |

### 12.4 ADR 新增

新增 ADR 记录"manifest 独立文件 vs 复用 NoteMetaRepository"决策:

- **决策:** 独立文件 `pluginDir/index-manifest.json`
- **理由:** data.json 与会话历史混存,每次写 manifest 全量序列化 data.json,大库读写慢;manifest 是索引专用,与 `.index/` 同生命周期
- **推翻:** 无(此前无相关 ADR)
- **引入硬约束:** manifest 与 `.index/` 必须同生命周期(模型切换/重置时一起清)

### 12.5 执行时机

按 AGENTS.md,以上所有文档同步在 `finishing-a-development-branch` 启动时执行,**不在 plan 执行阶段做**(plan 阶段只改代码 + 测试)。§11.2 已明确排除文档文件。

## 13. 参考与查证

- `.temp/2026-06-28-index-startup-reindex-handoff.md` — 交接文档(代码证据 + 根因分析)
- `src/ports/persistence.ts:82` — NoteMeta 接口注释"hash 用来判断文件内容是否变更"
- `src/utils/hash.ts:21` — sha256 已实现
- `src/adapters/vector-vectra.ts:70` — isIndexCreated 已用
- ADR-006 — local embedding 产物内联(P1 已落地)

## 14. 验证标准

Plan 执行完成后,需满足:

- [ ] `tests/core/index-manifest.test.ts` 13 条单测全部通过
- [ ] `tests/adapters/vector-vectra.test.ts` deleteByPath 3 条单测通过
- [ ] `tests/integration/index-startup.test.ts` 10 条集成测试通过
- [ ] 热启动(无变更)时 `embeddings.embed` 调用计数为 0(mock 验证)
- [ ] API 模式启动后索引建立,搜索可用(P3 验证)
- [ ] 文件变短(5→3 chunk)后搜索不命中幽灵片段
- [ ] manifest 损坏时降级全量,不抛错
- [ ] 模型切换时清 `.index/` + 全量重建
- [ ] `autoIndex=false` 时仍启动 FolderWatcher(手动改文件增量)
- [ ] git commit 遵循 Conventional Commits

**文档同步验证(finish 阶段检查,非 plan 验证项):**

- [ ] ARCHITECTURE.md §6.2/6.3/7.1/7.2/7.3 按 §12.2 更新
- [ ] vector-index.md §3.1/3.4/4.1 按 §12.3 更新
- [ ] user-guide.md 状态条解读加 `Diffing` 状态 + FAQ
- [ ] 新增 ADR(manifest 独立文件决策)
- [ ] CHANGELOG `[Unreleased]` 补 feat/fix 条目
