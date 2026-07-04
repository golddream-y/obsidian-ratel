# ADR-007:模型 Context Window 配置策略(LiteLLM 映射表 + 预设下拉)

**状态**:Accepted
**日期**:2026-06-28
**关联**:ADR-006(发版资产 / jsDelivr 先例)、聊天 UI spec §5.6(原 context length 探测方案,本 ADR **取代**其 UI 与数据源设计)
**取代**:`probe-model.ts` 内置硬编码 `MODEL_CONTEXT_MAP` + 设置面板自由文本 + `chatModelMaxTokens` 默认 `0` 的**产品表述与主路径**

---

## Context(背景)

### 问题

StatusLine / StatusDrawer 用 `settings.chatModelMaxTokens` 计算上下文使用率(`used / max`)。当前实现存在三层问题:

1. **「测试连接自动推断」名不副实** — `probeModelContextLength` 发 `max_tokens=1` 的 chat 请求仅验证连通性;context 来自 10 余条硬编码 `MODEL_CONTEXT_MAP`,并非 API 返回值。OpenAI `/v1/models` 等主流端点**不返回** context window([社区长期诉求](https://community.openai.com/t/easy-way-to-get-a-context-window-for-a-model/552099))。
2. **测试连接实际不可用** — 设置面板调用探测时 `apiKey` 传空字符串,云端 API 直接 401;钥匙串里的 Key 未参与请求。
3. **默认值 `0` 体验差** — 未配置时 StatusLine 显示「未配置」,即使用户已选好模型;内置表过时(如 `deepseek-chat` 写 64000,LiteLLM 登记 131072)。

### 业界调研摘要(Tavily, 2026-06-28)

| 方案 | 代表 | 结论 |
|------|------|------|
| API 动态返回 context | OpenAI `/v1/models` | ❌ 无该字段 |
| 客户端硬编码 | Cursor `getEffectiveTokenLimit` | 仅覆盖自家模型列表 |
| **公开 JSON 映射表** | **LiteLLM `model_prices_and_context_window.json`** | ✅ 事实标准,~2900 模型,社区日更 |
| 代理 `/model/info` | LiteLLM Proxy | 需自建服务,不适合 Obsidian 插件 |
| 厂商 models API | OpenRouter `GET /api/v1/models` → `context_length` | 仅 OpenRouter 路由,非直连 DeepSeek |
| 本地探测 | Ollama `/api/show`、`ollama ps` | context 随 VRAM/`num_ctx` 变,无 CDN |
| 错误信息解析 | 故意超长输入 → `context_length_exceeded` | 贵、慢、依赖厂商文案 |

**LiteLLM 映射表要点:**

- 源文件:[`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)(~1.5MB)
- 运行时拉取 URL(带 CORS,Obsidian `requestUrl` 可用):
  - 默认:`https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json`
  - 备选:`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- 查 context 用字段 **`max_input_tokens`**(输入窗口上限);`max_tokens` 多为 max output,勿混用
- 模型 key 带 provider 前缀(如 `deepseek/deepseek-chat`),需模糊匹配用户填写的 `chatModel`
- LiteLLM 自身亦从 GitHub 同步该文件([sync_models_github](https://docs.litellm.ai/docs/proxy/sync_models_github));`@main` 曾出现 JSON 损坏 incident([incident report](https://docs.litellm.ai/blog/model-cost-map-incident)) — 实现阶段宜 **pin release tag** 作 fallback,在线优先 `@main` 或用户自定义 URL

### 用户诉求(产品)

- 默认信任 LiteLLM 公开映射表,网络可达时「测试连接」后**推荐** context,而非假装 API 推断
- 网络不可达时仍能用手选预设或自定义数字,不阻断使用
- UI 改为**下拉预设**(默认 **256k**),常见档位 +「自定义」展开输入框
- 映射表 URL **可自定义**(企业镜像 / pin 版本)

---

## Decision(决策)

采用 **三层策略:远程映射表推荐 → 预设下拉 → 自定义数值**。

### 1. 数据源:LiteLLM 映射表(可配置 URL)

| 项 | 值 |
|----|-----|
| 默认 URL | `https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json` |
| 文档/人工查看 | `https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json` |
| 设置项 | `modelRegistryUrl: string` — 空字符串表示使用上述默认 |
| 本地缓存 | `pluginDir/model-context-registry.json` + `model-context-registry.meta.json`(含 `fetchedAt` / `sourceUrl` / `etag`) |
| 缓存 TTL | **7 天**;过期后后台刷新,刷新失败继续用旧缓存 |
| 拉取时机 | 懒加载:首次「测试连接」或设置页打开 Chat 区时;**不在**插件 `onload` 阻塞 |
| HTTP | Obsidian `requestUrl` |

**查找算法**(`lookupContextLength(model, registry)`):

1. 精确 key:`model`、`model.toLowerCase()`
2. 后缀:`*/{model}`(如 `deepseek/deepseek-chat` 命中 `deepseek-chat`)
3. 前缀:registry key 以 `{model}` 开头(版本后缀)
4. 取 `max_input_tokens`;缺失则返回 `undefined`

命中后**不直接写死**为最终值,而是进入 §2 预设匹配。

### 2. UI:Context Length 预设下拉 + 自定义

**废弃:** 单独「Context Length」自由文本 + 「点击测试连接自动推断」文案。

**新 UI(Chat 模型配置区):**

```
Context Length    [ 256k ▼ ]     [ 测试连接 ]
                  └ 128k
                    200k
                    256k  ← 默认选中
                    1M
                    自定义

(仅当选择「自定义」时显示)
自定义 token 数   [ ____________ ]

(高级 / 可折叠)
模型映射表 URL    [ https://cdn.jsdelivr.net/gh/... ]  [ 恢复默认 ]
```

**预设枚举与数值:**

| 预设 ID | `chatModelMaxTokens` | 典型场景 |
|---------|----------------------|----------|
| `128k` | `128000` | 旧版 GPT-3.5 / 中小模型 |
| `200k` | `200000` | Claude 3.x 系列 |
| `256k` | `256000` | **默认**;Qwen / 多数新模型 |
| `1M` | `1048576` | DeepSeek V4 / Gemini 级长上下文 |
| `custom` | 用户输入 `≥ 4096` | 映射表值不在预设内 |

**设置字段:**

```typescript
/** 当前选中的预设;custom 时以 chatModelMaxTokens 为准 */
contextLengthPreset: '128k' | '200k' | '256k' | '1M' | 'custom';
/** 实际上限 token — StatusLine / context-manager 只读此字段 */
chatModelMaxTokens: number;
/** 空 = 使用 DEFAULT_MODEL_REGISTRY_URL */
modelRegistryUrl: string;
```

**默认值(新用户):**

```typescript
contextLengthPreset: '256k',
chatModelMaxTokens: 256000,
modelRegistryUrl: '',
```

**迁移(已有 `data.json`):**

| 旧值 | 迁移 |
|------|------|
| `chatModelMaxTokens === 0` | → `256k` / `256000` |
| 正整数且等于某预设 | → 对应 `contextLengthPreset` |
| 正整数且不等于任何预设 | → `custom` + 保留原值 |

**`getEffectiveChatModelMaxTokens`:** 删除「0 → 32000 静默回退」;未迁移脏数据一律视为 `chatModelMaxTokens`(默认 256000)。

### 3. 「测试连接」行为(重新定义)

测试连接 = **验证 Key + 模型名有效**,并**可选推荐** context(非 API 推断)。

流程:

```
1. 从钥匙串 resolveChatApiKey(app, settings) — 需要 Key 的端点未配置则 Notice 引导,不发起请求
2. POST {apiBase}/chat/completions  max_tokens=1  stream=false
3. 失败 → Notice 错误,不改 Context Length
4. 成功 →
   a. 加载映射表(缓存优先 → 远程 URL → 失败则跳过 a)
   b. lookupContextLength(chatModel) → recommended
   c. 若 recommended 存在:
      - 若等于某预设 token 数 → 选中该预设
      - 否则 → 选「自定义」并填入 recommended
      - Notice: 「连接成功 · 已根据模型库推荐:131,072 tokens」(示例)
   d. 若映射表不可用或未命中:
      - 不改当前下拉选项
      - Notice: 「连接成功 · 请确认 Context Length 是否与模型文档一致」
5. saveSettings + display() 刷新
```

**不再声称**「API 自动推断」;文案统一为「根据模型库推荐」或「连接成功,请确认」。

### 4. 网络不可达与离线

| 场景 | 行为 |
|------|------|
| 从未成功拉取映射表 | 下拉预设 + 自定义仍可用;默认 256k;测试连接仅验连通性 |
| 曾有缓存 | 用本地缓存做推荐 |
| 用户自定义 URL 失败 | 同「未命中」,不降级修改用户已选预设 |
| 完全离线长期使用 | 与「从未拉取」相同;不阻塞聊天 |

不将映射表 bundled 进 `main.js`(避免 +1.5MB)。可选后续:内置 **精简 fallback 表**(~20 条常用模型)仅当无缓存且网络失败时用于推荐 — **不在本次 ADR 范围**,实现时若工时可加。

### 5. Ollama / 本地端点(补充,非主路径)

`chatApiBase` 为 localhost 且映射表未命中时,**可选**后续调用 `GET {base}/api/show`(非 OpenAI 路径)读 `context_length` — 优先级低于 LiteLLM 命中。本次 ADR 记录为 **P2 增强**,不阻塞 007 落地。

---

## 方案对比(摘要)

| 方案 | 评估 |
|------|------|
| A. 维持内置 10 条硬编码表 | ❌ 过时快,已证明不好用 |
| B. 仅下拉预设,无远程表 | ⚠️ 简单但换模型需手调 |
| **C. LiteLLM CDN + 预设 + 自定义(本 ADR)** | ✅ 与业界一致,离线可用手选 |
| D. 每次全量拉 1.5MB 无缓存 | ❌ 浪费流量,设置页卡顿 |
| E. OpenRouter `/v1/models` 作唯一源 | ❌ 仅覆盖 OpenRouter 用户 |

---

## Consequences(后果)

**正面:**

- 产品与实现一致:测试连接验连通性,context 来自公开维护的映射表
- 默认 256k,StatusLine 开箱即用,无「未配置」死区
- 预设覆盖 80% 常见模型;精确值走自定义
- 映射表 URL 可配,满足 pin 版本与企业镜像
- 修复钥匙串 Key 未参与测试连接的 bug(纳入本 ADR 实现)

**负面:**

- 首次推荐需联网拉取(或依赖缓存);完全离线新用户需手选预设
- LiteLLM `@main` 偶发坏 JSON — 靠 TTL 缓存 + pin tag fallback 缓解
- 映射表 key 与用户 `chatModel` 不一致时仍可能未命中(需手选)
- `chatModelMaxTokens` 为**用户认知的上限**,可能与厂商实际窗口有偏差(尤其 Ollama)

**影响面(实现清单):**

| 文件 | 变更 |
|------|------|
| `docs/adr/2026-06-28-model-context-window-registry.md` | 本 ADR |
| `src/settings.ts` | 新增 `contextLengthPreset`、`modelRegistryUrl`;UI 下拉 + 条件自定义输入 + 映射表 URL;默认 `256000` |
| `src/ui/tokens/model-context-registry.ts` | **新增** — 拉取/缓存/解析 LiteLLM JSON + `lookupContextLength` |
| `src/ui/tokens/probe-model.ts` | 重构 — 连接测试 + 调 registry 推荐;删除硬编码 `MODEL_CONTEXT_MAP` |
| `src/utils/context-window.ts` | 简化 — 移除 `0 → 32000` 回退 |
| `src/secrets/ratel-secrets.ts` | 探测路径使用 `resolveChatApiKey`(调用方) |
| `tests/ui/tokens/model-context-registry.test.ts` | **新增** — 查找算法 + 预设匹配 |
| `tests/ui/tokens/probe-model.test.ts` | 更新 — Key、推荐、未命中分支 |
| `docs/architecture/agent/chat.md` §5.6 | 对齐本 ADR 表述 |

---

## 参考

- [LiteLLM `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
- [LiteLLM — Add Model Pricing & Context Window](https://docs.litellm.ai/docs/provider_registration/add_model_pricing)
- [LiteLLM — Auto Sync Model Cost Map](https://docs.litellm.ai/docs/proxy/sync_models_github)
- [LiteLLM — Model cost map incident (2026-01)](https://docs.litellm.ai/blog/model-cost-map-incident)
- [OpenAI Community — context window not in models API](https://community.openai.com/t/easy-way-to-get-a-context-window-for-a-model/552099)
- [OpenRouter Models API — `context_length`](https://openrouter.ai/docs/guides/overview/models)
- [Ollama — Context length](https://docs.ollama.com/context-length)
- [ADR-006 — jsDelivr 懒下载先例](./2026-06-28-release-asset-distribution.md)
- `docs/superpowers/specs/2026-06-28-chat-message-stream-redesign-design.md` §5.6(被本 ADR 取代)
