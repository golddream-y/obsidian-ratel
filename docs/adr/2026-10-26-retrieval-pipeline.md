# ADR-021: 检索链路的关键决策调整 — 关键词退出召回、分块改按 token、精排双来源

**状态**:Accepted
**日期**:2026-10-26
**关联**:
- [S-RETRIEVAL-QUALITY](../superpowers/specs/2026-10-20-retrieval-quality.md)(本 ADR 的实现依据)
- [P-RETRIEVAL-QUALITY](../superpowers/plans/2026-10-20-retrieval-quality.md)(实施计划,7 个任务已完成)
- [S-W3-HYBRID](../superpowers/archive/S-W3-HYBRID/2026-06-26-ratel-w3-hybrid-search-design.md)(本 ADR **反转**其"交给 vectra 内置混合搜索"的决定)
- [ADR-013](2026-08-03-graph-retrieval-minimize-human-curation.md)(结构增益仍由图谱扩邻承担,本次不动)
- 架构正文 [rag/retriever.md](../architecture/rag/retriever.md)、[rag/vector-index.md](../architecture/rag/vector-index.md)、[host/worker-protocol.md](../architecture/host/worker-protocol.md)
- 代码:`8e82abc`(检索通道与分块)、`fd63107`(分块档位化)

---

## Context(背景)

检索最初的设计(P-W3-IMPL,2026-06-13)是**两路独立召回**:Worker 跑向量检索与关键词检索,主线程用 RRF 融合。2026-06-26 的 S-W3-HYBRID 以「vectra 已内置混合搜索,无需手动两路 + RRF」为由,把这一路改成单次调用 `queryItems(vector, query, topK, undefined, isBm25=true)`。

2026-10-20 复核代码与依赖源码,发现该路径**从未生效**,并同时发现分块与精排的两处结构性问题:

| 问题 | 事实 |
|---|---|
| 关键词恒为空转 | vectra 的 BM25 分支要求条目带 `metadata.documentId / startPos / endPos` 才回读全文;索引写入走 `upsertItem`,只写 `{path, chunkIndex, startOffset}`,该分支被静默跳过,贡献恒为 0 |
| 每次查询重建 | `queryItems(isBm25=true)` 在查询内重建 BM25 引擎并遍历全部条目回读文档,复杂度 O(条目数)/查询 |
| 中文不可用 | 分词依赖 `wink-eng-lite-web-model`,是英文停用词与词干模型 |
| 分块单位错位 | 分块按**字符** 500,模型按 **token** 512 输入并在超限处静默截断;块尾从未进入向量 |
| 分块设置假生效 | `chunkSize/chunkOverlap` 只写进清单并触发重建,实际调用硬编码 `500/100` |
| 精排被专用模型绑死 | 只有钥匙串存在 `ratel-rerank-bailian` 时才注入 Reranker,否则完全没有精排 |

结论:补三个元数据字段不能让关键词可用(仍慢、仍中文不准);分块错位与设置假生效是同一件事的两面;精排的可用性不该绑在一个可选密钥上。

## Decision(决策)

### 决策 A:关键词退出召回链路

移除 `hybrid.search` 协议、`VectraStore.hybridSearch`、`IndexProcessor.hybridSearch` 与相关测试;查询统一走 `vector.search`。**关键词能力由 `grep` 工具承担**,不参与 `search_vault` 的融合与排序。

不恢复 P-W3-IMPL 的两路 + RRF:第二路需要可用的中文全文索引(自建倒排或中文分词 BM25),属于新能力而非修复,排到 2.0 的 D 包(D · 大库与搜索增强)。若将来要做,应自建索引,**不复用 vectra 的 BM25**。

### 决策 B:分块以 token 为单位,并携带结构前缀

- 新增 `core/token-counter.ts`:有本地词表用 `tokenize().length` 精确计数;无词表(API embedding)按字符数**上界**估算——高估只会让块变小,低估会被静默截断。
- `chunkMarkdown(content, opts)` 接受 `{ maxTokens, overlapTokens, count, docTitle? }`;预算**逐块**计算(`maxTokens - count(前缀)`),保证 `count(embedText) ≤ maxTokens`。
- 取消原「允许单块到 1.5× chunkSize」的兜底:它与"不被截断"直接冲突,代价是长文档块数略增。
- 块新增 `embedText / prefix / headingPath`:`embedText` 只用于嵌入,`text` 与 `startOffset/endOffset` 仍是正文,前缀不污染定位。
- 前缀取块内**最深层级**标题的完整祖先链(如「项目汇报 › 预算 › 明细 › 」);块跨多个小节时这是近似。

### 决策 C:分块参数对外暴露为档位

用户记不住「448 token 是多大」,且原滑块上限 1000 会被模型上限静默钳制。因此:

- 档位:`精细 192 / 均衡 320 / 粗粒度 448`,加「自定义」;上限 `CHUNK_SIZE_MAX_TOKENS = 448`(本地模型 512 减去 64 的预留)。
- 设置页始终显示「实际生效 N token」,选档位时数字随档位走,改数字时按值反推档位。
- 旧库加载时把超限值钳回 448 并反推档位,不再出现"设了 500 却按 448 切"。

### 决策 D:精排来源双轨,开关默认开

- 两个设置项:开关 `rerankEnabled`(默认开)与来源 `rerankSource: 'native' | 'llm'`(默认 `native`)。
- 两种来源**互斥、不叠加、不回落**:选定 `llm` 即替代专用模型;缺能力时关闭并由界面说明原因,不静默换到另一条更贵的路径。
- `native` 仍需 `ratel-rerank-bailian`;`llm` 用当前对话模型(沿用已配置供应商,**不新增外发目的地**;而专用 rerank 是新的外发目的地,设置页须说明)。
- 对话模型精排只送前 12 条、每条截断 400 字符,要求返回 JSON;解析失败/越界/超时按精排失败处理,回退 RRF,`reranked=false`,**不用猜测顺序冒充精排**。
- 候选 ≤ 3 条时直接返回 RRF 顺序:不调用精排,也不读全文(`MIN_RERANK_CANDIDATES = 4`,判定在读全文之前)。
- 精排以工厂注入,每次检索解析一次,设置改动无需重载插件。

### 决策 E:索引引入代数,规则变化强制重建

清单新增 `chunkerVersion`(当前 `1`),纳入 `shouldFullRebuild`;旧清单没有该字段,`undefined !== 1` 即触发一次全量重建。字段声明为可选,诚实反映"旧文件没有它"。

### 决策 F:Worker 协议收敛

`index.full / index.incremental / index.batch` 增加可选 `chunkOptions: { maxTokens, overlapTokens }`(`count` 是函数,不能过 postMessage);缺失时 Worker 按模型上限兜底。词表通过 `setVocabContent()` 在初始化时传一次(约 109KB),不随每条消息传。

## Consequences(后果)

| 影响 | 说明 |
|---|---|
| 检索结果 | 语义召回结果不变(关键词原本贡献为 0);**分块边界变化会改变召回内容**,块尾不再丢失 |
| 升级成本 | `chunkerVersion` 触发**一次全量重建**;重建期间检索不可用,沿用现有"未就绪"提示 |
| 存储 | 块数可能增加(取消 1.5× 兜底 + 默认档位 320),向量与索引体积随之增加 |
| 成本 | 精排默认开启;`native` 仅在配了密钥时生效,`llm` 按 token 计费且明显更慢 |
| 产品承诺 | `prd/features.md` 中「语义与关键词保证召回下限」在排序层面**尚不成立**,关键词只在工具(`grep`)层面成立;需在发版说明或 PRD 中改口径 |
| 文档债 | `architecture/overview.md` 原引用的 `ADR-011` 从未提交,已改指本 ADR 与 ADR-013 |

## Alternatives(未采用的方案)

| 方案 | 不采用的原因 |
|---|---|
| 给 `upsertItem` 补 `documentId/startPos/endPos` | 补完仍是每次查询 O(条目数) 重建,且中文分词不可用;修好一个不可用的实现没有意义 |
| 改走 `upsertDocument` 让 vectra 自己切块 | 分块权交给上游,丢失我们的 token 预算与结构前缀 |
| 分块保持字符、只把上限调小 | 字符与 token 在中英混排下不成比例,仍会静默截断 |
| 精排 auto 自动回落(无专用密钥时用对话模型) | 用户在不知情的情况下多付一次对话调用;显式选择更可预期 |
| 分块大小继续用滑块 | 数字没有记忆点,且上限与模型能力脱节 |

## 参考

- [retriever.md](../architecture/rag/retriever.md) §2.3、§3.2(关键词为何不在召回链路)
- [S-RETRIEVAL-QUALITY](../superpowers/specs/2026-10-20-retrieval-quality.md) §4.1–§4.5
- 外部依据:分块经验值(400–512 token + 10–20% overlap)、contextual retrieval 中 BM25 与向量混合的适用前提
- 依赖源码:`node_modules/vectra/lib/LocalIndex.js` 的 BM25 分支(要求 `documentId/startPos/endPos`)
