# S-GRAPH-EXPAND — 图谱原生升级：检索 1 跳扩邻 + hub 降权 + 引用标注

> **ID:** S-GRAPH-EXPAND  
> **状态:** Active  
> **日期:** 2026-08-03  
> **关联:** [ADR-013](../adr/2026-08-03-graph-retrieval-minimize-human-curation.md)（少靠人管理）、[S-EVOLUTION](2026-07-15-evolution-graph-agent.md)（图谱原生总纲）、P-EVO-A-READ（读工具已落地）  
> **动机:** 当前「图谱原生」只有读工具与 prompt 引导；主检索无自动沿链扩邻。ADR-013 已钉死「尽量避免人管理」，本 spec 落地其**近端**主张。

---

## 1. 背景

Ratel 现有检索主路径：

1. `search_vault` → `MultiQuerySearcher`（改写 → 向量 + BM25 混合 → RRF → 可选 Rerank）
2. 结果 enrich `tags` + `backlinkCount`（仅信号，不扩邻）
3. Agent 可显式调 `get_links` / `search_by_tag` / `get_vault_structure` 等读工具

**缺口：** 命中后不会自动沿正文链接取邻居；「图谱原生」对最终回答的召回**没有默认参与**。

同时已确认的反模式（ADR-013）：

- 依赖用户精心养链接图
- 把 Daily Plan / 自动回写链当高质量关系（「今天打开过」≠ 知识相关）

---

## 2. 目标

1. **默认试一跳** — `search_vault` 命中后，机会性沿**正文 wikilink 出链**扩 1 跳邻居，并入候选上下文
2. **噪声 hub 默认挡** — Daily / MOC / 模板类高扇出或高反链节点**不进入**扩邻集
3. **零配置、零整理前提** — 无边 / 失败时结果与现状一致，不劣化
4. **引用可见图参与** — 回答引用区能区分「检索命中」与「经链接图补充」

成功标准：

- 有正文链接的库：同一查询可召回与命中笔记相链的相关笔记（可测）
- 无链接 / 全是 Daily hub 的库：结果不劣于纯向量
- 不新增用户必须配置的项；不新增网络调用；不改 MemoryStore

---

## 3. 非目标

- 自动弱边（共现 / 同标签补关系）— 中期，另 spec
- 全库实体 GraphRAG / 社区摘要 — 远期 opt-in，另 ADR
- 写回「建议链接」— 远期
- 改 `get_links` 等读工具语义；改向量索引格式
- 移动端适配（本插件 `isDesktopOnly`）

---

## 4. 详细设计

### 4.1 数据流（扩邻）

```
search_vault(query)
  → MultiQuerySearcher 得 top K 命中(path + score)
  → GraphExpander.expand(hits)
      for each hit:
        links = vault.getLinks(path).outgoing   // 仅已解析正文链
        for each link:
          if isHub(link) → skip                // 降权规则见 4.2
          neighbor 加入候选(标记 viaGraph=true, sourcePath=hit.path)
  → 邻居与命中去重、按 score 衰减排序
  → 返回 search_vault 结果 + 可选 graphExpanded 区段
```

- **默认跳数 = 1**；2 跳为后续 opt-in
- 邻居**不**重新走 embedding；用标题 / 已有 chunk 摘要或按需 `read_note` 片段（成本可控）
- 邻居参与上下文时**标记来源**（`via: graph`, `from: <原命中路径>`）

### 4.2 Hub 降权规则（默认）

节点满足任一即视为 hub，**不**作为扩邻目标：

| 规则 | 默认阈值（可调常量） |
|---|---|
| 出链扇出 | `> HUB_MAX_OUTGOING`（如 50） |
| 反链数 | `> HUB_MAX_BACKLINKS`（如 100） |
| 路径模式 | Daily / Periodic Notes 常见目录或命名（可配正则，默认空 = 不猜用户目录） |
| 模板目录 | 命中 `templates/` 等（默认保守，可后续细化） |

**原则：** 宁漏勿滥 — 误杀一篇真枢纽，好过把「今日打开过的一切」灌进上下文。

### 4.3 与 Agent / 引用的关系

- `search_vault` 返回结构扩展：每条结果可带 `via?: 'search' | 'graph'`、`graphFrom?: string`
- Prompt 层：告知模型 `[n]` 编号覆盖 search + graph 候选；引用编号仍与 UI 对齐
- UI：引用 chip / 来源区可对 `via=graph` 的笔记加轻标注（如「链接图」），不改变现有双通道加固行为

### 4.4 失败与降级

- `getLinks` 异常 / 邻居读取失败 → 跳过该邻居，整体不失败
- 无任何可用边 → 返回与今天相同的纯检索结果
- 性能：扩邻只读 `metadataCache` 与少量文件；禁止主线程全库扫描

### 4.5 配置（最小化）

- **默认开**：扩邻启用，无需设置项
- 可选设置（若实现）：`graphExpand.enabled`、`graphExpand.maxHops`、`graphExpand.hubThresholds` — 非必须，首期可全常量

### 4.6 模块契约（plan 阶段钉死，P-GRAPH-EXPAND）

**新模块 `src/core/graph-expander.ts`**（纯逻辑，同步，无 HTTP）：

```typescript
export const HUB_MAX_OUTGOING = 50;     // 出链超阈值 = hub（Daily / MOC）
export const HUB_MAX_BACKLINKS = 100;   // 反链超阈值 = hub
export const DEFAULT_MAX_NEIGHBORS = 5; // 单次最多补 5 篇邻居

export interface GraphNeighbor { path: string; from: string }
export class GraphExpander {
	constructor(vault: VaultPort);
	expand(
		hits: Array<{ path: string }>,
		opts?: { maxNeighbors?: number; allowedPaths?: ReadonlySet<string> },
	): GraphNeighbor[];
}
```

- **双通道确认（链接提议，向量裁决）**：邻居必须同时 ① 被命中正文链接 ② 落在检索候选池内，挡「链了但语义无关」的边
- **hub 双向挡**：源命中出链 > 50 整源跳过（Daily 场景）；邻居出链 > 50 或反链 > 100 跳过
- **过滤顺序（成本从低到高）**：去重 seen → 候选池 allowedPaths → hub 判定
- **降级**：`getLinks` 异常跳过该源；`isHub` 异常按 hub 处理（宁不扩）

**候选池来源 `MultiQuerySearcher.searchWithPool()`**：

- 新增 `searchWithPool(query, topK): Promise<{ results, candidatePaths: Set<string> }>`；原 `search()` 保留签名为薄包装，**存量测试零改动**
- 候选池 = 各查询 `topK×2` 过度抓取结果的 `metadata.path` 去重集（已算过语义分，**零额外成本**）

**`search_vault` 结果扩展**（在既有 enrich 后追加，不 interleave）：

| 字段 | 取值 |
|---|---|
| `docId` | `graph:<path>` |
| `score` | 源命中 score × 0.8（`GRAPH_SCORE_DECAY`） |
| `index` | 续编号 — 与检索命中**共享同一 `[n]` 引用空间** |
| `reranked` | `false` |
| `metadata` | `{ path, tags, backlinkCount, via: 'graph', graphFrom }` |

**透传链路**：`search-result-mapper.ts` 的 `SearchResultItem` → `AgentEvent.search.result` payload → `Message.searchResults` → `SearchResults.svelte` 芯片「链接图」徽标（i18n `chat.cite.viaGraph`）。

**Prompt**（单源 `src/prompts/defaults/zh.ts`，无 en 副本）：`agent.rag.workflow` 与 `tool.search_vault.description` 告知模型 `via=graph` 条目与检索命中同等用 `[n]` 引用。

---

## 5. 影响面

| 面 | 变更 |
|---|---|
| `search_vault` 工具 | 返回结构扩展；内部调用 GraphExpander |
| 新模块 | `core/graph-expander.ts`（或同等），依赖 VaultPort.getLinks |
| Prompt | RAG workflow / toolGuide 补「图补充候选」说明 |
| UI | 引用区可选标注 `via=graph`（轻量） |
| 测试 | 扩邻单测（hub 过滤、去重、降级）；search_vault 集成 |
| 文档 | user-guide 检索行为说明；README「图谱原生」表述与 ADR-013 对齐 |

**明确不改：** MemoryStore、记忆文件格式、vectra 索引 schema、权限模型、网络面。

---

## 6. 参考

- [ADR-013](../adr/2026-08-03-graph-retrieval-minimize-human-curation.md) §3.1 近端升级主张
- [S-EVOLUTION](2026-07-15-evolution-graph-agent.md) 结构盲区与杠杆
- 现状盘点：`search_vault` / `MultiQuerySearcher` / `get_links`（P-EVO-A-READ 已合）
