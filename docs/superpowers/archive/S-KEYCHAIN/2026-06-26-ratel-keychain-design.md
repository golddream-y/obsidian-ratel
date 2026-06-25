# S-KEYCHAIN — Obsidian 钥匙串 API Key 存储设计

> **状态:** Active
> **创建日期:** 2026-06-26
> **作者:** brainstorming (与用户协作)
> **关联:** S-FEEDBACK(Chat 硬拦/软拦)、S-DIAG(诊断页 Key 状态展示)
> **优先级:** High

---

## 背景

Ratel 当前将 `chatApiKey`、`embedApiKey`、`rerankerApiKey` 以**明文**写入插件 `data.json`。Obsidian 自 **1.11.4** 起提供 **SecretStorage / 钥匙串** API,可将敏感信息存放在库级本地缓存,不随 vault 同步。

用户诉求:

1. 首发即采用钥匙串,**不做明文 Key 字段、不做老用户迁移**(项目尚未发布)
2. 密钥名由**插件定义**,用户按提示在 Obsidian **设置 → 钥匙串**中创建,不自定义名称
3. 不同子系统 / 端点类型的 Key **可以不同**;**本地内置模型与本地 Ollama 不需要 Key**
4. DeepSeek 等厂商归入 **OpenAI 兼容**一类,不单独拆密钥名

## 目标

### 目标一:三类端点认证模型

| 端点类型 | 说明 | 是否需要钥匙串 |
|----------|------|----------------|
| `builtin` | Embedding 本地 ONNX 内置模型 | ❌ |
| `ollama-local` | Chat / Embed API 指向 `localhost` / `127.0.0.1` 的 Ollama | ❌ (v1);类型单独保留供后续扩展 |
| `openai-compatible` | OpenAI 兼容 HTTP API(含 DeepSeek、硅基流动 Chat/Embed 等) | ✅ |
| `rerank-bailian` | 阿里云百炼 DashScope Rerank | ✅ (可选,无 Key 即关闭) |

### 目标二:固定密钥名 + 动态设置提示

- 插件内常量表定义全部 `ratel-*` 密钥名
- 设置页根据**当前配置**只展示**一个**相关密钥名(或「无需 API Key」)
- `data.json` **不存储**任何 Key 值或密钥名引用

### 目标三:集中解析模块

- 新建 `src/secrets/ratel-secrets.ts`
- 所有读取 `app.secretStorage.getSecret` 的逻辑集中于此
- `main.ts`、门禁、诊断页、FeedbackController 通过解析函数获取 Key 或「是否需要 Key」

## 非目标

- 不做 `data.json` 明文 → 钥匙串迁移(无老用户)
- 不在插件设置内保留「直接输入 API Key」文本框
- 不使用 `SecretComponent` 让用户自选密钥名(v1 仅说明文案 + 状态)
- 不实现钥匙串跨设备同步(Obsidian 官方不支持)
- v1 不为远端 Ollama 强制要求 Key(`ollama-local` 类型预留给后续差异化处理)
- v1 Rerank **仅支持百炼**,不实现 Cohere / Jina / SiliconFlow 等多厂商

---

## 详细设计

### 架构

```
Obsidian 钥匙串 (用户按插件规定的名字录入)
        │
        ▼
app.secretStorage.getSecret(RATEL_SECRET_IDS.*)
        │
        ▼
src/secrets/ratel-secrets.ts
  ├─ classify*Endpoint(settings) → EndpointAuthKind
  ├─ getRequiredSecretId(kind, sub?) → string | null
  ├─ resolve*ApiKey(app, settings) → string | null
  └─ has*ApiKey(app, settings) → boolean
        │
        ├─► main.ts rebuildLLM / rebuildEmbeddingAdapter
        ├─► chat-send-gate (硬拦: 需要 Key 但未配置)
        ├─► FeedbackController (缺 Key 状态)
        └─► 诊断页 (已配置 / 未配置, 不泄露 Key 前缀)
```

### 固定密钥名常量

```typescript
export const RATEL_SECRET_IDS = {
	/** Chat — OpenAI 兼容端点 (DeepSeek / OpenAI / 硅基流动 Chat 等) */
	chatOpenAICompatible: 'ratel-chat-openai-compatible',
	/** Chat — 远端 Ollama (v1 预留,暂不强制读取) */
	chatOllama: 'ratel-chat-ollama',
	/** Embedding API — OpenAI 兼容远端 */
	embedOpenAICompatible: 'ratel-embed-openai-compatible',
	/** Embedding API — 远端 Ollama (v1 预留) */
	embedOllama: 'ratel-embed-ollama',
	/** Rerank — 阿里云百炼 DashScope */
	rerankBailian: 'ratel-rerank-bailian',
} as const;
```

### 端点分类规则

#### Chat (`chatApiBase`)

| 条件 | 类型 | 读取密钥 |
|------|------|----------|
| `isLocalHost(chatApiBase)` | `ollama-local` | 无 (v1) |
| 其他 | `openai-compatible` | `ratel-chat-openai-compatible` |

`isLocalHost`: hostname 为 `localhost` 或 `127.0.0.1`(解析 URL,缺协议时补 `http://`)。

#### Embedding

| 条件 | 类型 | 读取密钥 |
|------|------|----------|
| `embedProvider === 'local'` | `builtin` | 无 |
| `embedProvider === 'api'` 且 `isLocalHost(embedApiBase)` | `ollama-local` | 无 (v1) |
| `embedProvider === 'api'` 且远端 | `openai-compatible` | `ratel-embed-openai-compatible` |

#### Reranker (百炼 only)

v1 仅支持**阿里云百炼**文本重排序;设置区去掉多 Provider 下拉,固定:

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `rerankerApiBase` | `https://dashscope.aliyuncs.com/compatible-api/v1` | 走 OpenAI 兼容 `/reranks` 路径,适配 `qwen3-rerank` |
| `rerankerModel` | `qwen3-rerank` | 百炼推荐文本排序模型 |

钥匙串:

| 条件 | 密钥名 | 行为 |
|------|--------|------|
| 始终 (Rerank 段) | `ratel-rerank-bailian` | 无 Key → 关闭 Rerank;有 Key → 启用 `RerankerApi`(百炼适配在 P-W4 / 同期实现) |

> **说明:** 百炼另有原生端点 `.../api/v1/services/rerank/text-rerank/text-rerank`,请求体含 `input` 包装,与 compatible-api 不互通。v1 默认采用 **compatible-api** 扁平格式,与现有 `RerankerApi` 适配器形状一致;后续若支持 `qwen3-vl-rerank` 再扩展端点切换。

### 设置结构变更

从 `RatelVaultSettings` **删除**:

- `chatApiKey`
- `embedApiKey`
- `rerankerApiKey`
- `rerankerProvider` (v1 仅百炼,无需 Provider 枚举)

**Rerank 默认值同步调整** (`DEFAULT_SETTINGS`):

```typescript
rerankerApiBase: 'https://dashscope.aliyuncs.com/compatible-api/v1',
rerankerModel: 'qwen3-rerank',
```

`manifest.json`:

- `minAppVersion` → **`1.11.4`**

### 设置页 UI

移除三处 `addText` 密码框,改为 **`renderSecretHint`** 辅助块(可放在 `src/ui/secret-hint.ts` 或 `settings.ts` 私有方法):

**需要 Key 时示例 (Chat OpenAI 兼容):**

```
API 密钥
请在 Obsidian「设置 → 钥匙串」中添加以下名称的密钥(名称必须完全一致):
  ratel-chat-openai-compatible  [复制]
状态: ✅ 已配置 / ⚠️ 未配置
说明: 密钥保存在 Obsidian 钥匙串,不会写入插件配置,也不会随库同步到其他设备。
```

**无需 Key 时示例 (Embedding 内置):**

```
API 密钥
当前为内置本地 Embedding 模型,无需配置 API Key。
```

**规则:**

- 仅当 `getRequiredSecretId(...) !== null` 时显示密钥名与状态
- 状态通过 `has*ApiKey(app, settings)` 刷新;`display()` 重入时更新
- **禁止**在 UI 中展示 Key 内容或前缀(诊断页同理)

### 运行时读取

`main.ts` 在 `rebuildLLM` / `rebuildEmbeddingAdapter` 时:

```typescript
const apiKey = resolveChatApiKey(this.app, this.settings) ?? '';
// 传给 DeepSeekLLM / EmbeddingApi — 空字符串时 adapter 行为与现有一致
```

不在 `settings` 对象上缓存解析结果;每次 rebuild 重新 `getSecret`(Obsidian 侧为同步读取)。

### Chat 发送门禁修正

当前 `chat-send-gate` 对空 `chatApiKey` 一律硬拦,与本地 Ollama 场景矛盾。改为:

```typescript
if (requiresChatApiKey(settings) && !hasChatApiKey(app, settings)) {
	return { canSend: false, hardBlockReason: '请先在 Obsidian 钥匙串配置 Chat API 密钥' };
}
```

`requiresChatApiKey`: Chat 端点类型为 `openai-compatible` 时返回 `true`。

`evaluateChatSendGate` 签名增加 `app: App` 参数(或调用方传入 `hasKey: boolean` 预计算值,由 `ChatView` 从 `ratel-secrets` 解析)。

硬拦文案引导用户去**钥匙串**,不再说「设置中配置」。

### FeedbackController

`getSettings` 依赖类型去掉 `chatApiKey` / `embedApiKey`;缺 Key 检测改为:

- Chat: `requiresChatApiKey && !hasChatApiKey`
- Embed API 远端: `requiresEmbedApiKey && !hasEmbedApiKey`

### 诊断页

- `llm-test.ts` / `embedding-test.ts` / `rerank-placeholder.ts` 改为调用 `has*ApiKey`,展示「已配置 / 未配置 / 无需 Key」
- 删除 `chatApiKey.slice(0, 6)` 等泄露片段

### 依赖方向

- `src/secrets/*` 仅依赖 `obsidian.App` + `settings` 类型(接口抽取最小字段,避免 import `main`)
- `secrets` 模块 **禁止** import `user-feedback` / adapters
- adapters 继续接收 `apiKey: string`,不感知钥匙串

### 错误处理

| 场景 | 行为 |
|------|------|
| Obsidian &lt; 1.11.4 | `minAppVersion` 阻止安装;若 API 缺失则 `devLogger.error` + 设置页提示升级 |
| `getSecret` 返回 `null` | 视为未配置;adapter 收到 `''` |
| 远端 Embed 无 Key | Embedding 请求失败;`UserStatus.embedding` 反映错误态;诊断页可测 |
| Rerank 无 Key | 等同关闭,与现网一致 |

---

## 文件影响面

| 路径 | 操作 |
|------|------|
| `src/secrets/ratel-secrets.ts` | 新建 |
| `src/ui/secret-hint.ts` | 新建(可选,设置页密钥说明块) |
| `src/settings.ts` | 删 Key 字段;密码框 → 说明块 |
| `src/main.ts` | rebuild 时 resolve Key |
| `src/ui/chat-send-gate.ts` | 硬拦逻辑 + 签名 |
| `src/core/feedback-controller.ts` | 缺 Key 检测 |
| `src/ui/diagnostics/*.ts` | Key 状态展示 |
| `manifest.json` | `minAppVersion: 1.11.4` |
| `tests/secrets/ratel-secrets.test.ts` | 新建 |
| `tests/ui/chat-send-gate.test.ts` | 更新 |
| `tests/settings.test.ts` | 删 Key 字段断言 |
| `tests/integration/settings-propagation.test.ts` | 改为 mock secretStorage |
| `docs/superpowers/STATUS.md` | 登记 S-KEYCHAIN |

---

## 测试策略

### 单元测试 `ratel-secrets.test.ts`

- `isLocalHost` 边界: `localhost`, `127.0.0.1`, 带端口, 无协议
- Chat: 远端 base → `openai-compatible` + 正确 secret id; localhost → 不需要 Key
- Embed: `local` / api+localhost / api+remote 三种分类
- Rerank: 百炼 → `ratel-rerank-bailian`; `getSecret` mock 有值 → `hasRerankApiKey`
- `resolveChatApiKey` mock `app.secretStorage.getSecret`

### 回归

- `chat-send-gate`: 本地 Ollama 无 Key 可发送; OAI 兼容无 Key 硬拦
- `settings` 默认对象不含 `*ApiKey` 字段
- 全量 `npm test` + `npm run build` + `npm run lint`

### 手动 E2E

1. 钥匙串添加 `ratel-chat-openai-compatible` → Chat 可发送
2. 删除该密钥 → Chat 硬拦,文案指向钥匙串
3. `chatApiBase` 改 `http://localhost:11434/v1` → 无需密钥可 Chat
4. Embedding 切 Local → 设置无密钥提示块
5. Embedding 切 API + 远端 base → 提示 `ratel-embed-openai-compatible`
6. 两台设备 Sync 设置:第二台设备钥匙串未配置 → Chat 硬拦(验证不同步说明)
7. 钥匙串添加 `ratel-rerank-bailian` → Rerank 段显示「已配置」;删除后显示「未配置(关闭)」

---

## 自审

1. **Placeholder:** 无 TBD;远端 Ollama 预留 ID 已标明 v1 不读取。
2. **一致性:** 三类端点模型贯穿 Chat/Embed;Rerank 仅百炼单密钥。
3. **范围:** 单 spec 可拆一个 implementation plan,无需再分子项目。
4. **歧义:** DeepSeek 明确归入 `openai-compatible`;密钥名不含厂商名。

---

## 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 存储方式 | 纯钥匙串 | 无老用户,安全默认 |
| 密钥名 | 插件固定常量 | 用户不自定义,降低支持成本 |
| Chat 厂商 | 不拆 DeepSeek | OAI 兼容协议统一 |
| Ollama | 单独类型,本地免 Key | 预留后续远端/鉴权差异 |
| UI | 说明 + 状态,不用 SecretComponent | 名字固定,无需选择器 |
| Rerank | 仅百炼 v1 | 用户明确收窄范围;密钥 `ratel-rerank-bailian` |
| minAppVersion | 1.11.4 | SecretStorage API 可用版本 |
