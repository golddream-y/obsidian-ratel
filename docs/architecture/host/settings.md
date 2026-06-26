# 设置系统

> 领域:Host | 用户可配置项、设置面板、配置热重载

---

## 1. 职责

定义 Ratel Vault 的全部用户可配置项,渲染 Obsidian 设置面板,并在配置变更时触发热重载(重建 LLM / Embedding 适配器)。

**不做的事**:
- 不负责持久化读写(属于 [persistence](persistence.md),通过 `plugin.saveSettings()` 调用)
- 不负责 LLM / Embedding 适配器构造(属于 [llm/model-management](../llm/model-management.md),通过 `plugin.rebuildLLM()` / `plugin.rebuildEmbeddingAdapter()` 触发)

---

## 2. 设计原则

### 2.1 零配置可用

**决策**:默认配置开箱即用,本地 Embedding + DeepSeek 端点占位。

**原因**:
- 本地 Embedding(`Xenova/bge-small-zh-v1.5`,~90MB)无需 API Key
- `embedApiBase` 默认 `http://localhost:11434/v1` 适配本地 Ollama
- 用户只需填 Chat API Key 即可跑通端到端检索

### 2.2 立即写盘

**决策**:`onChange` 回调立即调 `saveSettings()`,无"保存"按钮。

**原因**:
- Obsidian Setting 组件原生支持 `onChange` 异步回调
- 避免用户忘记点保存导致配置丢失
- 配置变更频率低,写盘开销可忽略

### 2.3 配置热重载

**决策**:涉及适配器构造的配置变更,立即重建对应适配器。

**原因**:
- LLM 的 `Authorization` header、`apiBase` 在构造时定型,改配置后必须重建
- Embedding 的 `provider` 切换会换实现类(local / api 是不同类),必须重建
- 重建是幂等的:旧实例被丢弃,新实例按新配置构造

### 2.4 API Key 走 SecretStorage

**决策**:所有 API Key(Chat / Embedding API / Reranker)存储在 Obsidian 1.11.4+ SecretStorage 中,**不**出现在 `data.json` 或设置面板输入框。

**原因**:
- `data.json` 是明文 JSON,API Key 明文存储有泄露风险
- SecretStorage 由操作系统级加密保管(macOS Keychain / Windows Credential Manager)
- 插件不提供 Key 输入框 — 用户需在 Obsidian 设置 → Keychain 中用固定 secret ID 手动添加
- Key 值或前缀**不**在 UI、设置、诊断页面中暴露
- 本地 Ollama 端点(`localhost` / `127.0.0.1`)不需要 API Key
- Reranker 在密钥未配置时自动关闭(不报错,降级为不 rerank)

---

## 3. 配置项分组

```mermaid
graph TB
    subgraph "RatelVaultSettings"
        CHAT["Chat<br/>chatModel / chatApiBase<br/>(Key 在 SecretStorage)"]
        EMB["Embedding<br/>embedProvider: 'local' | 'api'<br/>local: embedLocalModel / embedLocalDimensions<br/>api: embedApiBase / embedApiModel /<br/>embedApiDimensions<br/>(Key 在 SecretStorage)"]
        RER["Reranker(可选)<br/>rerankerProvider / rerankerApiBase /<br/>rerankerModel<br/>(Key 在 SecretStorage,未配置则自动关闭)"]
        IDX["Indexing<br/>chunkSize / chunkOverlap / autoIndex /<br/>indexPaused / embedModelActive /<br/>embedAvailableModels / embedDownloadedModels"]
        LINK["Link Suggestions<br/>autoSuggestLinks / linkConfidenceThreshold"]
        TOOLS["Tools & Security<br/>toolPermissions / trustMode"]
        PROMPTS["Prompts<br/>promptOverrides"]
    end
```

### 3.1 Chat

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `chatModel` | string | `deepseek-chat` | 模型标识 |
| `chatApiBase` | string | `https://api.deepseek.com` | API base URL |

**API Key**:存储在 SecretStorage,固定 secret ID `ratel-chat-key`。用户在 Obsidian 设置 → Keychain 手动添加。本地 Ollama 端点不需要。详见 [secrets](../agent/secrets.md)。

**热重载**:`chatModel` / `chatApiBase` 任一变更都调 `plugin.rebuildLLM()`。Key 变更由 `secrets` 模块通知重建。

### 3.2 Embedding

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `embedProvider` | `'local' \| 'api'` | `'local'` | Provider 切换 |
| `embedLocalModel` | string | `Xenova/bge-small-zh-v1.5` | 本地 ONNX 模型 id |
| `embedLocalDimensions` | number | `512` | 本地模型向量维度 |
| `embedApiBase` | string | `http://localhost:11434/v1` | API base URL(Ollama 默认) |
| `embedApiModel` | string | `bge-m3` | API 模型标识 |
| `embedApiDimensions` | number | `1024` | API 模型向量维度 |

**API Key**:存储在 SecretStorage,固定 secret ID `ratel-embed-key`。本地 Ollama 端点不需要。详见 [secrets](../agent/secrets.md)。

**热重载**:任一字段变更调 `plugin.rebuildEmbeddingAdapter()`。Provider 切换还会触发 `this.display()` 整体重渲染,显示对应字段组。

### 3.3 Reranker(可选)

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `rerankerProvider` | `'bailian' \| 'custom'` | `'bailian'` | Provider(阿里百炼 / 自定义 OpenAI 兼容) |
| `rerankerApiBase` | string | 百炼默认 base | API base URL |
| `rerankerModel` | string | 百炼默认 rerank 模型 | 模型标识 |

**API Key**:存储在 SecretStorage,固定 secret ID `ratel-rerank-bailian`。未配置密钥时 Rerank 自动关闭(不报错,降级为不 rerank)。配置项标注 `note: '未配置密钥时 Rerank 自动关闭。'`。详见 [secrets](../agent/secrets.md)。

**Provider 切换自动填 base**:切到 `bailian` 时自动填入官方默认 base,降低用户输入成本。`custom` 不填,用户自填。

### 3.4 Indexing

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `chunkSize` | number | `500` | 分块大小(tokens),滑块 100-1000 |
| `chunkOverlap` | number | `100` | 分块重叠(tokens),滑块 0-200 |
| `autoIndex` | boolean | `true` | 文件变更时自动重索引 |
| `indexPaused` | boolean | `false` | 索引暂停开关,用户在设置面板切换 |
| `embedModelActive` | string | `Xenova/bge-small-zh-v1.5` | 当前激活的本地 Embedding 模型 id |
| `embedAvailableModels` | Array | 5 个候选 | 可下载的模型列表(尺寸/维度/推荐位) |
| `embedDownloadedModels` | string[] | `[]` | 已下载到本地的模型 id |

**`embedAvailableModels` 默认列表**:

| id | sizeBytes | dimensions | recommended |
|---|---|---|---|
| `Xenova/bge-small-zh-v1.5` | ~90MB | 512 | ✅ |
| `Xenova/bge-base-zh-v1.5` | ~210MB | 768 | |
| `Xenova/bge-large-zh-v1.5` | ~650MB | 1024 | |
| `BAAI/bge-m3` | ~600MB | 1024 | |
| `Xenova/all-MiniLM-L6-v2` | ~25MB | 384 | |

### 3.5 Link Suggestions

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `autoSuggestLinks` | boolean | `true` | 写笔记后是否自动建议链接 |
| `linkConfidenceThreshold` | number | `0.75` | 最小相似度阈值,滑块 0.5-1.0 |

### 3.6 Tools & Security

工具权限门控与信任模式,详见 [hooks §8 安全设计](../agent/hooks.md#8-安全设计三层防御)。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `toolPermissions` | `Record<string, 'allow' \| 'ask' \| 'deny'>` | 见下 | 每个工具的权限级别 |
| `trustMode` | boolean | `false` | 信任模式,开启时所有工具自动放行不询问 |

**`toolPermissions` 默认值**(安全优先):

| 工具 | 默认权限 | 说明 |
|---|---|---|
| `read_note` / `search_vault` / `grep` / `glob` / `list_files` | `allow` | 只读工具默认放行 |
| `write_note` / `append_note` / `edit_note` / `delete_note` | `ask` | 写工具默认每次询问 |

**trustMode 说明**:
- `false`(默认):写工具每次执行前弹窗询问用户
- `true`:跳过 `ask` 级别,所有工具按 `allow` 处理(适合信任 LLM 输出的高级用户)
- `deny` 级别**始终生效**,不受 trustMode 影响

**热重载**:无 rebuild,Agent Loop 运行时实时读取。

### 3.7 Prompts

提示词 section 覆盖,详见 [prompt-management](../agent/prompt-management.md)。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `promptOverrides` | `Partial<Record<SectionId, string>>` | `{}` | 用户自定义 section 文本,覆盖 `defaults/zh.ts` |

**约束**:
- 检索外框(`retrieval-frame`)section 标记 `allowOverride: false`,不可覆盖
- 覆盖文本在 Composer 拼接时替换对应 section,不影响其他 section
- 设置面板提供文本编辑器,用户可编辑每个可覆盖 section

**热重载**:无 rebuild,Composer 在下次 LLM 调用时重新拼接。

---

## 4. 设置面板渲染

`RatelVaultSettingTab extends PluginSettingTab`,渲染逻辑在 `display()`:

```mermaid
flowchart TB
    START["display() 被调"] --> EMPTY["containerEl.empty()"]
    EMPTY --> CHAT["渲染 Chat 组(无 Key 输入框,显示 SecretStorage 提示)"]
    CHAT --> EMB["渲染 Embedding 组"]
    EMB --> CHECK{"embedProvider?"}
    CHECK -->|"local"| LOCAL["显示 embedLocalModel 字段"]
    CHECK -->|"api"| API["显示 embedApiBase / model 字段(无 Key 输入框)"]
    LOCAL --> RER
    API --> RER["渲染 Reranker 组(无 Key 输入框,显示密钥提示)"]
    RER --> IDX["渲染 Indexing 组"]
    IDX --> LINK["渲染 Link Suggestions 组"]
    LINK --> TOOLS["渲染 Tools & Security 组"]
    TOOLS --> PROMPTS["渲染 Prompts 组"]
```

**关键路径**:Provider 切换时 `onChange` 内调 `this.display()` 整体重渲染,保证 local / api 字段组互斥显示。API Key 输入框已移除,改为 SecretStorage 提示文本(指引到 Obsidian 设置 → Keychain)。

---

## 5. 配置热重载链路

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant ST as SettingTab
    participant P as Plugin
    participant LLM as LLM 适配器
    participant EMB as Embedding 适配器

    U->>ST: 修改 chatApiKey
    ST->>P: saveSettings()
    ST->>P: rebuildLLM()
    P->>LLM: 丢弃旧实例,new DeepSeekLLM(newConfig)
    LLM-->>P: 新实例就绪

    U->>ST: 切换 embedProvider local→api
    ST->>P: saveSettings()
    ST->>P: rebuildEmbeddingAdapter()
    P->>EMB: 丢弃旧实例,new EmbeddingAPI(newConfig)
    EMB-->>P: 新实例就绪
    ST->>ST: this.display() 重渲染
```

**哪些字段触发重建**:

| 字段组 | 触发 rebuild |
|---|---|
| Chat(`chatModel` / `chatApiBase`) | `rebuildLLM()` |
| Chat API Key(SecretStorage) | `rebuildLLM()`(由 secrets 模块通知) |
| Embedding 所有字段 | `rebuildEmbeddingAdapter()` |
| Embedding API Key(SecretStorage) | `rebuildEmbeddingAdapter()`(由 secrets 模块通知) |
| Reranker 字段 | 无 rebuild(运行时读 settings) |
| Reranker API Key(SecretStorage) | 无 rebuild(运行时读 secrets,未配置则自动关闭) |
| Indexing 字段 | 无 rebuild(Worker 启动时读) |
| Link Suggestions | 无 rebuild(运行时读) |
| Tools & Security | 无 rebuild(Agent Loop 运行时读) |
| Prompts | 无 rebuild(Composer 下次调用时重新拼接) |

---

## 6. 边界

| 与...的接口 | 方向 | 说明 |
|---|---|---|
| [persistence](persistence.md) | 依赖 | `plugin.saveSettings()` 写入 data.json 设置层 |
| [llm/model-management](../llm/model-management.md) | 触发 | `rebuildLLM()` / `rebuildEmbeddingAdapter()` |
| [obsidian-integration](obsidian-integration.md) | 依赖 | `PluginSettingTab` 注册到 Obsidian |

---

## 7. 演进路径

| 阶段 | 能力 | 状态 |
|---|---|---|
| 当前 | 7 组配置(Chat/Embedding/Reranker/Indexing/Link/Tools&Security/Prompts)+ 热重载 + 立即写盘 + SecretStorage | ✅ 已实现 |
| 后续 | 配置版本号 + 迁移函数 | 待实现(与 persistence 协同) |
| 远期 | 配置导入导出 + 多 profile | 远期 |
