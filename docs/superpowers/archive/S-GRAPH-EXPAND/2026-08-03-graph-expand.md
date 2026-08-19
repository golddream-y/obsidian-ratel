# P-GRAPH-EXPAND — 检索 1 跳图谱扩邻 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `search_vault` 命中后默认沿正文 wikilink 机会性扩 1 跳邻居;**双通道确认**(链接提议,向量裁决)+ hub / Daily 默认挡;引用芯片标注「链接图」— 零配置、不劣化纯向量结果。

**Architecture:** 新建 `core/graph-expander.ts` 纯逻辑模块(只读 VaultPort metadataCache,同步、无 HTTP);`MultiQuerySearcher` 新增 `searchWithPool()` 暴露 over-fetch 候选池 path 集(原 `search()` 保留为薄包装,存量测试零改动);`search-vault.ts` 在既有 enrich 之后追加 `via=graph` 邻居条目(index 续编号、score = 源分数 × 0.8、**必须落在候选池内**);`search-result-mapper` / `AgentEvent` / `Message` 透传 `via` 标记;`SearchResults.svelte` 芯片加「链接图」徽标;prompt 单源 `defaults/zh.ts` 补充图候选说明。

**Tech Stack:** TypeScript / Svelte 5 / Obsidian metadataCache / Vitest / i18n

**Spec:** [S-GRAPH-EXPAND](../specs/2026-08-03-graph-expand-design.md) · **ADR:** [ADR-013](../../adr/2026-08-03-graph-retrieval-minimize-human-curation.md)

## Global Constraints

- 用户可见字符串走 i18n(`zh.ts` + `en.ts` + `types.ts`),禁止硬编码
- 测试 `it(...)` 描述中文:`行为 - 条件 - 期望结果`
- 文件头 / 导出注释按 AGENTS.md 中文规范
- **零新增配置项**;扩邻默认开,常量钉死
- **不新增网络调用**;扩邻只读 metadataCache(`getLinks` / `getBacklinks` 同步)+ 复用已算好的候选池
- **不劣化**:扩邻任何异常 → 返回与现状一致的纯检索结果
- **双通道确认**:邻居必须同时 ① 被命中正文链接 ② 落在检索候选池(topK×2 过度抓取,已算语义分)内 — 一步到位,不留中间过渡态
- **不改** MemoryStore、vectra 索引 schema、`get_links` 等读工具语义、权限模型
- **不改** `MultiQuerySearcher.search()` 现有签名(薄包装),存量 9 个 searcher 测试保持绿色
- prompt 默认文本单源在 `src/prompts/defaults/zh.ts`(**无 en 副本**,勿找 en.ts 改)
- 引用编号空间:检索命中与图邻居共享同一 `[n]` 编号,UI 与模型看到的一致

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/graph-expander.ts` | 新建:1 跳扩邻 + hub 双向挡 + 候选池语义门槛 |
| `tests/core/graph-expander.test.ts` | 新建:hub 过滤 / 去重 / 上限 / allowedPaths / 异常降级 |
| `src/core/multi-query-searcher.ts` | 新增 `searchWithPool()` 返回候选池;`search()` 变薄包装 |
| `tests/core/multi-query-searcher.test.ts` | 追加 2 个 `searchWithPool` 用例(存量 9 个不动) |
| `src/tools/search-vault.ts` | 改调 `searchWithPool`;接入 GraphExpander 追加 `via=graph` 条目 |
| `tests/tools/search-vault.test.ts` | mock 改 `searchWithPool` 形状;追加扩邻用例 |
| `src/main.ts` | 构造 GraphExpander 注入 search_vault |
| `src/core/search-result-mapper.ts` | `SearchResultItem` 透传 `via` / `graphFrom` |
| `tests/core/search-result-mapper.test.ts` | 新建:via 透传 + 旧行为回归 |
| `src/types.ts` | `AgentEvent.search.result` payload 加可选字段 |
| `src/ui/chat/message-stream/types.ts` | `Message.searchResults` 条目加可选字段 |
| `src/ui/chat/message-stream/SearchResults.svelte` | 芯片「链接图」徽标 |
| `src/i18n/types.ts` / `zh.ts` / `en.ts` | `chat.cite.viaGraph` |
| `src/prompts/defaults/zh.ts` | rag.workflow + search_vault description 补图候选 |
| `docs/user-guide.md` / `README.md` / `README.zh-CN.md` | 行为与话术对齐 ADR-013 |
| `docs/architecture/overview.md` / `docs/architecture/rag/retriever.md` | 已在设计阶段落地(目录树 / §2.4+§3.4+§4 阶段 5 等),执行时核对 |
| `CHANGELOG.md` / `docs/superpowers/STATUS.md` | 发版记录 + 状态 |

---

### Task 1: GraphExpander 纯逻辑(hub 双向挡 + 去重 + 上限 + 候选池门槛)

**Files:**
- Create: `src/core/graph-expander.ts`
- Test: `tests/core/graph-expander.test.ts`

**Interfaces:**
- Consumes: `VaultPort.getLinks(path): NoteLinks`、`VaultPort.getBacklinks(path): Map<string, number>`(`src/ports/vault.ts`,同步)
- Produces:
  - `export const HUB_MAX_OUTGOING = 50` / `HUB_MAX_BACKLINKS = 100` / `DEFAULT_MAX_NEIGHBORS = 5`
  - `export interface GraphNeighbor { path: string; from: string }`
  - `export interface GraphExpandOptions { maxNeighbors?: number; allowedPaths?: ReadonlySet<string> }`
  - `export class GraphExpander { constructor(vault: VaultPort); expand(hits: Array<{ path: string }>, opts?: GraphExpandOptions): GraphNeighbor[] }`

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * @file tests/core/graph-expander.test.ts
 * @description GraphExpander 单元测试 — hub 过滤 / 去重 / 上限 / 候选池门槛 / 异常降级
 * @module tests/core/graph-expander
 */

import { describe, it, expect, vi } from 'vitest';
import {
	GraphExpander,
	HUB_MAX_OUTGOING,
	HUB_MAX_BACKLINKS,
	DEFAULT_MAX_NEIGHBORS,
	type GraphNeighbor,
} from '../../src/core/graph-expander';
import type { NoteLinks } from '../../src/ports/vault';

/** 构造 mock vault:出链表 + 反链数表 + 可指定抛错路径 */
function createMockVault(opts: {
	links?: Record<string, NoteLinks>;
	backlinks?: Record<string, number>;
	throwOn?: string[];
}) {
	const empty: NoteLinks = { outgoing: [], backlinks: [], unresolved: [] };
	return {
		getLinks: vi.fn((path: string) => {
			if (opts.throwOn?.includes(path)) throw new Error('metadataCache 未就绪');
			return opts.links?.[path] ?? empty;
		}),
		getBacklinks: vi.fn((path: string) => {
			const count = opts.backlinks?.[path] ?? 0;
			return new Map(Array.from({ length: count }, (_, i) => [`src-${i}.md`, 1]));
		}),
	};
}

function outgoing(...paths: string[]): NoteLinks['outgoing'] {
	return paths.map((path) => ({ path, count: 1 }));
}

function noteLinks(...paths: string[]): NoteLinks {
	return { outgoing: outgoing(...paths), backlinks: [], unresolved: [] };
}

describe('GraphExpander', () => {
	it('expand - 命中沿出链取邻居 - 返回带 from 标记的邻居', () => {
		const vault = createMockVault({ links: { 'a.md': noteLinks('b.md', 'c.md') } });
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'a.md' }])).toEqual([
			{ path: 'b.md', from: 'a.md' },
			{ path: 'c.md', from: 'a.md' },
		]);
	});

	it('expand - 邻居已在命中集中 - 去重跳过', () => {
		const vault = createMockVault({ links: { 'a.md': noteLinks('b.md', 'c.md') } });
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'a.md' }, { path: 'b.md' }])).toEqual([
			{ path: 'c.md', from: 'a.md' },
		]);
	});

	it('expand - 同一邻居被多个命中带出 - 只保留首个来源', () => {
		const vault = createMockVault({
			links: { 'a.md': noteLinks('x.md'), 'b.md': noteLinks('x.md') },
		});
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'a.md' }, { path: 'b.md' }])).toEqual([
			{ path: 'x.md', from: 'a.md' },
		]);
	});

	it('expand - 源命中出链超阈值(Daily hub) - 整源跳过', () => {
		const fanout = Array.from({ length: HUB_MAX_OUTGOING + 1 }, (_, i) => `n-${i}.md`);
		const vault = createMockVault({
			links: { 'daily/2026-08-03.md': noteLinks(...fanout) },
		});
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'daily/2026-08-03.md' }])).toEqual([]);
	});

	it('expand - 邻居反链超阈值 - 跳过该邻居', () => {
		const vault = createMockVault({
			links: { 'a.md': noteLinks('moc.md', 'b.md') },
			backlinks: { 'moc.md': HUB_MAX_BACKLINKS + 1 },
		});
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'a.md' }])).toEqual([{ path: 'b.md', from: 'a.md' }]);
	});

	it('expand - 邻居出链超阈值 - 跳过该邻居', () => {
		const fanout = Array.from({ length: HUB_MAX_OUTGOING + 1 }, (_, i) => `n-${i}.md`);
		const vault = createMockVault({
			links: { 'a.md': noteLinks('moc.md', 'b.md'), 'moc.md': noteLinks(...fanout) },
		});
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'a.md' }])).toEqual([{ path: 'b.md', from: 'a.md' }]);
	});

	it('expand - 邻居总数超上限 - 按命中顺序截断', () => {
		const vault = createMockVault({
			links: { 'a.md': noteLinks('n1.md', 'n2.md', 'n3.md'), 'b.md': noteLinks('n4.md', 'n5.md', 'n6.md') },
		});
		const expander = new GraphExpander(vault as never);
		const result = expander.expand([{ path: 'a.md' }, { path: 'b.md' }], { maxNeighbors: 4 });
		expect(result.map((n: GraphNeighbor) => n.path)).toEqual(['n1.md', 'n2.md', 'n3.md', 'n4.md']);
	});

	it('expand - 未传上限 - 默认不超过 DEFAULT_MAX_NEIGHBORS', () => {
		const many = Array.from({ length: DEFAULT_MAX_NEIGHBORS + 3 }, (_, i) => `n-${i}.md`);
		const vault = createMockVault({ links: { 'a.md': noteLinks(...many) } });
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'a.md' }])).toHaveLength(DEFAULT_MAX_NEIGHBORS);
	});

	it('expand - 提供 allowedPaths - 池外邻居淘汰池内保留', () => {
		const vault = createMockVault({ links: { 'a.md': noteLinks('in.md', 'out.md') } });
		const expander = new GraphExpander(vault as never);
		const result = expander.expand([{ path: 'a.md' }], { allowedPaths: new Set(['in.md']) });
		expect(result).toEqual([{ path: 'in.md', from: 'a.md' }]);
	});

	it('expand - 未提供 allowedPaths - 不做语义门槛全收', () => {
		const vault = createMockVault({ links: { 'a.md': noteLinks('b.md') } });
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'a.md' }])).toEqual([{ path: 'b.md', from: 'a.md' }]);
	});

	it('expand - getLinks 抛错 - 跳过该源不中断', () => {
		const vault = createMockVault({
			links: { 'b.md': noteLinks('x.md') },
			throwOn: ['a.md'],
		});
		const expander = new GraphExpander(vault as never);
		expect(expander.expand([{ path: 'a.md' }, { path: 'b.md' }])).toEqual([
			{ path: 'x.md', from: 'b.md' },
		]);
	});

	it('expand - 空命中 - 返回空数组', () => {
		const expander = new GraphExpander(createMockVault({}) as never);
		expect(expander.expand([])).toEqual([]);
	});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/graph-expander.test.ts`
Expected: FAIL(`Cannot find module '../../src/core/graph-expander'`)

- [ ] **Step 3: 实现 GraphExpander**

```typescript
/**
 * @file src/core/graph-expander.ts
 * @description 图谱 1 跳机会性扩邻 — 检索命中沿正文出链取邻居,hub 双向挡 + 候选池语义门槛(ADR-013)
 * @module core/graph-expander
 * @depends ports/vault
 */

import type { NoteLinks, VaultPort } from '../ports/vault';

/** 源命中出链数超过该值视为 hub(Daily / MOC 类),整源跳过扩邻 */
export const HUB_MAX_OUTGOING = 50;
/** 邻居出链或反链数超过该值视为 hub,不纳入扩邻集 */
export const HUB_MAX_BACKLINKS = 100;
/** 单次检索最多补充的图邻居数,防止上下文膨胀 */
export const DEFAULT_MAX_NEIGHBORS = 5;

/** 图扩邻产生的邻居条目 */
export interface GraphNeighbor {
	/** 邻居笔记路径(vault 相对路径) */
	path: string;
	/** 由哪条检索命中带出(vault 相对路径) */
	from: string;
}

/** 扩邻可选参数 */
export interface GraphExpandOptions {
	/** 邻居总数上限,默认 DEFAULT_MAX_NEIGHBORS */
	maxNeighbors?: number;
	/**
	 * 语义双通道门槛:仅接纳落在该集合内的邻居(链接提议,向量裁决)。
	 * 由 MultiQuerySearcher.searchWithPool 的 candidatePaths 提供;不传则不做语义门槛。
	 */
	allowedPaths?: ReadonlySet<string>;
}

/**
 * 图谱 1 跳扩邻器。
 *
 * 设计要点:
 * - 只读 metadataCache(getLinks / getBacklinks 均同步),不发 HTTP、不改索引。
 * - 三道过滤按成本从低到高:去重(seen)→ 语义门槛(allowedPaths)→ hub 判定(getLinks/getBacklinks)。
 * - hub 双向挡:源命中出链爆炸(Daily Plan 类)整源跳过;邻居本身是 hub 跳过。
 * - 双通道确认:邻居须同时被链接且在检索候选池内,挡「链了但语义无关」的边(ADR-013)。
 * - 降级:getLinks 异常跳过该源;宁少扩,不让检索失败。
 *
 * @example
 * const expander = new GraphExpander(vault);
 * const neighbors = expander.expand(hits, { allowedPaths: candidatePaths });
 */
export class GraphExpander {
	constructor(private vault: VaultPort) {}

	/**
	 * 从检索命中沿正文出链扩 1 跳邻居。
	 *
	 * @param hits - 检索命中(需含 path);顺序即优先级
	 * @param opts - 可选上限与候选池门槛
	 * @returns 去重 + 过滤后的邻居列表,最多 maxNeighbors 条
	 */
	expand(hits: Array<{ path: string }>, opts?: GraphExpandOptions): GraphNeighbor[] {
		const max = opts?.maxNeighbors ?? DEFAULT_MAX_NEIGHBORS;
		const seen = new Set(hits.map((h) => h.path));
		const out: GraphNeighbor[] = [];

		for (const hit of hits) {
			if (out.length >= max) break;
			let links: NoteLinks;
			try {
				links = this.vault.getLinks(hit.path);
			} catch {
				// 修复:metadataCache 异常不让检索失败 — 跳过该源
				continue;
			}
			// 关键路径:源命中出链扇出超阈值视为 Daily / MOC hub,整源跳过,
			// 避免把「今天打开过的一切」灌进上下文(ADR-013)。
			if (links.outgoing.length > HUB_MAX_OUTGOING) continue;

			for (const edge of links.outgoing) {
				if (out.length >= max) break;
				const target = edge.path;
				if (seen.has(target)) continue;
				// 关键路径:双通道确认(链接提议,向量裁决)— 池外邻居视为语义不相关,淘汰。
				if (opts?.allowedPaths && !opts.allowedPaths.has(target)) continue;
				if (this.isHub(target)) continue;
				seen.add(target);
				out.push({ path: target, from: hit.path });
			}
		}
		return out;
	}

	/**
	 * 邻居侧 hub 判定:出链或反链超阈值即视为 hub。
	 * 异常按 hub 处理(跳过)— 扩邻是增益,失败宁可不扩。
	 */
	private isHub(path: string): boolean {
		try {
			const links = this.vault.getLinks(path);
			if (links.outgoing.length > HUB_MAX_OUTGOING) return true;
			return this.vault.getBacklinks(path).size > HUB_MAX_BACKLINKS;
		} catch {
			return true;
		}
	}
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core/graph-expander.test.ts`
Expected: PASS(12 个用例)

- [ ] **Step 5: 提交**

```bash
git add src/core/graph-expander.ts tests/core/graph-expander.test.ts
git commit -m "feat(search): GraphExpander 1 跳扩邻 + hub 双向挡 + 候选池语义门槛"
```

---

### Task 2: MultiQuerySearcher.searchWithPool 暴露候选池

**Files:**
- Modify: `src/core/multi-query-searcher.ts`
- Modify: `tests/core/multi-query-searcher.test.ts`

**Interfaces:**
- Consumes: 既有 `docIdToResult`(Step 2 多查询循环产出)
- Produces:
  - `export interface SearchWithPoolResult { results: VectorSearchResult[]; candidatePaths: Set<string> }`
  - `searchWithPool(query: string, topK: number): Promise<SearchWithPoolResult>`(原 `search` 全部逻辑搬入)
  - `search(query, topK)` 保留签名,内部 `return (await this.searchWithPool(query, topK)).results;` — **存量 9 个测试不改**

- [ ] **Step 1: 追加失败测试**

在 `tests/core/multi-query-searcher.test.ts` 的 `describe('MultiQuerySearcher')` 内追加:

```typescript
	it('searchWithPool - 多查询 - 返回 results 与候选池 path 去重集', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'b.md#chunk-0', score: 0.8, metadata: { path: 'b.md', chunkIndex: 0 } },
			],
			[
				{ docId: 'a.md#chunk-0', score: 0.85, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'c.md#chunk-0', score: 0.7, metadata: { path: 'c.md', chunkIndex: 0 } },
			],
		]);
		const vault = createMockVault(async () => 'content');
		const queryRewriter = createMockQueryRewriter(['查询', '变体1']);

		const searcher = new MultiQuerySearcher({ embedding, workerManager: worker, vault, queryRewriter });
		const out = await searcher.searchWithPool('查询', 5);

		expect(out.results.length).toBeGreaterThanOrEqual(2);
		// 关键路径:候选池 = 各查询 topK*2 过度抓取结果的 path 去重(含未进最终 topK 的 c.md)
		expect(out.candidatePaths).toEqual(new Set(['a.md', 'b.md', 'c.md']));
	});

	it('searchWithPool - 候选条目缺 metadata.path - 跳过不计入池', async () => {
		const embedding = createMockEmbedding();
		const worker = createMockWorkerManager([
			[
				{ docId: 'a.md#chunk-0', score: 0.9, metadata: { path: 'a.md', chunkIndex: 0 } },
				{ docId: 'x#chunk-0', score: 0.8, metadata: {} },
			],
		]);
		const vault = createMockVault(async () => 'content');

		const searcher = new MultiQuerySearcher({ embedding, workerManager: worker, vault });
		const out = await searcher.searchWithPool('查询', 5);

		expect(out.candidatePaths).toEqual(new Set(['a.md']));
	});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/multi-query-searcher.test.ts`
Expected: 新用例 FAIL(`searcher.searchWithPool is not a function`);存量 9 个用例保持 PASS

- [ ] **Step 3: 实现 searchWithPool**

`src/core/multi-query-searcher.ts`,在 `MultiQuerySearcherDeps` 后追加类型:

```typescript
/** searchWithPool 返回形状:最终 topK 结果 + over-fetch 候选池 path 集 */
export interface SearchWithPoolResult {
	results: VectorSearchResult[];
	/** 候选池:各查询 topK*2 过度抓取结果的 metadata.path 去重集,供图谱扩邻做语义双通道确认 */
	candidatePaths: Set<string>;
}
```

把现有 `search(query, topK)` 方法**整体改名**为 `searchWithPool(query: string, topK: number): Promise<SearchWithPoolResult>`,做两处改动:

1. Step 2 多查询循环结束后、Step 3 RRF 之前,插入:

```typescript
		// --- Step 2.5: 候选池(供 GraphExpander 双通道确认) ---
		// 关键路径:池含未进最终 topK 的过度抓取条目 — 「链了但语义不沾边」的邻居因不在池内被淘汰。
		const candidatePaths = new Set<string>();
		for (const r of docIdToResult.values()) {
			const path = r.metadata?.path;
			if (typeof path === 'string') candidatePaths.add(path);
		}
```

2. 方法末尾 `return finalResults;` 改为:

```typescript
		return { results: finalResults, candidatePaths };
```

3. 类内追加薄包装(保持旧签名):

```typescript
	/**
	 * 多查询混合搜索 + RRF 融合 + 可选 Rerank 精排。
	 *
	 * @param query - 用户原始查询(单条,内部决定是否改写)。
	 * @param topK - 返回文档上限。
	 * @returns 文档级结果(含 index 由 search_vault 工具层填,本方法不填)。
	 */
	async search(query: string, topK: number): Promise<VectorSearchResult[]> {
		return (await this.searchWithPool(query, topK)).results;
	}
```

并更新 `searchWithPool` 的 JSDoc(从原 `search` 搬来 + 补 `@returns` 说明 candidatePaths)。

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run tests/core/multi-query-searcher.test.ts`
Expected: PASS(存量 9 + 新增 2 = 11 个用例)

- [ ] **Step 5: 提交**

```bash
git add src/core/multi-query-searcher.ts tests/core/multi-query-searcher.test.ts
git commit -m "feat(search): MultiQuerySearcher.searchWithPool 暴露候选池供双通道确认"
```

---

### Task 3: search_vault 接入扩邻 + main 接线

**Files:**
- Modify: `src/tools/search-vault.ts`
- Modify: `tests/tools/search-vault.test.ts`
- Modify: `src/main.ts`(约 399-405 行 `createSearchVaultTool` 调用处)

**Interfaces:**
- Consumes: Task 1 `GraphExpander` / `GraphNeighbor`;Task 2 `searchWithPool` / `candidatePaths`
- Produces: `createSearchVaultTool(searcher, getSearchReady, definition, vault, graphExpander?)` — 第 5 参可选;返回结果尾部追加形状:
  `{ docId: 'graph:<path>', score: 源score*0.8, index: 续编号, reranked: false, metadata: { path, tags, backlinkCount, via: 'graph', graphFrom } }`

- [ ] **Step 1: 改 mock 形状 + 追加失败测试**

`tests/tools/search-vault.test.ts` 的 `createMockSearcher` 改为返回 `searchWithPool` 形状:

```typescript
function createMockSearcher(results: VectorSearchResult[], candidatePaths: Set<string> = new Set()) {
	return {
		searchWithPool: vi.fn().mockResolvedValue({ results, candidatePaths }),
	};
}
```

存量断言机械替换(共 3 处):`searcher.search` → `searcher.searchWithPool`(两次 `toHaveBeenCalledWith`、一次 `not.toHaveBeenCalled`)。

在 `describe('createSearchVaultTool')` 内追加:

```typescript
	it('search_vault - 有扩邻 - 尾部追加 via=graph 邻居且 index 续编号', async () => {
		const searcher = createMockSearcher(
			[{ docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 }, reranked: true }],
			new Set(['notes/project.md', 'notes/neighbor.md']),
		);
		const graphExpander = {
			expand: vi.fn().mockReturnValue([{ path: 'notes/neighbor.md', from: 'notes/project.md' }]),
		};
		const tool = createSearchVaultTool(
			searcher as never, () => true, makeToolDef('search_vault'), createMockVault() as never, graphExpander as never,
		);
		const result = await tool.execute({ query: '技术栈', topK: 5 });

		// 关键路径:扩邻入参为命中 path 列表 + 候选池(双通道确认)
		expect(graphExpander.expand).toHaveBeenCalledWith(
			[{ path: 'notes/project.md' }],
			{ allowedPaths: new Set(['notes/project.md', 'notes/neighbor.md']) },
		);
		expect(result).toHaveLength(2);
		expect(result[1]).toEqual({
			docId: 'graph:notes/neighbor.md',
			// 关键路径:邻居分数 = 源命中 0.95 * 衰减 0.8
			score: 0.95 * 0.8,
			index: 2,
			reranked: false,
			metadata: {
				path: 'notes/neighbor.md',
				tags: [],
				backlinkCount: 0,
				via: 'graph',
				graphFrom: 'notes/project.md',
			},
		});
	});

	it('search_vault - 扩邻抛错 - 返回纯检索结果不中断', async () => {
		const searcher = createMockSearcher([
			{ docId: 'notes/project.md#chunk-0', score: 0.95, metadata: { path: 'notes/project.md', chunkIndex: 0 }, reranked: true },
		]);
		const graphExpander = {
			expand: vi.fn(() => { throw new Error('metadataCache 异常'); }),
		};
		const tool = createSearchVaultTool(
			searcher as never, () => true, makeToolDef('search_vault'), createMockVault() as never, graphExpander as never,
		);
		const result = await tool.execute({ query: '技术栈', topK: 5 });
		// 关键路径:不劣化 — 结果与无扩邻时一致
		expect(result).toHaveLength(1);
		expect(result[0]!.metadata.via).toBeUndefined();
	});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/tools/search-vault.test.ts`
Expected: FAIL(工具仍调 `search`,且第 5 参被忽略)

- [ ] **Step 3: 改造 search-vault.ts**

头部 import 追加:

```typescript
import type { GraphExpander, GraphNeighbor } from '../core/graph-expander';
```

常量区(`DEFAULT_TOP_K` 后)追加:

```typescript
// 邻居分数衰减系数:保证 via=graph 条目排序上低于检索命中。
const GRAPH_SCORE_DECAY = 0.8;
```

`createSearchVaultTool` 签名加第 5 参,JSDoc 补 `@param graphExpander - 可选图谱扩邻器;命中后沿正文出链补 1 跳邻居(ADR-013)`,文件头 `@description` 中的「多查询混合搜索 + RRF + 可选 Rerank」表述后补「+ 图谱 1 跳扩邻」:

```typescript
export function createSearchVaultTool(
	searcher: MultiQuerySearcher,
	getSearchReady: () => boolean,
	definition: ToolDefinition,
	vault: VaultPort,
	graphExpander?: GraphExpander,
): Tool {
```

`execute` 内改两处:

① 调用改为 `searchWithPool`:

```typescript
			// 关键路径:searchWithPool 额外返回候选池,供图谱扩邻做双通道确认(链接提议,向量裁决)。
			const { results, candidatePaths } = await searcher.searchWithPool(query, topK);
```

② `return results.map(...)` 整段改为(既有 map 逻辑原样搬入 `enriched`,之后接扩邻):

```typescript
			// 关键路径:索引结果可能滞后于当前笔记元数据,返回时从 metadataCache 补充实时结构信号。
			const enriched = results.map((r, i) => {
				const path = typeof r.metadata.path === 'string' ? r.metadata.path : undefined;
				const metadata = path ? vault.getMetadata(path) : null;
				const tags = collectTags(metadata);
				const backlinkCount = path ? vault.getBacklinks(path).size : 0;

				return {
					...r,
					// 关键路径:加 index 编号(从 1 开始),供 LLM 用 [1][2] 引用。
					// reranked 由 MultiQuerySearcher 填充,这里透传不覆盖。
					index: i + 1,
					metadata: {
						...r.metadata,
						tags,
						backlinkCount,
					},
				};
			});

			// --- 图谱 1 跳机会性扩邻(ADR-013) ---
			if (!graphExpander || enriched.length === 0) return enriched;

			const hits = enriched
				.map((r) => (typeof r.metadata.path === 'string' ? { path: r.metadata.path } : null))
				.filter((h): h is { path: string } => h !== null);

			let neighbors: GraphNeighbor[];
			try {
				neighbors = graphExpander.expand(hits, { allowedPaths: candidatePaths });
			} catch {
				// 关键路径:扩邻异常不劣化检索 — 返回纯检索结果。
				return enriched;
			}
			if (neighbors.length === 0) return enriched;

			const baseIndex = enriched.length;
			return [
				...enriched,
				...neighbors.map((n, j) => {
					const metadata = vault.getMetadata(n.path);
					const parentScore = enriched.find((r) => r.metadata.path === n.from)?.score ?? 0;
					return {
						docId: `graph:${n.path}`,
						// 关键路径:邻居分数 = 源命中分数 * 衰减,保证排序上低于检索命中。
						score: parentScore * GRAPH_SCORE_DECAY,
						// 关键路径:index 续编号 — 图邻居与检索命中共享同一 [n] 引用空间。
						index: baseIndex + j + 1,
						reranked: false,
						metadata: {
							path: n.path,
							tags: collectTags(metadata),
							backlinkCount: vault.getBacklinks(n.path).size,
							// 关键路径:via / graphFrom 供 UI 标注「链接图」与模型理解来源。
							via: 'graph' as const,
							graphFrom: n.from,
						},
					};
				}),
			];
```

- [ ] **Step 4: main.ts 接线**

`src/main.ts` import 区追加:

```typescript
import { GraphExpander } from './core/graph-expander';
```

`createSearchVaultTool` 调用处(约 399-405 行)加第 5 参:

```typescript
		this.tools.register(
			createSearchVaultTool(
				multiQuerySearcher,
				() => isSearchReady(get(this.userStatus.statusBar$)),
				toolDefMap.get('search_vault')!,
				this.vault,
				// 图谱 1 跳扩邻(ADR-013):只读 metadataCache + 候选池,无 HTTP
				new GraphExpander(this.vault),
			),
		);
```

- [ ] **Step 5: 跑测试确认通过 + src 编译**

Run: `npx vitest run tests/tools/search-vault.test.ts && npx tsc --noEmit --skipLibCheck -p tsconfig.json 2>&1 | rg -v "^tests/" || true`
Expected: 测试 PASS(存量 6 改 mock 后全绿 + 新增 2);src 无新增类型错误(tests/ 基线错误忽略)

- [ ] **Step 6: 提交**

```bash
git add src/tools/search-vault.ts tests/tools/search-vault.test.ts src/main.ts
git commit -m "feat(search): search_vault 命中后 via=graph 1 跳扩邻(双通道确认)"
```

---

### Task 4: via 透传链路 + 引用芯片「链接图」徽标

**Files:**
- Modify: `src/core/search-result-mapper.ts`
- Create: `tests/core/search-result-mapper.test.ts`
- Modify: `src/types.ts`(`search.result` payload,约 41-50 行)
- Modify: `src/ui/chat/message-stream/types.ts`(`Message.searchResults`,第 49 行)
- Modify: `src/ui/chat/message-stream/SearchResults.svelte`
- Modify: `src/i18n/types.ts` / `zh.ts` / `en.ts`

**Interfaces:**
- Consumes: Task 3 的 `metadata.via` / `metadata.graphFrom`
- Produces: `SearchResultItem { docId; score; path; index; via?: 'graph'; graphFrom?: string }`;i18n key `chat.cite.viaGraph`

- [ ] **Step 1: 写 mapper 测试(新建)**

```typescript
/**
 * @file tests/core/search-result-mapper.test.ts
 * @description mapSearchResults — via/graphFrom 透传与扁平化回归
 * @module tests/core/search-result-mapper
 */

import { describe, it, expect } from 'vitest';
import { mapSearchResults } from '../../src/core/search-result-mapper';

describe('mapSearchResults', () => {
	it('mapSearchResults - 检索命中 - 扁平化且不携带 via', () => {
		const mapped = mapSearchResults([
			{ docId: 'a.md#0', score: 0.9, metadata: { path: 'a.md' }, index: 1, reranked: true },
		]);
		expect(mapped).toEqual({
			results: [{ docId: 'a.md#0', score: 0.9, path: 'a.md', index: 1 }],
			reranked: true,
		});
	});

	it('mapSearchResults - via=graph 邻居 - 透传 via 与 graphFrom', () => {
		const mapped = mapSearchResults([
			{ docId: 'a.md#0', score: 0.9, metadata: { path: 'a.md' }, index: 1 },
			{
				docId: 'graph:b.md',
				score: 0.72,
				metadata: { path: 'b.md', via: 'graph', graphFrom: 'a.md' },
				index: 2,
			},
		]);
		expect(mapped?.results).toEqual([
			{ docId: 'a.md#0', score: 0.9, path: 'a.md', index: 1 },
			{ docId: 'graph:b.md', score: 0.72, path: 'b.md', index: 2, via: 'graph', graphFrom: 'a.md' },
		]);
	});

	it('mapSearchResults - 非数组 - 返回 null', () => {
		expect(mapSearchResults('nope')).toBeNull();
	});

	it('mapSearchResults - 全部缺 path - 返回 null', () => {
		expect(mapSearchResults([{ docId: 'x', score: 1, metadata: {}, index: 1 }])).toBeNull();
	});
});
```

- [ ] **Step 2: 跑测试确认 via 用例失败**

Run: `npx vitest run tests/core/search-result-mapper.test.ts`
Expected: 第 2 个用例 FAIL(via 字段未透传)

- [ ] **Step 3: 改 mapper + 类型**

`src/core/search-result-mapper.ts`:

```typescript
/** 扁平化后的单条搜索结果(UI 友好,无嵌套 metadata) */
export interface SearchResultItem {
	docId: string;
	score: number;
	path: string;
	index: number;
	/** 'graph' = 经链接图补充的邻居(ADR-013);undefined = 检索命中 */
	via?: 'graph';
	/** via=graph 时,记录由哪条命中笔记带出 */
	graphFrom?: string;
}

/** search_vault 原始结果的条目形状(含嵌套 metadata) */
interface RawSearchResult {
	docId: string;
	score: number;
	metadata: { path?: string; via?: string; graphFrom?: string };
	index: number;
	reranked?: boolean;
}
```

`mapSearchResults` 的 `.map(...)` 改为:

```typescript
		.map((r) => ({
			docId: r.docId,
			score: r.score,
			path: r.metadata.path as string,
			index: r.index,
			// 关键路径:via=graph 由 search_vault 扩邻填充,透传给 UI 标注来源。
			...(r.metadata.via === 'graph'
				? { via: 'graph' as const, graphFrom: r.metadata.graphFrom }
				: {}),
		}));
```

`src/types.ts` `search.result` payload 的 results 条目类型改为:

```typescript
			results: Array<{
				docId: string;
				score: number;
				path: string;
				index: number;
				/** 'graph' = 经链接图补充的邻居;undefined = 检索命中 */
				via?: 'graph';
				/** via=graph 时,记录由哪条命中笔记带出 */
				graphFrom?: string;
			}>;
```

`src/ui/chat/message-stream/types.ts` 第 49 行 `Message.searchResults` 改为:

```typescript
	searchResults?: Array<{
		docId: string;
		score: number;
		path: string;
		index: number;
		/** 'graph' = 经链接图补充的邻居;undefined = 检索命中 */
		via?: 'graph';
		/** via=graph 时,记录由哪条命中笔记带出 */
		graphFrom?: string;
	}>;
```

- [ ] **Step 4: i18n + 芯片徽标**

`src/i18n/types.ts` ChatStrings(与 `chat.cite.openNote` 同区)增加:

```typescript
'chat.cite.viaGraph': string;
```

`zh.ts`: `'chat.cite.viaGraph': '链接图',`
`en.ts`: `'chat.cite.viaGraph': 'via graph',`

`src/ui/chat/message-stream/SearchResults.svelte` props 类型改为:

```typescript
		results: Array<{ docId: string; score: number; path: string; index: number; via?: 'graph'; graphFrom?: string }>;
```

chip 模板(第 48-50 行区域)改为:

```svelte
						<span class="ratel-cite-chip-n">{r.index}</span>
						<span class="ratel-cite-chip-path">{formatCitePath(r.path)}</span>
						{#if r.via === 'graph'}
							<span class="ratel-cite-chip-graph">{$t('chat.cite.viaGraph')}</span>
						{/if}
```

`<style>` 内追加:

```css
	.ratel-cite-chip-graph {
		flex-shrink: 0;
		padding: 0 5px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--ratel-cite, var(--interactive-accent)) 45%, transparent);
		color: var(--ratel-cite, var(--interactive-accent));
		font-size: 10px;
		line-height: 1.5;
	}
```

- [ ] **Step 5: 跑测试 + 编译**

Run: `npx vitest run tests/core/search-result-mapper.test.ts && npx tsc --noEmit --skipLibCheck -p tsconfig.json 2>&1 | rg -v "^tests/" || true`
Expected: PASS;src 无新增类型错误

- [ ] **Step 6: 提交**

```bash
git add src/core/search-result-mapper.ts tests/core/search-result-mapper.test.ts src/types.ts src/ui/chat/message-stream/types.ts src/ui/chat/message-stream/SearchResults.svelte src/i18n/types.ts src/i18n/zh.ts src/i18n/en.ts
git commit -m "feat(search): 引用芯片标注 via=graph 链接图邻居"
```

---

### Task 5: Prompt 补图候选说明(单源 zh.ts)

**Files:**
- Modify: `src/prompts/defaults/zh.ts`(`agent.rag.workflow` 约 14-19 行;`tool.search_vault.description` 约 107-108 行)

**Interfaces:**
- Consumes: Task 3 的结果形状(`metadata.via='graph'`)
- Produces: 模型知道图邻居与检索命中同等引用

- [ ] **Step 1: 改 rag.workflow**

```typescript
	'agent.rag.workflow': `回答知识库问题时,按以下流程:
1. 调用 search_vault 查找相关笔记(结果带 index 编号;编号靠后的条目可能是经链接图补充的邻居笔记,metadata.via 为 graph,与检索命中同等对待)。
2. 对有价值的结果调用 read_note 读全文。
3. 凡依据检索结论的句子,句末必须写 [n](与 search_vault 返回的 index 一致);禁止只用文件名或表格代替 [n] 作为唯一引用方式。
4. 同一回合若多次调用 search_vault,只用最后一次返回的 index。
5. 若无结果,如实告知。`,
```

- [ ] **Step 2: 改 search_vault description**

```typescript
	'tool.search_vault.description':
		'在知识库中搜索与查询相关的笔记。使用多查询混合检索(向量+BM25)与可选重排,并沿正文链接补充 1 跳邻居(metadata.via 为 graph);返回带 index 编号的结果;用 read_note 读取全文。回答时用返回的 index 写成 [n] 引用。',
```

- [ ] **Step 3: 编译确认**

Run: `npx tsc --noEmit --skipLibCheck -p tsconfig.json 2>&1 | rg -v "^tests/" || true`
Expected: src 无新增类型错误

- [ ] **Step 4: 提交**

```bash
git add src/prompts/defaults/zh.ts
git commit -m "feat(search): prompt 告知模型 via=graph 图邻居同等引用"
```

---

### Task 6: 文档 + ARCHITECTURE + CHANGELOG + STATUS

**Files:**
- Modify: `docs/user-guide.md`(§3 表格第 48 行)
- Modify: `README.md`(第 60 行)/ `README.zh-CN.md`(第 60 行)
- Modify: `docs/architecture/overview.md` / `docs/architecture/rag/retriever.md`(已在设计阶段落地,执行时核对)
- Modify: `CHANGELOG.md` `[Unreleased]`
- Modify: `docs/superpowers/STATUS.md`

- [ ] **Step 1: user-guide**

第 48 行改为:

```markdown
| 查主题 | 「我写过哪些性能优化相关笔记？」 | `search_vault`(命中后顺正文链接补 1 跳邻居,需过语义候选池;日记 / MOC 类枢纽默认跳过)→ 引用 `[1][2]` → 可点开原文 |
```

- [ ] **Step 2: README 能力行**

`README.md` 第 60 行改为:

```markdown
- Semantic search + 1-hop link expansion (no manual curation required), with clickable citations (`[n]` in the reply and note chips)
```

`README.zh-CN.md` 第 60 行改为:

```markdown
- 语义检索 + 沿双链 1 跳补邻(无需先整理库),正文 `[n]` / 芯片可点开出处
```

- [ ] **Step 3: overview.md + retriever.md + tools.md(已在设计阶段落地,执行时核对)**

本 plan 批准时已改好(旧 `docs/ARCHITECTURE.md` 已合并进 `docs/architecture/overview.md` 并删除),执行时 `rg` 核对即可,无需重做:

```bash
rg -n "graph-expander|searchWithPool" docs/architecture/overview.md
rg -n "3.4 图谱|双通道|via=graph|searchWithPool" docs/architecture/rag/retriever.md
rg -n "GraphExpander|via=graph|searchWithPool" docs/architecture/agent/tools.md
```

Expected: overview.md 命中 §5 目录树 3 处 + §6 RAG 链路步骤第 12 行「图谱扩邻」;retriever.md 命中头部链路、§2.4、§3.4、§4 阶段 5、§5、§6 边界行;tools.md 命中 §4.1。若实施与契约出现偏差(如阈值改名),以实施为准回改这三份文档。

- [ ] **Step 4: CHANGELOG `[Unreleased]`**

```markdown
### Added
- **检索会顺着链接多走一步** — 命中笔记后自动带出它正文链接的最多 5 篇邻居作为补充候选(需同时通过语义筛选;引用芯片标「链接图」);日记 / MOC 这类链接枢纽默认不参与,不整理库也能用
```

- [ ] **Step 5: 回归命令**

```bash
npx vitest run tests/core/graph-expander.test.ts tests/core/search-result-mapper.test.ts tests/core/multi-query-searcher.test.ts tests/tools/search-vault.test.ts
npx tsc --noEmit --skipLibCheck -p tsconfig.json 2>&1 | rg -v "^tests/" || true
```

Expected: 全 PASS;src 无新增类型错误

- [ ] **Step 6: STATUS**

将 P-GRAPH-EXPAND 标为 `✅ Completed`,备注分支名;S-GRAPH-EXPAND 保持 Active(中期弱边 / 远期 GraphRAG 未做)。

- [ ] **Step 7: 提交**

```bash
git add docs/user-guide.md README.md README.zh-CN.md CHANGELOG.md docs/superpowers/STATUS.md
git commit -m "docs: 图谱扩邻用户文档与架构文档对齐 ADR-013"
```

---

## Spec 覆盖自检

| Spec 要求 | Task |
|---|---|
| 默认试 1 跳扩邻 | Task 1 + 3 |
| 双通道确认(链接提议,向量裁决) | Task 1(allowedPaths)+ Task 2(candidatePaths)+ Task 3(接线) |
| hub / Daily 默认挡(源 + 邻居双向) | Task 1 |
| 零配置、失败不劣化 | Task 1(异常降级)+ Task 3(try/catch 兜底) |
| 引用可见图参与(`via` / 芯片标注) | Task 4 |
| 引用编号同一空间 | Task 3(续编号)+ Task 5(prompt) |
| 存量 searcher 测试零破坏 | Task 2(薄包装) |
| user-guide / README / ARCHITECTURE / CHANGELOG | Task 6 |
| 不改 MemoryStore / 索引 schema / 读工具 | 全 plan 约束 |

## Placeholder 扫描

无 TBD;阈值常量(50 / 100 / 5 / 0.8)与双通道机制已钉死;prompt 无 en 副本已注明;所有代码步骤含完整代码。

---

## 执行方式

Plan 已保存。两种执行选项:

1. **Subagent-Driven(推荐)** — 每 Task 新 subagent,两阶段审查
2. **Inline Execution** — 本会话按 executing-plans 连续做

要哪种?
