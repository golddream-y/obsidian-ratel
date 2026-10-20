# 检索质量：分块预算、结构前缀与双来源精排

> ID：S-RETRIEVAL-QUALITY · 日期：2026-10-20 · 状态：Active（已实现，代码 8e82abc；待发版。范围限于 Markdown 基线，不含多格式接入）
>
> 三件事按收益排序：先堵住现有召回通道的漏损，再让精排不必依赖专用 rerank 模型，最后补结构信息。

## 1. 背景

| # | 现状 | 证据 |
|---|---|---|
| 1 | 分块设置是假生效 | `settings.chunkSize/chunkOverlap` 只写进 manifest 并触发重建；[index-processor](../../../src/worker/index-processor.ts) 三处硬编码 `chunkMarkdown(content, 500, 100)` |
| 2 | 块尾被静默截断 | chunker 允许单块到 `chunkSize × 1.5` 再叠 overlap；[bert-tokenizer](../../../src/adapters/bert-tokenizer.ts) 在 `maxLength - 2` 处直接 `slice`，不报错 |
| 3 | 块不带上下文 | 嵌入输入只有正文，模型分不清「这句话属于哪篇、哪一节、哪张表」 |
| 4 | 精排被专用模型绑死 | [main.ts](../../../src/main.ts) 只在钥匙串有 `ratel-rerank-bailian` 时才注入 Reranker；没有它就没有精排，哪怕对话模型本来可用 |

第 1、2 条是同一件事的两面：设置没被用上，用了的单位又和模型对不上。

## 2. 目标

1. 分块以 token 为单位、真正使用用户设置，任何块都不超过模型输入上限。
2. 精排有两个来源：专用 rerank 模型，或当前已配置的对话模型；切换规则明确，用户可预期。
3. 块携带结构前缀（文件 › 标题 › 表格），且不污染原文偏移与精确检索。
4. 升级后索引自动重建一次，旧块不残留。

## 3. 非目标

- 不接入 Office/PDF，不改变可索引文件范围。
- 不自建关键词/倒排索引（关键词仍由 `grep` 承担）。
- 不更换 embedding 模型与向量后端，不新增依赖。
- 不做查询侧改写算法调整（现有 Query Rewrite 不动）。

## 4. 详细设计

### 4.1 分块按 token 预算

新增 `core/token-counter.ts` 作为唯一计数入口，**不扩展 `EmbeddingPort`**——分词器是纯 JS，没必要为了计数在 Worker 与嵌入线程之间加一轮往返。

```ts
interface TokenCounter {
  readonly exact: boolean;      // true = 词表精确；false = 字符上界估算
  readonly maxInputTokens: number;
  count(text: string): number;  // 不含 [CLS]/[SEP]
}
```

- 有本地词表：`tokenize(text).length` 精确计数。
- 无词表（API embedding）：按字符数估算，且**必须高估**——高估只会让块更小，低估会让块被静默截断；设置页与日志标注"估算"，不伪装成精确值。

`chunkMarkdown` 改为接受 `{ maxTokens, overlapTokens, count, docTitle? }`，结构优先策略不变（标题 → 段落 → 句子 → 硬切），每级回退都复算 token。**预算逐块计算**：`maxTokens` 是含前缀的总预算，实际正文额度 = `maxTokens - count(该块前缀)`，保证 `count(embedText) ≤ maxTokens`。

### 4.2 设置真正生效

- `IndexProcessor` 构造时接收 `{ chunkSize, chunkOverlap }`，三个索引入口统一使用。
- `handler` 从 `index.*` 消息读取；`main.ts` 从 settings 传入。
- 设置项单位由"字符"改为"token"，中英文描述同步；取值范围沿用现有滑块。

### 4.3 结构前缀

- chunker 在切分时透传所属标题路径；PPT/表格接入后扩展为页号与表头。
- **嵌入输入** = `文件标题 › 标题路径 › 正文`；**返回与精确检索**仍用正文原文。
- 前缀计入 token 预算，不计入 `startOffset/endOffset`，避免定位偏移。

实现期确定的三条细节（2026-10-20）：

| 细节 | 决定 | 理由 |
|---|---|---|
| 前缀取哪条标题路径 | 取块内**最深层级**（最后进入的 section）的完整祖先链 | 既保留上级语境，又保留最具体的定位；块跨多个小节时这是近似 |
| 块长上限 | 严格不超过预算（原实现允许 1.5×） | 1.5× 与「不被模型截断」直接冲突，代价是长文档块数略增 |
| overlap 上限 | 不超过块长的一半，且至少前进一个字符 | 否则下一块近乎整块重复，收敛极慢 |

### 4.4 精排：两个来源与切换关系

保留 `RerankerPort` 不变，新增一个适配器，切换发生在装配处（`main.ts`）。

| 来源 | 实现 | 前提 | 成本与延迟 |
|---|---|---|---|
| 专用 rerank 模型 | 现有 `BailianReranker` | 钥匙串有 `ratel-rerank-bailian` | 一次专用 API 调用，便宜且快 |
| 对话模型 | 新增 `LlmReranker` | 已配置对话模型 | 一次对话调用，按 token 计费，明显更慢 |

**两个设置项**：开关 `rerankEnabled`（默认**开**）与来源 `rerankSource: 'native' | 'llm'`（默认 `native`）。开关与来源分开，用户能一键关掉，而不用先理解来源。

| 开关 | 来源 | 实际生效 |
|---|---|---|
| 关 | 任意 | `off`，不精排，`reranked=false` |
| 开 | `native` | 有 rerank 密钥 → 专用模型；无密钥 → `off`，并提示「未配置密钥」 |
| 开 | `llm` | 对话模型可用 → 对话模型；不可用 → `off` |

**两种来源互斥，不叠加。** 选定对话模型即**替代**专用模型的排序，不会两次精排；反之亦然。不设 `auto`：没有自动回落，缺能力就如实关闭并说明原因，避免用户以为在精排、实际悄悄换了一条更贵的路径。

**为什么默认专用模型**：同类效果下它更便宜、更快，且不占用对话上下文；对话模型精排是显式选择，因为它按 token 计费、明显更慢。

**短路径：候选 ≤ 3 条不精排。** 结果本来就少，全部能进上下文，排序收益接近于零，却要付一次调用（对话模型还要先读全文）。因此在候选数 ≤ `MIN_RERANK_CANDIDATES`（3）时直接返回 RRF 顺序，`reranked=false`。判定放在读全文**之前**，顺带省掉几次无谓的文件读取。

**输入控制**（两种来源共用，但预算不同）：

- 专用模型：可送候选全文，维持现状。
- 对话模型：只送前 N 条（默认 12），每条截断到 M 字符（默认 400）并附标题路径；总输入设上限，超限先减候选数再减单条长度。
- 对话模型的提示要求返回 JSON `[{id, score}]`；解析失败、字段缺失或分数越界都按**精排失败**处理，不允许用猜测顺序冒充精排结果。

**失败与降级**：任一来源失败 → 回退 RRF 原始顺序，`reranked=false`，记日志。**不做级联切换**（native 失败后再试 llm），避免一次检索叠两次超时。

**结果契约不变**：两种来源都只产出 `{ id, score }`，下游排序、`reranked` 标记、UI 徽标逻辑不动。

**成本与外发边界**：专用 rerank 是**新的外发目的地**，设置页需说明"候选内容会发送到该地址"；对话模型走已配置的供应商，不新增目的地。这条差异要在模式选择旁写清楚，用户据此选。

**UI**：设置页显示"当前生效：未启用 / 专用模型 / 对话模型"及原因（缺密钥、模型不可用）；对话消息里的精排徽标沿用，不区分来源。

### 4.5 升级与重建

manifest 增加 `chunkerVersion`，`shouldFullRebuild` 纳入比较。分块单位、预算或前缀规则任一变化都触发一次全量重建；重建期间沿用现有"未就绪"提示，不返回旧结果。

## 5. 影响面

| 文件 | 改动 | 风险 |
|---|---|---|
| 新增 `core/token-counter.ts` | 精确计数 / 上界估算 | 估算误差需标注；精确计数成本随块数线性增长 |
| [chunker.ts](../../../src/worker/chunker.ts) | token 预算 + 前缀透传 | 纯函数，单测覆盖 |
| [index-processor.ts](../../../src/worker/index-processor.ts) | 真实参数 | 三个入口 |
| [handler.ts](../../../src/worker/handler.ts) | payload 透传 | 协议字段增加 |
| [index-manifest.ts](../../../src/core/index-manifest.ts) | `chunkerVersion` | 升级即全量重建 |
| 新增 `adapters/reranker-llm.ts` | 对话模型精排 | 输入预算与解析健壮性 |
| [multi-query-searcher.ts](../../../src/core/multi-query-searcher.ts) | 候选 ≤3 时跳过精排 | 短路径判定要在读全文之前 |
| [main.ts](../../../src/main.ts) | 按开关与来源装配 reranker | 装配逻辑集中在一处 |
| [settings.ts](../../../src/settings.ts) + i18n | `rerankMode`、单位说明、成本提示 | 中英两处 |

## 6. 验收

| 项 | 判据 |
|---|---|
| 块长上限 | 中文、英文、中英混排、长表格样本，所有块 `tokenCount ≤ maxTokens` |
| 设置生效 | 调整 `chunkSize` 后同一文件块数随之变化，并触发重建 |
| 前缀隔离 | 嵌入输入含标题路径；`startOffset/endOffset` 与返回正文不含前缀 |
| 精排开关 | 关闭后不再发起任何精排调用（两种来源都不发），`reranked=false` |
| 精排切换 | 开关 × 三种来源的全部组合符合判定表；缺密钥/缺模型时如实显示原因 |
| 短路径 | 候选 ≤3 条时不调用精排、不读全文，顺序等于 RRF 结果 |
| 精排健壮性 | 模型返回非法 JSON、分数越界、超时 → 回退 RRF 且 `reranked=false`，不阻断回答 |
| 成本可见 | 对话模型模式下，一次检索的额外调用与 token 量可观测 |
| 无连带损伤 | `grep`、`read_note`、记忆搜索行为不变 |

## 7. 待决

1. 默认预算取 448 还是更保守的 384；需用真实笔记量一次块长分布。
2. overlap 是否保留默认 100 token；检索证据对收益存疑，去掉会改变既有结果。
3. 对话模型精排的候选数（12）与单条截断（400 字符）需实测延迟后再定。
4. 是否给对话模型精排加结果缓存（同查询短期内复用），还是每次实算。
5. 专用模型连续失败时，是否需要提示「可改用对话模型」。
6. 无专用密钥的用户默认没有精排（开关开着但来源不可用）。是否需要在设置页做一次提示，引导配置密钥或手动切到对话模型。

## 8. 参考

- [chunker](../../../src/worker/chunker.ts)、[bert-tokenizer](../../../src/adapters/bert-tokenizer.ts)、[reranker-bailian](../../../src/adapters/reranker-bailian.ts)、[multi-query-searcher](../../../src/core/multi-query-searcher.ts)
- [架构总览](../../architecture/overview.md)、[检索器](../../architecture/rag/retriever.md)
- 外部依据：[分块经验值](https://www.firecrawl.dev/blog/best-chunking-strategies-rag)、[contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
