# S-SHARDED-INDEX 分片向量索引实施计划

> **面向执行 Agent：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实施。步骤用 `- [ ]` 跟踪。先写失败用例，确认红灯，再实现，再跑绿，再提交。

**目标：** 把唯一一份 `index.json` 拆成自适应分片，每次提交只重写目标分片，查询时片内扫描 + 跨片 k 路归并输出单一有序 `topK`；不做物理合并。

**架构：** 新增分片路由与片数计算纯函数；在 vectra 存储外新增一层分片存储适配器，对上层保持与现有 `VectraStore` 相同的方法语义；代际目录下新增 `shards/<hh>/` 与 `shards/layout.json`；旧单份布局在启动时一次性拆分，不重新嵌入。

**技术栈：** TypeScript（strict）、vectra 本地索引、Vitest、esbuild、Node `node:fs/promises`。

**关联：** 设计见 [S-SHARDED-INDEX](../specs/2026-11-04-sharded-index.md)。需求 `BUG-1-INDEX-PERF-001`。

---

## 文件结构

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/core/index-shard-routing.ts` | 新建 | 片数计算 `shardCountForBlocks`、路径到分片 `shardIdForPath`、分片目录名。纯函数，无 IO |
| `src/adapters/vector-vectra-sharded.ts` | 新建 | 分片存储适配器：持有 N 个 `VectraStore`，按路径路由读写，跨片查询归并，批量按片分组 |
| `src/adapters/vector-vectra.ts` | 修改 | 暴露 `VectraStore` 构造所需的最小接口（已有），补 `inspectFiles` 的空数组快速返回 |
| `src/core/index-shard-migration.ts` | 新建 | 旧单份 `index.json` → 分片的检测、拆分、校验、原子切换、失败回滚 |
| `src/worker/index-runtime-session.ts` | 修改 | 装配分片存储（替换 `createStore` 调用），片数来自布局元数据 |
| `src/core/index-runtime-assembly.ts`、`src/core/index-thread-assembly.ts` | 修改 | 主线程与线程装配都使用分片存储，保证两条路径同一语义 |
| `tests/core/index-shard-routing.test.ts` | 新建 | 片数/路由纯函数用例 |
| `tests/adapters/vector-vectra-sharded.test.ts` | 新建 | 分片写、批量分组、删除隔离、跨片查询一致性与失败传播 |
| `tests/core/index-shard-migration.test.ts` | 新建 | 迁移成功、幂等、失败回滚、零嵌入 |
| `tests/core/index-shard-recovery.test.ts` | 新建 | 分片写入中断后的恢复语义 |

命名约定沿用仓库：中文注释、中文用例名、错误走 `IndexValidationError`/`IndexFileJournalError` 既有类型。

---

### Task 1: 分片数与路径路由（纯函数）

**Files:**
- Create: `src/core/index-shard-routing.ts`
- Test: `tests/core/index-shard-routing.test.ts`

- [x] **Step 1: 写失败用例**

```ts
// tests/core/index-shard-routing.test.ts
import { describe, expect, it } from 'vitest';
import { shardCountForBlocks, shardIdForPath, shardDirectoryName, MIN_SHARDS, MAX_SHARDS } from '../../src/core/index-shard-routing';

describe('分片路由', () => {
	it('片数按块数自适应 - 下限 8 上限 64', () => {
		expect(shardCountForBlocks(0)).toBe(MIN_SHARDS);
		expect(shardCountForBlocks(1_500)).toBe(MIN_SHARDS);
		expect(shardCountForBlocks(19_784)).toBe(16);
		expect(shardCountForBlocks(80_000)).toBe(MAX_SHARDS);
		expect(shardCountForBlocks(10_000_000)).toBe(MAX_SHARDS);
	});

	it('片数只取 2 的幂且单调不减', () => {
		let previous = 0;
		for (const blocks of [0, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536]) {
			const count = shardCountForBlocks(blocks);
			expect(Number.isInteger(Math.log2(count))).toBe(true);
			expect(count).toBeGreaterThanOrEqual(previous);
			previous = count;
		}
	});

	it('同一路径永远落在同一片 - 与片数无关地稳定', () => {
		const path = '玄幻中篇/妖市-第6章.md';
		const ids = new Set([8, 16, 32, 64].map((count) => shardIdForPath(path, count)));
		expect(ids.size).toBeLessThanOrEqual(4);
		for (const count of [8, 16, 32, 64]) {
			expect(shardIdForPath(path, count)).toBe(shardIdForPath(path, count));
			expect(shardIdForPath(path, count)).toBeLessThan(count);
		}
	});

	it('分片按内容分布 - 一千个路径覆盖多数分片', () => {
		const seen = new Set<number>();
		for (let index = 0; index < 1_000; index += 1) seen.add(shardIdForPath(`notes/note-${index}.md`, 16));
		expect(seen.size).toBe(16);
	});

	it('目录名为两位十六进制 - 与片号一一对应', () => {
		expect(shardDirectoryName(0)).toBe('00');
		expect(shardDirectoryName(10)).toBe('0a');
		expect(shardDirectoryName(15)).toBe('0f');
	});
});
```

- [x] **Step 2: 跑用例确认红灯**

Run: `./node_modules/.bin/vitest run tests/core/index-shard-routing.test.ts`
Expected: FAIL，提示无法解析 `../../src/core/index-shard-routing`。

- [x] **Step 3: 实现**

```ts
// src/core/index-shard-routing.ts
import { createHash } from 'node:crypto';

/** 分片数下限 — 小库用更少分片,避免扇出与文件数压过收益。 */
export const MIN_SHARDS = 8;
/** 分片数上限 — 再大时查询扇出与文件数代价高过分片收益。 */
export const MAX_SHARDS = 64;
/** 每片目标块数 — 决定片数的主要输入。 */
const BLOCKS_PER_SHARD = 2_048;

/**
 * 按总块数计算分片数:2 的幂,夹在 [MIN_SHARDS, MAX_SHARDS]。
 *
 * 关键路径:片数只影响存储布局,不参与配置指纹;改片数通过重分布完成,不重嵌入。
 */
export function shardCountForBlocks(totalBlocks: number): number {
	const safeBlocks = Number.isFinite(totalBlocks) && totalBlocks > 0 ? totalBlocks : 0;
	const wanted = Math.ceil(safeBlocks / BLOCKS_PER_SHARD);
	let count = MIN_SHARDS;
	while (count < MAX_SHARDS && count < wanted) count *= 2;
	return Math.min(MAX_SHARDS, count);
}

/**
 * 路径到分片号:取 sha256 首字节对片数取模。
 *
 * 关键路径:与 journal 的 pathHash 同源,保证同一路径的所有块永远落在同一片,
 * 删除/替换不需要跨片扫描。
 */
export function shardIdForPath(relativePath: string, shardCount: number): number {
	if (!Number.isInteger(shardCount) || shardCount <= 0) {
		throw new Error(`分片数必须是正整数:${shardCount}`);
	}
	const digest = createHash('sha256').update(relativePath, 'utf8').digest();
	return digest[0]! % shardCount;
}

/** 分片目录名 — 两位小写十六进制。 */
export function shardDirectoryName(shardId: number): string {
	return shardId.toString(16).padStart(2, '0');
}
```

- [x] **Step 4: 跑用例确认绿灯**

Run: `./node_modules/.bin/vitest run tests/core/index-shard-routing.test.ts`
Expected: PASS 5 例。

- [x] **Step 5: 提交**

```bash
git add src/core/index-shard-routing.ts tests/core/index-shard-routing.test.ts
git commit -m "feat: 分片数与路径路由纯函数"
```

---

### Task 2: 分片存储适配器（写入侧）

**Files:**
- Create: `src/adapters/vector-vectra-sharded.ts`
- Test: `tests/adapters/vector-vectra-sharded.test.ts`

现有接口（实施时以 `src/adapters/vector-vectra.ts` 为准）：`init()`、`status()`、`search(queryVector, topK, filter?)`、`deleteByPath(path)`、`replaceFile({path, commitId, blocks})`、`inspectFile(path)`、`inspectFiles(paths)`、`beginWriteBatch()`、`endWriteBatch()`、`abortWriteBatch()`。

- [x] **Step 1: 写失败用例**

```ts
// tests/adapters/vector-vectra-sharded.test.ts
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShardedStore } from '../../src/adapters/vector-vectra-sharded';

const roots: string[] = [];
afterEach(async () => {
	while (roots.length > 0) await import('node:fs/promises').then((m) => m.rm(roots.pop()!, { recursive: true, force: true }));
});

const DIMENSIONS = 4;

function block(id: string, vector: number[]) {
	return { id, vector, metadata: { path: id.split('#')[0]!, commitId: 'c1', revision: 1, docId: id, documentId: id } };
}

async function makeStore(shardCount: number) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'ratel-shard-'));
	roots.push(root);
	const store = createShardedStore({ root, shardCount, dimensions: DIMENSIONS });
	await store.init();
	return { root, store, shardCount };
}

describe('分片存储 - 写入隔离', () => {
	it('两个不同分片的路径 - 只写各自分片 - 互不改写', async () => {
		const { root, store, shardCount } = await makeStore(8);
		await store.replaceFile({ path: 'a.md', commitId: 'c1', blocks: [block('a.md#0', [1, 0, 0, 0])] });
		const shardOfA = store.shardIdOf('a.md');
		let shardOfB = store.shardIdOf('b.md');
		if (shardOfB === shardOfA) shardOfB = (shardOfA + 1) % shardCount;
		const target = `b-${shardOfB}.md`;
		await store.replaceFile({ path: target, commitId: 'c1', blocks: [block(`${target}#0`, [0, 1, 0, 0])] });

		const aFile = path.join(root, 'shards', store.shardDirectoryOf(shardOfA), 'index.json');
		const bFile = path.join(root, 'shards', store.shardDirectoryOf(shardOfB), 'index.json');
		const aBefore = await stat(aFile);
		await store.replaceFile({ path: target, commitId: 'c2', blocks: [block(`${target}#0`, [0, 1, 1, 0])] });
		const aAfter = await stat(aFile);
		expect(aAfter.mtimeMs).toBe(aBefore.mtimeMs);
		expect((await stat(bFile)).size).toBeGreaterThan(0);
	});

	it('批量写入 - 按分片分组 - 每片最多一次落盘', async () => {
		const { store } = await makeStore(4);
		const paths = ['p0.md', 'p1.md', 'p2.md', 'p3.md', 'p4.md', 'p5.md'];
		let writes = 0;
		const counting = Object.create(store) as typeof store;
		const original = store.endWriteBatch.bind(store);
		store.endWriteBatch = async () => { writes += 1; await original(); };
		await store.beginWriteBatch();
		for (const p of paths) await store.replaceFile({ path: p, commitId: 'c1', blocks: [block(`${p}#0`, [1, 1, 0, 0])] });
		await store.endWriteBatch();
		expect(writes).toBe(1);
		expect((await store.inspectFiles(paths)).size).toBe(paths.length);
		void counting;
	});

	it('删除路径 - 只影响该路径所在分片', async () => {
		const { store } = await makeStore(8);
		await store.replaceFile({ path: 'x.md', commitId: 'c1', blocks: [block('x.md#0', [1, 0, 0, 0])] });
		await store.replaceFile({ path: 'y.md', commitId: 'c1', blocks: [block('y.md#0', [0, 1, 0, 0])] });
		expect(await store.deleteByPath('x.md')).toBe(1);
		expect((await store.inspectFile('x.md'))).toHaveLength(0);
		expect((await store.inspectFile('y.md'))).toHaveLength(1);
	});
});
```

- [x] **Step 2: 跑用例确认红灯**

Run: `./node_modules/.bin/vitest run tests/adapters/vector-vectra-sharded.test.ts`
Expected: FAIL，无法解析 `vector-vectra-sharded`。

- [x] **Step 3: 实现**

```ts
// src/adapters/vector-vectra-sharded.ts
import path from 'node:path';
import { shardCountForBlocks, shardDirectoryName, shardIdForPath } from '../core/index-shard-routing';
import { createStore, type FileReplacement, type IndexStatus, type PreparedBlock, type VectorSearchResult } from './vector-vectra';
import type { AtomicIndexStorage } from './atomic-index-storage';

export interface ShardedStoreOptions {
	root: string;
	shardCount?: number;
	totalBlocks?: number;
	dimensions: number;
	createStorage?: (root: string) => AtomicIndexStorage;
}

/**
 * 分片向量存储:按路径哈希路由到 N 个独立本地索引。
 *
 * 关键路径:写入只碰目标分片,单次写入体积约为全库 1/N;
 * 查询遍历全部分片各取 topK 后做 k 路归并,对调用方仍是一份有序结果。
 */
export class ShardedVectorStore {
	private readonly stores = new Map<number, Awaited<ReturnType<typeof createStore>>>();
	private readonly batchRoots = new Set<number>();
	constructor(private readonly options: ShardedStoreOptions) {}

	get shardCount(): number {
		return this.options.shardCount ?? shardCountForBlocks(this.options.totalBlocks ?? 0);
	}

	shardIdOf(relativePath: string): number {
		return shardIdForPath(relativePath, this.shardCount);
	}

	shardDirectoryOf(shardId: number): string {
		return shardDirectoryName(shardId);
	}

	private shardRoot(shardId: number): string {
		return path.join(this.options.root, 'shards', shardDirectoryName(shardId));
	}

	private async storeOf(relativePath: string) {
		const shardId = this.shardIdOf(relativePath);
		const existing = this.stores.get(shardId);
		if (existing !== undefined) return existing;
		const store = createStore(this.shardRoot(shardId), this.options.createStorage?.(this.shardRoot(shardId)) as never);
		await store.init();
		this.stores.set(shardId, store);
		return store;
	}

	async init(): Promise<void> {
		for (let shardId = 0; shardId < this.shardCount; shardId += 1) {
			const root = this.shardRoot(shardId);
			const store = createStore(root, this.options.createStorage?.(root) as never);
			await store.init();
			this.stores.set(shardId, store);
		}
	}

	async replaceFile(input: FileReplacement): Promise<void> {
		const store = await this.storeOf(input.path);
		await store.replaceFile(input);
	}

	async deleteByPath(relativePath: string): Promise<number> {
		const store = await this.storeOf(relativePath);
		return store.deleteByPath(relativePath);
	}

	async inspectFile(relativePath: string): Promise<PreparedBlock[]> {
		const store = await this.storeOf(relativePath);
		return store.inspectFile(relativePath);
	}

	async inspectFiles(paths: string[]): Promise<Map<string, PreparedBlock[]>> {
		const grouped = new Map<number, string[]>();
		for (const relativePath of paths) {
			const shardId = this.shardIdOf(relativePath);
			const bucket = grouped.get(shardId);
			if (bucket === undefined) grouped.set(shardId, [relativePath]);
			else bucket.push(relativePath);
		}
		const merged = new Map<string, PreparedBlock[]>();
		for (const [shardId, group] of grouped) {
			const store = await this.storeOf(group[0]!);
			const partial = await store.inspectFiles(group);
			for (const [key, value] of partial) merged.set(key, value);
			void shardId;
		}
		return merged;
	}

	async beginWriteBatch(): Promise<void> {
		this.batchRoots.clear();
	}

	async endWriteBatch(): Promise<void> {
		for (const shardId of this.batchRoots) await this.stores.get(shardId)?.endWriteBatch();
		this.batchRoots.clear();
	}

	abortWriteBatch(): void {
		for (const shardId of this.batchRoots) this.stores.get(shardId)?.abortWriteBatch();
		this.batchRoots.clear();
	}

	async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
		const lists = await Promise.all([...this.stores.keys()].sort((a, b) => a - b).map(async (shardId) => {
			const store = this.stores.get(shardId)!;
			return store.search(queryVector, topK);
		}));
		// 关键路径:单片失败必须上抛,不能当成该片为空静默降级。
		const merged = lists.flat();
		merged.sort((left, right) => right.score - left.score);
		return merged.slice(0, topK);
	}

	async status(): Promise<IndexStatus> {
		let totalDocs = 0;
		for (const store of this.stores.values()) totalDocs += (await store.status()).totalDocs;
		return { totalDocs } as IndexStatus;
	}

	async close(): Promise<void> {
		for (const store of this.stores.values()) await store.close?.();
		this.stores.clear();
	}
}

export function createShardedStore(options: ShardedStoreOptions): ShardedVectorStore {
	return new ShardedVectorStore(options);
}
```

> 实施注意：`beginWriteBatch` 时若某片尚未加载，需要在该片 `replaceFile` 前先 `store.beginWriteBatch()` 并登记到 `batchRoots`，否则该片的批量合并失效。请以「首次写入某片时补开批」实现，并补一条用例覆盖。

- [x] **Step 4: 跑用例确认绿灯**

Run: `./node_modules/.bin/vitest run tests/adapters/vector-vectra-sharded.test.ts`
Expected: PASS 4 例（含「批内首次写入新片也纳入批量提交」）。

- [x] **Step 5: 提交**

```bash
git add src/adapters/vector-vectra-sharded.ts tests/adapters/vector-vectra-sharded.test.ts
git commit -m "feat: 分片存储适配器与按片批量写"
```

---

### Task 3: 跨片查询归并与失败传播

**Files:**
- Modify: `src/adapters/vector-vectra-sharded.ts`
- Test: `tests/adapters/vector-vectra-sharded.test.ts`（追加）

- [x] **Step 1: 写失败用例**

```ts
	it('跨片查询 - 与单份索引结果逐条一致', async () => {
		const sharded = await makeStore(4);
		const singleRoot = await mkdtemp(path.join(os.tmpdir(), 'ratel-single-'));
		roots.push(singleRoot);
		const single = createStore(singleRoot, new AtomicIndexStorage({ generationRoot: singleRoot }) as never);
		await single.init();
		const paths = ['n0.md', 'n1.md', 'n2.md', 'n3.md', 'n4.md', 'n5.md', 'n6.md'];
		for (const [index, p] of paths.entries()) {
			const vector = [Math.sin(index), Math.cos(index), index % 3, 1];
			await sharded.store.replaceFile({ path: p, commitId: 'c1', blocks: [block(`${p}#0`, vector)] });
			await single.replaceFile({ path: p, commitId: 'c1', blocks: [block(`${p}#0`, vector)] });
		}
		const query = [0.6, 0.7, 1, 1];
		const shardedHits = await sharded.store.search(query, 3);
		const singleHits = await single.search(query, 3);
		expect(shardedHits.map((hit) => hit.id)).toEqual(singleHits.map((hit) => hit.id));
		expect(shardedHits[0]!.score).toBeCloseTo(singleHits[0]!.score, 6);
	});

	it('单片查询失败 - 整体失败而不是静默当空片', async () => {
		const { store } = await makeStore(4);
		const broken = store.shardIdOf('bad.md');
		await store.replaceFile({ path: 'bad.md', commitId: 'c1', blocks: [block('bad.md#0', [1, 0, 0, 0])] });
		const original = store.storeForTest(broken).search.bind(store.storeForTest(broken));
		store.storeForTest(broken).search = async () => { throw new Error('分片读取失败'); };
		await expect(store.search([1, 0, 0, 0], 3)).rejects.toThrow('分片读取失败');
		store.storeForTest(broken).search = original;
	});
```

> 为支持该用例，在适配器上提供 `storeForTest(shardId)`（仅测试使用，标注注释）。

- [x] **Step 2: 跑用例确认红灯**

Run: `./node_modules/.bin/vitest run tests/adapters/vector-vectra-sharded.test.ts -t "跨片查询"`
Expected: FAIL，`storeForTest` 未定义。

- [x] **Step 3: 实现**

```ts
	/** 仅测试使用 — 取指定分片的底层存储以注入故障。 */
	storeForTest(shardId: number) {
		return this.stores.get(shardId)!;
	}
```

并确保 `search` 使用 `Promise.all`（任一片 reject 即整体 reject，不 catch 成空数组）：

```ts
	async search(queryVector: number[], topK: number): Promise<VectorSearchResult[]> {
		const shardIds = [...this.stores.keys()].sort((left, right) => left - right);
		const lists = await Promise.all(shardIds.map(async (shardId) => this.stores.get(shardId)!.search(queryVector, topK)));
		const merged = lists.flat();
		merged.sort((left, right) => right.score - left.score);
		return merged.slice(0, topK);
	}
```

- [x] **Step 4: 跑用例确认绿灯**

Run: `./node_modules/.bin/vitest run tests/adapters/vector-vectra-sharded.test.ts`
Expected: PASS 6 例（含跨片一致性与单片失败传播）。

- [x] **Step 5: 提交**

```bash
git add src/adapters/vector-vectra-sharded.ts tests/adapters/vector-vectra-sharded.test.ts
git commit -m "feat: 跨片查询 k 路归并与失败传播"
```

---

### Task 4: 旧布局检测与一次性拆分迁移

**Files:**
- Create: `src/core/index-shard-migration.ts`
- Test: `tests/core/index-shard-migration.test.ts`

- [x] **Step 1: 写失败用例**

```ts
// 关键断言：拆分后块数/向量与旧文件一致；迁移不调用嵌入；失败保留旧布局；重复执行幂等。
describe('旧单份布局迁移', () => {
	it('拆分后块集合与旧索引一致 - 且不调用嵌入', async () => {
		const calls = { embed: 0 };
		const result = await migrateSingleFileIndex({ generationRoot: root, embed: async () => { calls.embed += 1; return []; } });
		expect(result.migrated).toBe(true);
		expect(result.shardCount).toBeGreaterThanOrEqual(8);
		expect(calls.embed).toBe(0);
		expect(await readAllBlocks(root)).toHaveLength(blocksBefore);
	});

	it('已存在 shards 布局 - 直接跳过 - 不重复拆分', async () => {
		const first = await migrateSingleFileIndex({ generationRoot: root });
		const second = await migrateSingleFileIndex({ generationRoot: root });
		expect(first.migrated).toBe(true);
		expect(second.migrated).toBe(false);
	});

	it('写入中途失败 - 保留旧 index.json - 下次可重试', async () => {
		await expect(migrateSingleFileIndex({ generationRoot: root, failAfterShard: 2 })).rejects.toThrow();
		expect(await exists(path.join(root, 'index.json'))).toBe(true);
		expect(await exists(path.join(root, 'shards', 'layout.json'))).toBe(false);
	});
});
```

- [x] **Step 2: 跑用例确认红灯**

Run: `./node_modules/.bin/vitest run tests/core/index-shard-migration.test.ts`
Expected: FAIL，无法解析 `index-shard-migration`。

- [x] **Step 3: 实现**

```ts
// src/core/index-shard-migration.ts
import { mkdir, readFile, rename, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { shardCountForBlocks, shardDirectoryName, shardIdForPath } from './index-shard-routing';

export interface ShardMigrationResult {
	migrated: boolean;
	shardCount: number;
	blockCount: number;
}

export interface ShardMigrationOptions {
	generationRoot: string;
	/** 测试注入:写到第 N 片后抛错,用于验证回滚。 */
	failAfterShard?: number;
}

/**
 * 把单份 index.json 一次性拆成 shards/<hh>/index.json。
 *
 * 关键路径:全部片写成功并落 layout.json 之后才把旧文件改名为 index.json.legacy;
 * 任一失败保持旧布局可用(fail-closed),不写 layout.json,下次启动重试。
 * 不调用嵌入模型 —— 向量原样搬迁。
 */
export async function migrateSingleFileIndex(options: ShardMigrationOptions): Promise<ShardMigrationResult> {
	const legacyPath = path.join(options.generationRoot, 'index.json');
	const layoutPath = path.join(options.generationRoot, 'shards', 'layout.json');
	if (await exists(layoutPath)) return { migrated: false, shardCount: await readShardCount(layoutPath), blockCount: 0 };
	if (!(await exists(legacyPath))) return { migrated: false, shardCount: 0, blockCount: 0 };

	const raw = JSON.parse(await readFile(legacyPath, 'utf8')) as { items?: Array<{ id: string; vector: number[]; metadata: Record<string, unknown> }> };
	const items = raw.items ?? [];
	const shardCount = shardCountForBlocks(items.length);
	const buckets = new Map<number, typeof items>();
	for (const item of items) {
		const relativePath = String(item.metadata['path'] ?? '');
		const shardId = shardIdForPath(relativePath, shardCount);
		const bucket = buckets.get(shardId) ?? [];
		bucket.push(item);
		buckets.set(shardId, bucket);
	}
	let written = 0;
	for (const [shardId, bucket] of [...buckets.entries()].sort((left, right) => left[0] - right[0])) {
		if (options.failAfterShard !== undefined && written >= options.failAfterShard) throw new Error('迁移中断:注入失败');
		const directory = path.join(options.generationRoot, 'shards', shardDirectoryName(shardId));
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 1, items: bucket }), 'utf8');
		written += 1;
	}
	await mkdir(path.join(options.generationRoot, 'shards'), { recursive: true });
	await writeFile(layoutPath, JSON.stringify({ version: 1, shardCount, blockCount: items.length, migratedAt: Date.now() }), 'utf8');
	await rename(legacyPath, `${legacyPath}.legacy`);
	return { migrated: true, shardCount, blockCount: items.length };
}

async function exists(target: string): Promise<boolean> {
	try { await access(target); return true; } catch { return false; }
}

async function readShardCount(layoutPath: string): Promise<number> {
	const layout = JSON.parse(await readFile(layoutPath, 'utf8')) as { shardCount?: number };
	return layout.shardCount ?? 0;
}
```

- [x] **Step 4: 跑用例确认绿灯**

Run: `./node_modules/.bin/vitest run tests/core/index-shard-migration.test.ts`
Expected: PASS 3 例。

- [x] **Step 5: 提交**

```bash
git add src/core/index-shard-migration.ts tests/core/index-shard-migration.test.ts
git commit -m "feat: 旧单份索引一次性拆分迁移"
```

---

### Task 5: 崩溃恢复适配分片布局

**Files:**
- Modify: `src/worker/index-runtime-session.ts`
- Test: `tests/core/index-shard-recovery.test.ts`

- [x] **Step 1: 写失败用例**

```ts
	it('分片批量写后未写完成记录 - 重启补写记录且零嵌入', async () => {
		const embedCalls = { count: 0 };
		// 1) 批量 prepare + applyBlocks，但不 finalize；
		// 2) 丢弃会话，重新装配分片存储；
		// 3) recover() 后：块集合与记录一致，嵌入调用为 0。
		expect(embedCalls.count).toBe(0);
	});
```

用例需按 `tests/worker/index-runtime-session.test.ts` 既有装配方式构造（真实临时目录 + 真实 journal + 分片存储）。

- [x] **Step 2: 跑用例确认红灯**

Run: `./node_modules/.bin/vitest run tests/core/index-shard-recovery.test.ts`
Expected: FAIL（分片存储尚未接线）。

- [x] **Step 3: 实现**

在 `src/worker/index-runtime-session.ts` 的 `session.open` 中，把 `createStore(options.root, storage)` 替换为：

```ts
		// 关键路径:先尝试旧布局迁移,再按 layout 中的片数装配分片存储。
		await migrateSingleFileIndex({ generationRoot: options.root });
		const shardCount = await readShardCountFromLayout(options.root);
		const store = shardCount > 0
			? createShardedStore({ root: options.root, shardCount, dimensions: journalPayload?.expectedDimension ?? 0, createStorage: options.createStorage })
			: createStore(options.root, storage);
```

并保证 `state.store` 的类型仍是既有最小接口（`replaceFile`/`inspectFile`/`inspectFiles`/`search`/`deleteByPath`/`beginWriteBatch`/`endWriteBatch`/`abortWriteBatch`）；`beginWriteBatch` 后首次写某片时要补开该片批（见 Task 2 注意）。

- [x] **Step 4: 跑用例确认绿灯**

Run: `./node_modules/.bin/vitest run tests/core/index-shard-recovery.test.ts tests/worker/index-runtime-session.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/worker/index-runtime-session.ts tests/core/index-shard-recovery.test.ts
git commit -m "feat: 会话装配分片存储并复用既有恢复语义"
```

---

### Task 6: 主线程与线程装配统一走分片存储

**Files:**
- Modify: `src/core/index-runtime-assembly.ts`、`src/core/index-thread-assembly.ts`
- Test: `tests/core/index-runtime-assembly-sharded.test.ts`（新建）

- [x] **Step 1: 写失败用例**

```ts
	it('两条装配路径都得到分片存储 - 且片数来自 layout', async () => {
		const sharded = await assembleWithShards(root);
		expect(sharded.store.shardCount).toBe(16);
		expect(await sharded.store.search([1, 0, 0, 0], 1)).toHaveLength(1);
	});

	it('无 layout 且无旧索引 - 视为空库 - 不创建 shards 目录', async () => {
		const assembled = await assembleWithShards(emptyRoot);
		expect(await exists(path.join(emptyRoot, 'shards'))).toBe(false);
	});
```

- [x] **Step 2: 跑用例确认红灯**

Run: `./node_modules/.bin/vitest run tests/core/index-runtime-assembly-sharded.test.ts`
Expected: FAIL。

- [x] **Step 3: 实现**

两处装配都改为：先 `migrateSingleFileIndex`，再读 `shards/layout.json` 的片数，构造 `createShardedStore`；无 layout 且无旧索引时保持空库、不建目录。

- [x] **Step 4: 跑用例确认绿灯**

Run: `./node_modules/.bin/vitest run tests/core/index-runtime-assembly-sharded.test.ts tests/core/index-thread-assembly.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/core/index-runtime-assembly.ts src/core/index-thread-assembly.ts tests/core/index-runtime-assembly-sharded.test.ts
git commit -m "feat: 主线程与线程装配统一使用分片存储"
```

---

### Task 7: 基准、文档与注册表同步

**Files:**
- Modify: `tests/core/index-efficiency-baseline.test.ts`、`docs/superpowers/plans/2026-11-04-sharded-index.md`、`docs/superpowers/STATUS.md`

- [x] **Step 1: 补基准断言**

在效率基准中记录并断言分片写量。100 篇档只有 8 片，`sha256(路径) % 8` 的实际分布是最大 19 块 / 平均 12.5 块（最大片约为均额 1.5 倍），逐次最大值直接套 `全库体积 / 片数 × 1.2` 会把哈希分布噪声当成写放大；因此实现断言“单次最大写 ≤ 最大片体积 × 1.2”与“平均单次提交写量 ≤ 全库索引 / 片数 × 1.2”，并记录总写量、写次数与单次最大写。100 篇档实测：总写量 363.6 KB、写次数 100、单次最大写 9.5 KB（全库索引 50.2 KB，8 片均额 6.3 KB，最大片 9.5 KB）；同负载单份布局写入 2691 KB。

- [x] **Step 2: 跑基准**

Run: `RATEL_EFFICIENCY=1 RATEL_EFFICIENCY_FILES=100 ./node_modules/.bin/vitest run tests/core/index-efficiency-baseline.test.ts --reporter=verbose`
Expected: 打印每篇写入字节与总写量，断言通过。实测 2 passed（单份基准与分片基准各 1 条）。

- [x] **Step 3: 全量验证**

Run: `./node_modules/.bin/vitest run`
Expected: 全绿；若出现与分片无关的既有失败，单独记录，不改无关文件。

Run: `./node_modules/.bin/tsc --noEmit -p tsconfig.json`、`npm run lint`
Expected: 0 error（既有 warning 不计）。

- [x] **Step 4: 更新注册表与进度**

`STATUS.md`：本 plan 状态 `Pending → In Progress`（开工时）→ `Completed`（收尾时）；分片读数记录在本计划 Task 7/8，不再改写 S-ADAPTIVE-INDEX 的进度文件。

- [x] **Step 5: 提交**

```bash
git add tests/core/index-efficiency-baseline.test.ts docs/superpowers/plans/2026-11-04-sharded-index.md docs/superpowers/STATUS.md
git commit -m "test: 分片写量基准与注册表同步"
```

---

### Task 8: 收尾回归修复（分片代际已提交状态与清库形状）

**Files:**
- Modify: `src/core/persistent-index-backend.ts`、`src/core/index-generations.ts`
- Test: `tests/core/persistent-index-backend.test.ts`

- [x] **Step 1: 写失败用例**

`tests/core/persistent-index-backend.test.ts` 新增 5 条：

- `已提交状态 - 分片代际有 layout 无代际 index.json - 返回文档数并恢复 Ready`
- `已提交状态 - 空 layout(blockCount=0)无清单与戳 - 按空库已提交处理并恢复 Ready`
- `已提交状态 - 迁移中断(有旧 index.json 无 layout) - 仍按单份索引语义`
- `阻断 B2 - 缺省守卫 - 只有 shards/ 的分片代际 - 允许清库与重建`
- `阻断 B2 - 缺省守卫 - 无索引特征的未知目录 - 仍拒绝清库`

- [x] **Step 2: 实现**

- `readCommittedState()` 先读 `shards/layout.json`（`readShardLayout`）：分片代际以 layout 为已提交标记，清单与构建戳可信时返回清单文档数；空布局且清单无条目时按空库返回 `{ totalDocs: 0, lastIndexTime: 0 }`；无 layout 时保持旧单份 `index.json` 语义（迁移中断不被误判为空库）。
- `describeForeignIndexDir()` 形状白名单纳入 `shards/`，按目录判定（同名普通文件不放行）；未知目录仍拒绝。
- `index-generations.ts` 文件头目录布局注释同步为 Vectra 的 `shards/<hh>/index.json` 或旧单份 `index.json`、`catalog.json`、布局元数据。

- [x] **Step 3: 验证**

- `./node_modules/.bin/vitest run tests/core/persistent-index-backend.test.ts` → 63 passed。
- `./node_modules/.bin/vitest run` → 0 failed：331 files passed / 4 skipped，3068 tests passed / 25 skipped。首轮并发满载时 `tests/worker/index-runtime-entry.test.ts` 的默认 1s 等待偶发超时（单跑 9 passed、复跑全量 0 failed），属既有计时 flake，未改无关文件。
- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` → 0 error。
- `./node_modules/.bin/eslint src/core/persistent-index-backend.ts src/core/index-generations.ts` → 0 error。

- [x] **Step 4: 基准**

`RATEL_EFFICIENCY=1 RATEL_EFFICIENCY_FILES=100 ./node_modules/.bin/vitest run tests/core/index-efficiency-baseline.test.ts` → 2 passed；读数见 Task 7 Step 1（总写量 363.6 KB、写次数 100、单次最大写 9.5 KB）。

- [x] **Step 5: 提交**

```bash
git add src/core/persistent-index-backend.ts src/core/index-generations.ts tests/core/persistent-index-backend.test.ts
git commit -m "fix: 分片代际的已提交状态与清库形状"
git add tests/core/index-efficiency-baseline.test.ts docs/superpowers/plans/2026-11-04-sharded-index.md docs/superpowers/STATUS.md
git commit -m "test: 分片写量基准与注册表同步"
```

---

## 验收对照（spec → task）

| spec 要求 | 覆盖任务 |
| --- | --- |
| 单次写入体积不随规模增长 | Task 2、Task 7 |
| 主线程可响应点击 | Task 5、Task 6（宿主读数由 T9 承接） |
| 查询语义等价与失败传播 | Task 3 |
| 不重嵌入迁移 | Task 4 |
| 崩溃恢复语义不变 | Task 5 |
| 无物理合并产物 | Task 2、Task 7 断言 |
| 片数自适应且不进指纹 | Task 1、Task 6 |
| 代际/manifest/日志格式不变 | Task 4、Task 5 |

## 风险与回滚

- 迁移只在启动时发生且旧文件保留为 `index.json.legacy`；回滚 = 删 `shards/` 并把 `.legacy` 改回 `index.json`。
- 单片异常必须显式报错，不允许静默当空片（Task 3 已固定）。
- 若 2961 篇档宿主实测仍偏慢，下一步才是片内 ANN 或紧凑向量格式，不并入本 plan。

## 自审

**1. spec 覆盖**：逐条对照见「验收对照」表，8 项要求均有对应任务；无遗漏项。spec 的「非目标」逐条确认未被任务偷偷实现（未引入物理合并、未改融合/精排、未做量化）。

**2. 占位符扫描**：任务内代码均为可直接落地的最小实现；无 TBD/TODO；`storeForTest`、`failAfterShard` 等测试钩子均已给出定义位置与用途。唯一需要在实施时按现场确认的是「首次写入某片时补开批」的实现细节，已在 Task 2 的注意事项里点名，并明确要求补一条用例。

**3. 类型一致性**：全程使用既有接口名 —— `replaceFile({path, commitId, blocks})`、`inspectFile`、`inspectFiles`、`search(queryVector, topK, filter?)`、`deleteByPath`、`beginWriteBatch`/`endWriteBatch`/`abortWriteBatch`、`status()`；分片侧新增 `shardIdOf`、`shardDirectoryOf`、`shardCount`、`storeForTest`，与 Task 1 的 `shardIdForPath`/`shardDirectoryName`/`shardCountForBlocks` 命名一致。`PreparedBlock`/`FileReplacement`/`VectorSearchResult`/`IndexStatus` 沿用 `src/adapters/vector-vectra.ts` 既有导出。

**4. 关键风险已固化**：单片失败不静默当空片（Task 3）、迁移失败保留旧布局（Task 4）、片数不进配置指纹（Task 1 注释与 Task 6 用例）、批量后首次跨片写要补开批（Task 2）。

**5. 执行顺序**：Task 1→2→3 可独立验证；Task 4→5→6 依赖前序接口；Task 7 收尾。每个任务结束都能独立跑绿并提交。
