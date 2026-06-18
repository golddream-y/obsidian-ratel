# 持久化

> 领域:Host | 设置存储、索引目录、数据迁移

---

## 1. 职责

管理 Ratel Vault 的所有持久化数据:设置、会话、索引、模型缓存。确保数据安全、可迁移、可恢复。

**不做的事**:
- 不负责 Obsidian API 封装(属于 [obsidian-integration](obsidian-integration.md))
- 不负责索引逻辑(属于 [rag/vector-index](../rag/vector-index.md))
- 不负责模型下载(属于 [llm/model-management](../llm/model-management.md))

---

## 2. 设计原则

### 2.1 数据不出 vault

**决策**:所有持久化数据存于 `.obsidian/plugins/ratel-vault/` 内。

**原因**:
- 随 vault 移动(用户拷贝 vault 时数据跟着走)
- 不污染 vault 根目录
- 符合 Obsidian 插件规范

### 2.2 Obsidian loadData/saveData 为主

**决策**:设置和会话用 `plugin.loadData()` / `plugin.saveData()` 存入 `data.json`。

**原因**:
- Obsidian 官方推荐的持久化方式
- 自动处理路径和权限
- 跨平台兼容

### 2.3 索引数据用文件系统

**决策**:向量索引(vectra)直接用 Node.js `fs` 读写 `.obsidian/plugins/ratel-vault/index/`。

**原因**:
- vectra 的 `LocalDocumentIndex` 自己管理文件结构
- 数据量大(数百 MB),不适合塞进 `data.json`
- Worker 线程可直接访问文件系统

---

## 3. 目录结构

```
.obsidian/plugins/ratel-vault/
├── main.js                    ← 插件主入口
├── worker.js                  ← Worker 入口
├── manifest.json              ← 插件元数据
├── styles.css                 ← 样式(可选)
├── data.json                  ← 设置 + 会话 + 笔记元数据 + Hook 日志
├── .gitignore                 ← 自动生成(排除索引/缓存)
└── index/                     ← vectra 向量索引
    ├── index.json             ← 文档元数据
    └── items/                 ← 向量 + 文本
        ├── doc1.json
        └── ...
```

**关键**:`data.json` 内部由 `PersistenceJson` 管理三个仓库:`sessions` / `notes` / `hookLog`,共存于同一 JSON 文件。会话不单独存文件。

**模型缓存**(不在插件目录):

```
~/.cache/huggingface/hub/
└── models--Xenova--bge-small-zh-v1.5/
    └── snapshots/<hash>/
        ├── config.json
        ├── tokenizer.json
        └── model.onnx
```

---

## 4. data.json 结构

`data.json` 由两层共存:

1. **设置层** — `main.ts:loadSettings` 用 `Object.assign(DEFAULT_SETTINGS, raw)` 浅合并,顶层键即 `RatelVaultSettings` 字段。
2. **仓库层** — `PersistenceJson` 管理的 `sessions` / `notes` / `hookLog` 三个键,与设置层共存于同一文件。

```mermaid
graph TB
    subgraph "data.json 顶层"
        CHAT["Chat<br/>chatModel / chatApiKey / chatApiBase"]
        EMB["Embedding<br/>embedProvider / embedLocalModel /<br/>embedLocalDimensions / embedApiBase /<br/>embedApiKey / embedApiModel / embedApiDimensions"]
        RER["Reranker(可选)<br/>rerankerProvider / rerankerApiBase /<br/>rerankerApiKey / rerankerModel"]
        IDX["Indexing<br/>chunkSize / chunkOverlap / autoIndex /<br/>indexPaused / embedModelActive /<br/>embedAvailableModels / embedDownloadedModels"]
        LINK["Link Suggestions<br/>autoSuggestLinks / linkConfidenceThreshold"]
        REPO["仓库层(PersistenceJson)<br/>sessions: Record<br/>notes: Record<br/>hookLog: HookLogEntry[]"]
    end
```

---

## 5. .gitignore 管理

**自动生成**:插件 `onload` 时调用 `ensurePluginGitignore()`,幂等写入:

```gitignore
# Ratel Vault
.index/
cache/
```

**原则**:
- 索引(`.index/`)和模型缓存(`cache/`)是派生数据,可重建,不应 git 跟踪
- 设置(`data.json`)应跟踪(包含用户配置)
- 幂等:已有行不重复添加,保留用户已写的其他行

---

## 6. 数据迁移

**当前策略**:`main.ts:loadSettings` 用 `Object.assign(DEFAULT_SETTINGS, raw)` 浅合并。无版本号、无正式迁移框架。

```mermaid
flowchart TB
    START["插件加载"] --> LOAD["loadData()"]
    LOAD --> CHECK{"raw 为空?"}
    CHECK -->|"是"| DEFAULT["使用 DEFAULT_SETTINGS"]
    CHECK -->|"否"| MERGE["Object.assign(DEFAULT_SETTINGS, raw)"]
    DEFAULT --> SAVE["saveData(合并后)"]
    MERGE --> SAVE
    SAVE --> READY["设置就绪"]
```

| 迁移场景 | 处理 |
|---|---|
| 首次安装 | `raw` 为空,写入 `DEFAULT_SETTINGS` |
| 新增字段 | 浅合并自动补默认值,保留旧值 |
| 字段重命名 | 旧字段保留在对象上但不参与逻辑(无迁移) |
| 字段删除 | 旧字段保留在对象上(无清理) |
| 索引格式变化 | 无自动检测,需用户手动重建 |

**已知限制**:无版本号追踪,无法区分"需要迁移"与"已是最新"。远期计划引入版本号 + 正式迁移函数。

---

## 7. 边界

| 与...的接口 | 方向 | 说明 |
|---|---|---|
| [obsidian-integration](obsidian-integration.md) | 依赖 | loadData / saveData |
| [rag/vector-index](../rag/vector-index.md) | 提供 | 索引目录 + .gitignore |
| [llm/model-management](../llm/model-management.md) | 提供 | 模型缓存路径 |
| [agent/chat](../agent/chat.md) | 提供 | 会话存储路径 |

---

## 8. 演进路径

| 阶段 | 能力 | 状态 |
|---|---|---|
| 当前 | data.json + 索引目录 + .gitignore + 浅合并迁移 | ✅ 已实现 |
| 后续 | 版本号 + 正式迁移函数 | 待实现 |
| 远期 | 增量备份 + 索引校验 | 远期 |
