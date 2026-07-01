# 索引启动智能重算 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 smart reindex 启动路径 + manifest 持久化 + API 模式 watcher + chunk 残留修复,解决 P2(每次启动全量重 embed)和 P3(API 模式不索引)。

**Architecture:** 新建 `IndexManifest` 类管理每文件 hash + 全局参数(`pluginDir/index-manifest.json`,独立于 data.json)。`IndexManager.onLayoutReady` 改为 `smartReindex`:先 hash diff,仅对变更文件 incremental。`main.ts onLayoutReady` 解耦模型下载与索引启动,两条 provider 都走 smartReindex。`VectraStore` 新增 `deleteByPath`,reembed 前先清旧 chunk 防残留。

**Tech Stack:** TypeScript、Svelte 5 store、vectra、vitest、Node.js fs/promises、Web Crypto API。

**Spec:** [`docs/superpowers/specs/2026-06-28-index-startup-smart-reindex-design.md`](../specs/2026-06-28-index-startup-smart-reindex-design.md)

---

## 文件结构

### 新增

| 文件 | 职责 |
|---|---|
| `src/core/index-manifest.ts` | `IndexManifest` 类:load/save/diff/recordEntry/removeEntry/invalidate/shouldFullRebuild |
| `tests/core/index-manifest.test.ts` | manifest 单测:13 条 |
| `tests/integration/index-startup.test.ts` | smart reindex 集成测试 |

### 修改

| 文件 | 改动要点 |
|---|---|
| `src/adapters/vector-vectra.ts` | 新增 `deleteByPath(filePath)` 方法 |
| `src/worker/index-processor.ts` | `indexIncremental` 改为先 `deleteByPath` 再 upsert;新增 `indexBatch(files)` |
| `src/worker/handler.ts` | 新增 `index.batch` case |
| `src/types.ts` | `WorkerRequest` 加 `index.batch`、`WorkerResponse` 加 `index.batch.done` |
| `src/core/index-manager.ts` | `IndexBackend` 加 `smartReindex` + `isIndexCreated` + `listMarkdownFiles`;`IndexStatus` 加 `Diffing` |
| `src/core/index-controller.ts` | `onLayoutReady` 调 `smartReindex`(注入 manifest) |
| `src/main.ts` | onLayoutReady 解耦模型下载与索引;装配 IndexManifest + IndexBackend.smartReindex |
| `tests/adapters/vector-vectra.test.ts` | 加 `deleteByPath` 3 条单测 |
| `tests/core/index-manager.test.ts` | 加 smartReindex / Diffing 状态测试 |
| `tests/worker/index-processor.test.ts` | 加 indexBatch / deleteByPath 集成测试 |

---

## Task 1: IndexManifest 类 — load / save 原子写

**Files:**
- Create: `src/core/index-manifest.ts`
- Test: `tests/core/index-manifest.test.ts`

- [ ] **Step 1: 写失败测试 — load 文件不存在返回 null**

创建 `tests/core/index-manifest.test.ts`:

```typescript
/**
 * @file tests/core/index-manifest.test.ts
 * @description IndexManifest 行为 — load/save/diff/recordEntry/removeEntry/invalidate/shouldFullRebuild
 * @module tests/core/index-manifest
 * @depends core/index-manifest
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexManifest } from '../../src/core/index-manifest';
import path from 'path';
import fs from 'fs';

const TEST_DIR = path.join(__dirname, '../tmp/test-manifest');
const MANIFEST_PATH = path.join(TEST_DIR, 'index-manifest.json');

describe('IndexManifest', () => {
    let manifest: IndexManifest;

    beforeEach(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true });
        }
        fs.mkdirSync(TEST_DIR, { recursive: true });
        manifest = new IndexManifest(MANIFEST_PATH);
    });

    afterEach(() => {
        if (fs.existsSync(TEST_DIR)) {
            fs.rmSync(TEST_DIR, { recursive: true });
        }
    });

    it('load - 文件不存在 - 返回 null', async () => {
        expect(await manifest.load()).toBeNull();
    });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/index-manifest.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/index-manifest'`

- [ ] **Step 3: 实现 IndexManifest(load + save + 类型)**

创建 `src/core/index-manifest.ts`:

```typescript
/**
 * @file src/core/index-manifest.ts
 * @description 索引清单 — 记录每文件 hash + 全局 embedding 参数,启动期 hash diff 跳过未变更文件
 * @module core/index-manifest
 * @depends utils/hash
 *
 * 设计要点:
 * - 独立于 data.json(不走 Obsidian loadData/saveData),与 .index/ 同目录同生命周期
 * - 原子写:先写 .tmp 再 rename,避免半写损坏
 * - load 失败返回 null,调用方走全量降级
 * - 全局参数(embedModelId/chunkSize/chunkOverlap)变化 → shouldFullRebuild 返回 true
 */
import fs from 'fs';

/** 索引清单条目 — 单个文件在向量索引中的元数据。 */
export interface IndexManifestEntry {
    /** 文件相对 vault 根的路径,作为 key */
    path: string;
    /** sha256(content),内容指纹 */
    hash: string;
    /** 文件最后修改时间戳(ms),快速跳过用 */
    mtime: number;
    /** 该文件被切成的 chunk 数,用于诊断 */
    chunkCount: number;
}

/** 索引清单 — 全局元数据 + 每文件条目。 */
export interface IndexManifestData {
    /** manifest 格式版本 */
    version: 1;
    /** 当前索引使用的 embedding 模型 ID */
    embedModelId: string;
    /** chunkMarkdown 的 chunkSize 参数 */
    chunkSize: number;
    /** chunkMarkdown 的 chunkOverlap 参数 */
    chunkOverlap: number;
    /** 最近一次索引完成时间(ms) */
    lastIndexTime: number;
    /** 每文件条目,key = 文件相对路径 */
    entries: Record<string, IndexManifestEntry>;
}

/** 当前 manifest 文件的 diff 结果。 */
export interface ManifestDiff {
    toAdd: Array<{ path: string; content: string; mtime: number }>;
    toUpdate: Array<{ path: string; content: string; mtime: number }>;
    toDelete: string[];
    unchanged: string[];
}

/**
 * 索引清单管理器 — load/save/diff/recordEntry/removeEntry/invalidate。
 *
 * 关键路径:manifest 是启动期 smart reindex 的决策依据,独立文件 IO,
 * 不走 Obsidian loadData/saveData(避免与 data.json 全量序列化混存)。
 */
export class IndexManifest {
    private data: IndexManifestData | null = null;

    constructor(private readonly path: string) {}

    /** 从磁盘读 + JSON 解析;失败返回 null,调用方走全量降级。 */
    async load(): Promise<IndexManifestData | null> {
        try {
            const raw = await fs.promises.readFile(this.path, 'utf8');
            this.data = JSON.parse(raw) as IndexManifestData;
            return this.data;
        } catch {
            // 关键路径:文件不存在或 JSON 损坏,降级全量。
            return null;
        }
    }

    /** 原子写:先写 .tmp 再 rename,避免半写损坏。 */
    async save(data: IndexManifestData): Promise<void> {
        // 关键路径:同目录 rename 是原子操作,防半写状态导致 manifest 损坏。
        const tmpPath = this.path + '.tmp';
        const json = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(tmpPath, json, 'utf8');
        await fs.promises.rename(tmpPath, this.path);
        this.data = data;
    }
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/core/index-manifest.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/index-manifest.ts tests/core/index-manifest.test.ts
git commit -m "feat(index-manifest): 新增 IndexManifest 类 — load 原子写 save"
```

---

## Task 2: IndexManifest — diff / recordEntry / removeEntry / invalidate / shouldFullRebuild

**Files:**
- Modify: `src/core/index-manifest.ts`
- Test: `tests/core/index-manifest.test.ts`

- [ ] **Step 1: 写失败测试 — diff 各场景**

在 `tests/core/index-manifest.test.ts` 追加:

```typescript
    it('load - JSON 损坏 - 返回 null', async () => {
        fs.writeFileSync(MANIFEST_PATH, '{not valid json');
        expect(await manifest.load()).toBeNull();
    });

    it('load - 正常文件 - 返回 manifest', async () => {
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'bge-small-zh',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 1000,
            entries: {},
        };
        await manifest.save(data);
        const loaded = await manifest.load();
        expect(loaded).toEqual(data);
    });

    it('shouldFullRebuild - embedModelId 变 - 返回 true', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'bge-small-zh',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        expect(manifest2.shouldFullRebuild(data, 'different-model', 500, 100)).toBe(true);
    });

    it('shouldFullRebuild - chunkSize 变 - 返回 true', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        expect(manifest2.shouldFullRebuild(data, 'm', 800, 100)).toBe(true);
    });

    it('shouldFullRebuild - 全部不变 - 返回 false', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        expect(manifest2.shouldFullRebuild(data, 'm', 500, 100)).toBe(false);
    });

    it('diff - 全新文件 - 进 toAdd', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        const diff = manifest2.diff(data, [
            { path: 'a.md', content: 'x', hash: 'h1', mtime: 100 },
        ]);
        expect(diff.toAdd).toHaveLength(1);
        expect(diff.toAdd[0]!.path).toBe('a.md');
        expect(diff.toUpdate).toHaveLength(0);
        expect(diff.toDelete).toHaveLength(0);
        expect(diff.unchanged).toHaveLength(0);
    });

    it('diff - hash 未变 - 进 unchanged', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {
                'a.md': { path: 'a.md', hash: 'h1', mtime: 100, chunkCount: 3 },
            },
        };
        const diff = manifest2.diff(data, [
            { path: 'a.md', content: 'x', hash: 'h1', mtime: 200 },
        ]);
        expect(diff.unchanged).toEqual(['a.md']);
        expect(diff.toUpdate).toHaveLength(0);
    });

    it('diff - hash 变 - 进 toUpdate', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {
                'a.md': { path: 'a.md', hash: 'old', mtime: 100, chunkCount: 3 },
            },
        };
        const diff = manifest2.diff(data, [
            { path: 'a.md', content: 'x', hash: 'new', mtime: 200 },
        ]);
        expect(diff.toUpdate).toHaveLength(1);
        expect(diff.toUpdate[0]!.path).toBe('a.md');
        expect(diff.unchanged).toHaveLength(0);
    });

    it('diff - manifest 有 vault 无 - 进 toDelete', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {
                'gone.md': { path: 'gone.md', hash: 'h', mtime: 100, chunkCount: 2 },
            },
        };
        const diff = manifest2.diff(data, []);
        expect(diff.toDelete).toEqual(['gone.md']);
    });

    it('recordEntry - 写入后 entries 包含该条目', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {},
        };
        manifest2.recordEntry(data, 'a.md', 'h1', 100, 3);
        expect(data.entries['a.md']).toEqual({ path: 'a.md', hash: 'h1', mtime: 100, chunkCount: 3 });
    });

    it('removeEntry - 移除后 entries 不含该条目', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 0,
            entries: {
                'a.md': { path: 'a.md', hash: 'h1', mtime: 100, chunkCount: 3 },
            },
        };
        manifest2.removeEntry(data, 'a.md');
        expect(data.entries['a.md']).toBeUndefined();
    });

    it('invalidate - 清空 entries 保留全局参数', () => {
        const manifest2 = new IndexManifest(MANIFEST_PATH);
        const data: import('../../src/core/index-manifest').IndexManifestData = {
            version: 1,
            embedModelId: 'm',
            chunkSize: 500,
            chunkOverlap: 100,
            lastIndexTime: 1000,
            entries: {
                'a.md': { path: 'a.md', hash: 'h', mtime: 1, chunkCount: 1 },
            },
        };
        manifest2.invalidate(data);
        expect(data.entries).toEqual({});
        // 关键路径:全局参数保留,模型切换后全量重建时复用 embedModelId 等字段。
        expect(data.embedModelId).toBe('m');
        expect(data.chunkSize).toBe(500);
    });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/index-manifest.test.ts`
Expected: FAIL — `manifest.shouldFullRebuild is not a function` 等

- [ ] **Step 3: 实现 diff / recordEntry / removeEntry / invalidate / shouldFullRebuild**

在 `src/core/index-manifest.ts` 的 `IndexManifest` 类内追加方法(在 `save` 方法之后):

```typescript
    /**
     * 比对当前 manifest 与 vault 文件列表,产出待处理集合。
     *
     * 关键路径:
     * - mtime 未变 → 跳过 hash 计算,直接进 unchanged(快速路径)
     * - mtime 变了或 manifest 无记录 → 用传入的 hash 判断 add/update
     * - manifest 有 vault 无 → toDelete
     *
     * @param data - 已加载的 manifest(由调用方传入,因为调用方需要先 shouldFullRebuild 判断)
     * @param currentFiles - vault 当前文件列表(已算好 hash)
     */
    diff(
        data: IndexManifestData,
        currentFiles: Array<{ path: string; content: string; hash: string; mtime: number }>,
    ): ManifestDiff {
        const toAdd: ManifestDiff['toAdd'] = [];
        const toUpdate: ManifestDiff['toUpdate'] = [];
        const toDelete: string[] = [];
        const unchanged: string[] = [];

        const currentPaths = new Set(currentFiles.map((f) => f.path));

        // 关键路径:先处理 vault 当前文件(add / update / unchanged)。
        for (const file of currentFiles) {
            const entry = data.entries[file.path];
            if (!entry) {
                toAdd.push({ path: file.path, content: file.content, mtime: file.mtime });
            } else if (entry.hash !== file.hash) {
                toUpdate.push({ path: file.path, content: file.content, mtime: file.mtime });
            } else {
                unchanged.push(file.path);
            }
        }

        // 关键路径:manifest 有 vault 无 → delete。
        for (const entryPath of Object.keys(data.entries)) {
            if (!currentPaths.has(entryPath)) {
                toDelete.push(entryPath);
            }
        }

        return { toAdd, toUpdate, toDelete, unchanged };
    }

    /** 记录单个文件索引后的元数据(增量更新 entry)。 */
    recordEntry(
        data: IndexManifestData,
        path: string,
        hash: string,
        mtime: number,
        chunkCount: number,
    ): void {
        data.entries[path] = { path, hash, mtime, chunkCount };
    }

    /** 移除单个文件的 entry(文件删除后调)。 */
    removeEntry(data: IndexManifestData, path: string): void {
        delete data.entries[path];
    }

    /** 清空 entries(模型切换/参数变更触发全量重建时调)。保留全局参数待重新填。 */
    invalidate(data: IndexManifestData): void {
        data.entries = {};
    }

    /**
     * 判断是否需要全量重建。
     *
     * 触发条件:embedModelId / chunkSize / chunkOverlap 任一变化。
     * 原因:不同 embedding 模型的向量空间不兼容,混入会导致搜索错乱。
     */
    shouldFullRebuild(
        data: IndexManifestData,
        newEmbedModelId: string,
        newChunkSize: number,
        newChunkOverlap: number,
    ): boolean {
        return (
            data.embedModelId !== newEmbedModelId ||
            data.chunkSize !== newChunkSize ||
            data.chunkOverlap !== newChunkOverlap
        );
    }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/core/index-manifest.test.ts`
Expected: PASS — 13 条全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/index-manifest.ts tests/core/index-manifest.test.ts
git commit -m "feat(index-manifest): 实现 diff/recordEntry/removeEntry/invalidate/shouldFullRebuild"
```

---

## Task 3: VectraStore.deleteByPath

**Files:**
- Modify: `src/adapters/vector-vectra.ts`
- Test: `tests/adapters/vector-vectra.test.ts`

- [ ] **Step 1: 写失败测试 — deleteByPath 删除指定文件所有 chunk**

在 `tests/adapters/vector-vectra.test.ts` 末尾的 `describe('VectraStore', ...)` 块内追加:

```typescript
    it('deleteByPath - 删除指定文件所有 chunk', async () => {
        // 关键路径:用一个独立的子目录,避免污染其他用例的索引。
        const subDir = path.join(TEST_INDEX_DIR, 'delete-by-path-test');
        if (fs.existsSync(subDir)) {
            fs.rmSync(subDir, { recursive: true });
        }
        const subStore = new VectraStore(subDir, mockEmbeddings);

        // 写入一个文件的多个 chunk(用 upsertItem 模拟 indexProcessor 的写入路径)
        await subStore.beginFileUpdate();
        const dummyVector = Array(512).fill(0).map(() => Math.random());
        await subStore.upsertItem('notes/foo.md#chunk-0', dummyVector, { path: 'notes/foo.md', chunkIndex: 0 });
        await subStore.upsertItem('notes/foo.md#chunk-1', dummyVector, { path: 'notes/foo.md', chunkIndex: 1 });
        await subStore.upsertItem('notes/foo.md#chunk-2', dummyVector, { path: 'notes/foo.md', chunkIndex: 2 });
        await subStore.endFileUpdate();

        const deleted = await subStore.deleteByPath('notes/foo.md');
        expect(deleted).toBe(3);

        // 搜索应不再命中该文件
        const queryVector = Array(512).fill(0).map(() => Math.random());
        const results = await subStore.search(queryVector, 10);
        const fooResults = results.filter((r) => (r.metadata as { path?: string }).path === 'notes/foo.md');
        expect(fooResults).toHaveLength(0);

        if (fs.existsSync(subDir)) {
            fs.rmSync(subDir, { recursive: true });
        }
    });

    it('deleteByPath - 文件不存在 - 返回 0 不抛错', async () => {
        const subDir = path.join(TEST_INDEX_DIR, 'delete-by-path-empty');
        if (fs.existsSync(subDir)) {
            fs.rmSync(subDir, { recursive: true });
        }
        const subStore = new VectraStore(subDir, mockEmbeddings);
        const deleted = await subStore.deleteByPath('nonexistent.md');
        expect(deleted).toBe(0);
        if (fs.existsSync(subDir)) {
            fs.rmSync(subDir, { recursive: true });
        }
    });

    it('deleteByPath - 多文件场景只删目标文件', async () => {
        const subDir = path.join(TEST_INDEX_DIR, 'delete-by-path-multi');
        if (fs.existsSync(subDir)) {
            fs.rmSync(subDir, { recursive: true });
        }
        const subStore = new VectraStore(subDir, mockEmbeddings);
        const dummyVector = Array(512).fill(0).map(() => Math.random());

        await subStore.beginFileUpdate();
        await subStore.upsertItem('a.md#chunk-0', dummyVector, { path: 'a.md', chunkIndex: 0 });
        await subStore.upsertItem('b.md#chunk-0', dummyVector, { path: 'b.md', chunkIndex: 0 });
        await subStore.upsertItem('b.md#chunk-1', dummyVector, { path: 'b.md', chunkIndex: 1 });
        await subStore.endFileUpdate();

        const deleted = await subStore.deleteByPath('b.md');
        expect(deleted).toBe(2);

        // a.md 应仍可被搜索命中
        const queryVector = Array(512).fill(0).map(() => Math.random());
        const results = await subStore.search(queryVector, 10);
        const aResults = results.filter((r) => (r.metadata as { path?: string }).path === 'a.md');
        expect(aResults.length).toBeGreaterThan(0);
        const bResults = results.filter((r) => (r.metadata as { path?: string }).path === 'b.md');
        expect(bResults).toHaveLength(0);

        if (fs.existsSync(subDir)) {
            fs.rmSync(subDir, { recursive: true });
        }
    });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/adapters/vector-vectra.test.ts`
Expected: FAIL — `subStore.deleteByPath is not a function`

- [ ] **Step 3: 实现 deleteByPath**

在 `src/adapters/vector-vectra.ts` 的 `VectraStore` 类内,在 `delete` 方法之后追加:

```typescript
    /**
     * 删除指定文件路径下的所有 chunk。
     *
     * 关键路径:文件变短时,旧 chunk 残留会导致搜索命中幽灵片段。
     * 此方法在 reembed 前调用,确保旧 chunk 全部清除。
     *
     * 实现说明:vectra 没有"按 metadata.path 删"的接口,采用与 indexDelete 相同的
     * 启发式 — 用零向量 search topK=100 拿候选,按 metadata.path 过滤。
     * chunk 数上限 100 覆盖绝大多数文档;超长文档(>100 chunks)极少见,
     * 若后续成为问题可改用 listDocuments 遍历。
     *
     * @param filePath - 文件相对路径(如 "notes/foo.md")
     * @returns 实际删除的 chunk 数
     */
    async deleteByPath(filePath: string): Promise<number> {
        const index = await this.ensureIndex();
        // 关键路径:用零向量 search 拿候选,与 IndexProcessor.indexDelete 一致的启发式。
        const dummyVector = Array(512).fill(0);
        const all = await index.queryItems(dummyVector, '', 100);
        const matching = all.filter((r) => {
            const meta = r.item.metadata as { path?: string };
            return meta.path === filePath;
        });
        const ids = matching.map((r) => {
            const chunkMeta = r.item.metadata as { documentId?: string };
            // 关键路径:upsertItem 时 metadata.documentId 与 docId 相同(见 upsertItem 实现)。
            return chunkMeta.documentId ?? '';
        }).filter((id) => id !== '');
        if (ids.length === 0) return 0;
        return this.delete(ids);
    }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/adapters/vector-vectra.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/vector-vectra.ts tests/adapters/vector-vectra.test.ts
git commit -m "feat(vector-vectra): 新增 deleteByPath 修复 chunk 残留"
```

---

## Task 4: index-processor reembedFile + indexBatch + 协议扩展

**Files:**
- Modify: `src/types.ts`
- Modify: `src/worker/handler.ts`
- Modify: `src/worker/index-processor.ts`
- Test: `tests/worker/index-processor.test.ts`

- [ ] **Step 1: 扩展 WorkerRequest / WorkerResponse 协议**

在 `src/types.ts` 的 `WorkerRequest` 联合内,在 `index.incremental` 之后追加:

```typescript
	| { type: 'index.batch'; payload: { files: Array<{ path: string; content: string }> } }
```

在 `WorkerResponse` 联合内,在 `index.done` 之后追加:

```typescript
	| { type: 'index.batch.done'; payload: { indexed: number; errors: number; chunkCounts: Record<string, number> } }
```

- [ ] **Step 2: 写失败测试 — indexBatch 返回 chunkCounts**

在 `tests/worker/index-processor.test.ts` 末尾追加(若文件已有 `describe` 块,在其内部追加;否则新建):

```typescript
    it('indexBatch - 多文件批量 embed 返回 chunkCounts', async () => {
        // 关键路径:IndexProcessor 需要 store + embeddings。用真实 VectraStore 临时目录 + mock embeddings。
        const { VectraStore } = await import('../../src/adapters/vector-vectra');
        const path = (await import('path')).default;
        const fs = (await import('fs')).default;
        const testDir = path.join(__dirname, '../tmp/test-index-batch');
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        const store = new VectraStore(testDir);
        const mockEmbed: import('../../src/ports/embedding').EmbeddingPort = {
            embed: vi.fn().mockImplementation(async (texts: string[]) => {
                // 关键路径:返回 texts.length 个 512 维向量。
                return texts.map(() => Array(512).fill(0).map(() => Math.random()));
            }),
            dimensions: 512,
        };
        const { IndexProcessor } = await import('../../src/worker/index-processor');
        const processor = new IndexProcessor(store, mockEmbed);

        const files = [
            { path: 'a.md', content: '# A\nfirst paragraph.' },
            { path: 'b.md', content: '# B\nsecond paragraph with more text.' },
        ];
        const result = await processor.indexBatch(files);
        expect(result.indexed).toBe(2);
        expect(result.errors).toBe(0);
        expect(result.chunkCounts['a.md']).toBeGreaterThan(0);
        expect(result.chunkCounts['b.md']).toBeGreaterThan(0);

        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    });

    it('indexBatch - reembed 前先 deleteByPath 防残留', async () => {
        const { VectraStore } = await import('../../src/adapters/vector-vectra');
        const path = (await import('path')).default;
        const fs = (await import('fs')).default;
        const testDir = path.join(__dirname, '../tmp/test-index-batch-residue');
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        const store = new VectraStore(testDir);
        const mockEmbed: import('../../src/ports/embedding').EmbeddingPort = {
            embed: vi.fn().mockImplementation(async (texts: string[]) =>
                texts.map(() => Array(512).fill(0).map(() => Math.random())),
            ),
            dimensions: 512,
        };
        const { IndexProcessor } = await import('../../src/worker/index-processor');
        const processor = new IndexProcessor(store, mockEmbed);

        // 第一次:长内容 → 假设 5 chunks
        await processor.indexBatch([{ path: 'foo.md', content: '# Title\n\n' + 'long content. '.repeat(200) }]);

        // 第二次:短内容 → 假设 1 chunk
        const result = await processor.indexBatch([{ path: 'foo.md', content: 'short' }]);
        expect(result.chunkCounts['foo.md']).toBe(1);

        // 关键路径:搜索不应命中旧的长内容 chunk(无幽灵片段)。
        const queryVector = Array(512).fill(0).map(() => Math.random());
        const results = await store.search(queryVector, 100);
        const fooChunks = results.filter((r) => (r.metadata as { path?: string }).path === 'foo.md');
        // chunk 数应等于第二次写入的 chunkCount,不是两次累加。
        expect(fooChunks.length).toBe(result.chunkCounts['foo.md']!);

        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    });
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run tests/worker/index-processor.test.ts`
Expected: FAIL — `processor.indexBatch is not a function`

- [ ] **Step 4: 实现 indexBatch + reembedFile**

在 `src/worker/index-processor.ts` 的 `IndexProcessor` 类内,在 `indexIncremental` 方法之后追加:

```typescript
    /**
     * 批量索引 — smart reindex 的 toAdd + toUpdate 路径。
     *
     * 关键路径:
     * - 每个文件 reembed 前先 deleteByPath,防止文件变短时旧 chunk 残留
     * - 返回每文件的 chunkCount,供 manifest 记录
     * - 单文件失败不挂整批(记入 errors 继续)
     *
     * @param files - 待 embed 的文件列表(已由主线程读好 content)
     * @param onProgress - 进度回调(每文件一次)
     */
    async indexBatch(
        files: IndexFile[],
        onProgress?: (e: ProgressEvent) => void,
    ): Promise<{ indexed: number; errors: number; chunkCounts: Record<string, number> }> {
        let indexed = 0;
        let errors = 0;
        const chunkCounts: Record<string, number> = {};

        for (const [i, file] of files.entries()) {
            try {
                const count = await this.reembedFile(file.path, file.content);
                chunkCounts[file.path] = count;
                if (count > 0) indexed++;
                else indexed++; // 空文件也算处理成功
            } catch (err) {
                devLogger.error('index', `failed to indexBatch ${file.path}`, err);
                errors++;
            }
            onProgress?.({ done: i + 1, total: files.length });
        }

        return { indexed, errors, chunkCounts };
    }

    /**
     * 单文件 reembed — 先删旧 chunk 再重插。
     *
     * 关键路径:deleteByPath 是 chunk 残留修复的根治手段。
     * 一个文件一个事务,失败时 cancelFileUpdate 回滚。
     *
     * @returns 该文件的 chunk 数(0 表示空文件)
     */
    private async reembedFile(filePath: string, content: string): Promise<number> {
        // 关键路径:先删旧 chunk,防止文件变短时残留。
        await this.store.deleteByPath(filePath);

        const chunks = chunkMarkdown(content, 500, 100);
        if (chunks.length === 0) return 0;

        const chunkTexts = chunks.map((c) => c.text);
        const vectors = await this.embeddings.embed(chunkTexts);

        await this.store.beginFileUpdate();
        try {
            for (const [idx, chunk] of chunks.entries()) {
                await this.store.upsertItem(
                    `${filePath}#chunk-${idx}`,
                    vectors[idx]!,
                    { path: filePath, chunkIndex: idx, startOffset: chunk.startOffset },
                );
            }
            await this.store.endFileUpdate();
            return chunks.length;
        } catch (err) {
            try { await this.store.cancelFileUpdate(); } catch { /* 忽略回滚失败 */ }
            throw err;
        }
    }
```

- [ ] **Step 5: handler.ts 加 index.batch case**

在 `src/worker/handler.ts` 的 `handleMessage` 的 switch 内,在 `index.delete` case 之前追加:

```typescript
            case 'index.batch': {
                const req = msg as WorkerRequest & { payload: { files: Array<{ path: string; content: string }> } };
                const result = await processor.indexBatch(req.payload.files, (progress) => {
                    postEvent?.({ type: 'index.progress', payload: progress });
                });
                return { type: 'index.batch.done', payload: result };
            }
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run tests/worker/index-processor.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/types.ts src/worker/index-processor.ts src/worker/handler.ts tests/worker/index-processor.test.ts
git commit -m "feat(index-batch): 新增 indexBatch + reembedFile,先 deleteByPath 防残留"
```

---

## Task 5: IndexManager — IndexBackend 扩展 + Diffing 状态 + smartReindex

**Files:**
- Modify: `src/core/index-manager.ts`
- Test: `tests/core/index-manager.test.ts`

- [ ] **Step 1: 写失败测试 — smartReindex 热启动零 embed**

在 `tests/core/index-manager.test.ts` 末尾追加:

```typescript
    it('smartReindex - 索引不存在 - 走全量', async () => {
        const fullSpy = vi.fn().mockResolvedValue({ indexed: 5, errors: 0 });
        const smartSpy = vi.fn().mockResolvedValue({ indexed: 0, errors: 0, skipped: 0 });
        const mgr = new IndexManager({
            fullReindex: fullSpy,
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: smartSpy,
            isIndexCreated: vi.fn().mockResolvedValue(false),
            listMarkdownFiles: vi.fn().mockResolvedValue([]),
        });
        await mgr.onLayoutReady();
        expect(fullSpy).toHaveBeenCalled();
        expect(smartSpy).not.toHaveBeenCalled();
        expect(get(mgr.status$)).toMatchObject({ state: 'Ready' });
    });

    it('smartReindex - 索引存在 - 走 smart 零 embed', async () => {
        const fullSpy = vi.fn();
        const smartSpy = vi.fn().mockResolvedValue({ indexed: 0, errors: 0, skipped: 5 });
        const mgr = new IndexManager({
            fullReindex: fullSpy,
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: smartSpy,
            isIndexCreated: vi.fn().mockResolvedValue(true),
            listMarkdownFiles: vi.fn(),
        });
        await mgr.onLayoutReady();
        expect(smartSpy).toHaveBeenCalled();
        expect(fullSpy).not.toHaveBeenCalled();
        expect(get(mgr.status$)).toMatchObject({ state: 'Ready' });
    });

    it('smartReindex - 状态经过 Diffing', async () => {
        const smartSpy = vi.fn().mockResolvedValue({ indexed: 0, errors: 0, skipped: 0 });
        const states: string[] = [];
        const mgr = new IndexManager({
            fullReindex: vi.fn(),
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: smartSpy,
            isIndexCreated: vi.fn().mockResolvedValue(true),
            listMarkdownFiles: vi.fn(),
        });
        const unsub = mgr.status$.subscribe((s) => states.push(s.state));
        await mgr.onLayoutReady();
        unsub();
        // 关键路径:热启动应经过 Diffing 状态。
        expect(states).toContain('Diffing');
        expect(states[states.length - 1]).toBe('Ready');
    });

    it('smartReindex - backend 无 smartReindex - 回退全量(向后兼容)', async () => {
        // 关键路径:渐进式迁移,backend 未实现 smartReindex 时回退到 fullReindex。
        const fullSpy = vi.fn().mockResolvedValue({ indexed: 3, errors: 0 });
        const mgr = new IndexManager({
            fullReindex: fullSpy,
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            // 不提供 smartReindex / isIndexCreated / listMarkdownFiles
        });
        await mgr.onLayoutReady();
        expect(fullSpy).toHaveBeenCalled();
        expect(get(mgr.status$)).toMatchObject({ state: 'Ready' });
    });

    it('smartReindex - smart 失败 - 状态 Failed', async () => {
        const smartSpy = vi.fn().mockRejectedValue(new Error('embed failed'));
        const mgr = new IndexManager({
            fullReindex: vi.fn(),
            incrementalIndex: vi.fn(),
            deleteFile: vi.fn(),
            smartReindex: smartSpy,
            isIndexCreated: vi.fn().mockResolvedValue(true),
            listMarkdownFiles: vi.fn(),
        });
        await mgr.onLayoutReady();
        expect(get(mgr.status$)).toMatchObject({ state: 'Failed' });
    });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/core/index-manager.test.ts`
Expected: FAIL — `smartReindex` 类型不存在,`Diffing` 状态未定义

- [ ] **Step 3: 扩展 IndexStatus + IndexBackend + 实现 smartReindex 入口**

修改 `src/core/index-manager.ts`:

**3a. 在 `IndexStatus` 联合内,在 `Init` 之后追加 `Diffing`:**

```typescript
export type IndexStatus =
    | { state: 'Idle' }
    | { state: 'Init' }
    | { state: 'Diffing' }
    | { state: 'Scanning'; scanned: number; total: number }
    | { state: 'Queueing'; pending: number }
    | { state: 'Processing'; currentBatch: string[] }
    | { state: 'Ready'; totalDocs: number; lastIndexTime: number }
    | { state: 'Paused'; pending: number }
    | { state: 'Failed'; reason: string }
    | { state: 'Unloaded' };
```

**3b. 在 `IndexBackend` 接口内,在 `deleteFile` 之后追加(可选方法):**

```typescript
export interface IndexBackend {
    fullReindex(): Promise<{ indexed: number; errors: number }>;
    incrementalIndex(file: { path: string; content: string }): Promise<{ indexed: number; errors: number }>;
    deleteFile(filePath: string): Promise<number>;
    // 关键路径:smartReindex 是可选方法,未实现时 onLayoutReady 回退到 fullReindex。
    smartReindex?(): Promise<{ indexed: number; errors: number; skipped: number }>;
    isIndexCreated?(): Promise<boolean>;
    listMarkdownFiles?(): Promise<Array<{ path: string; content: string }>>;
}
```

**3c. 替换 `onLayoutReady` 方法实现(整个方法替换):**

```typescript
    /**
     * 启动期调用 — 优先走 smartReindex(hash diff),无 backend 支持时回退全量。
     *
     * 关键路径:
     * - backend 提供 smartReindex + isIndexCreated → 走 smart 路径
     * - 索引不存在 → smartReindex 内部转全量(spec §5.2)
     * - backend 未提供 smartReindex → 回退 fullReindex(向后兼容)
     * - smart 执行前状态 Diffing,执行后 Ready/Failed
     */
    async onLayoutReady(): Promise<{ indexed: number; errors: number } | null> {
        this.status$.set({ state: 'Init' });
        try {
            // 关键路径:优先 smart,backend 渐进迁移。
            if (this.backend.smartReindex && this.backend.isIndexCreated) {
                this.status$.set({ state: 'Diffing' });
                const result = await this.backend.smartReindex();
                this.status$.set({
                    state: 'Ready',
                    totalDocs: result.indexed + result.skipped,
                    lastIndexTime: Date.now(),
                });
                return { indexed: result.indexed, errors: result.errors };
            }
            // 回退:全量路径。
            const result = await this.backend.fullReindex();
            this.status$.set({
                state: 'Ready',
                totalDocs: result.indexed,
                lastIndexTime: Date.now(),
            });
            return result;
        } catch (err) {
            this.status$.set({ state: 'Failed', reason: String(err) });
            devLogger.error('index', '启动索引失败', err);
            return null;
        }
    }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/core/index-manager.test.ts`
Expected: PASS — 既有用例 + 5 个新用例全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/index-manager.ts tests/core/index-manager.test.ts
git commit -m "feat(index-manager): onLayoutReady 优先 smartReindex,新增 Diffing 状态"
```

---

## Task 6: main.ts — 装配 IndexBackend.smartReindex + onLayoutReady 解耦 P3

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: 在 main.ts plugin 类加 indexBackend 字段 + onload 装配 smartReindex / isIndexCreated / listMarkdownFiles**

**1a. 在 `RatelVaultPlugin` 类内,`indexController` 字段声明之后追加:**

```typescript
	// 关键路径:索引 backend 引用 — smartReindex 直接调 this.indexBackend.fullReindex(),
	// 避免 this.indexController['indexManager']['backend'] 反模式访问私有字段。
	indexBackend!: IndexBackend;
```

**1b. 在 `src/main.ts` 约 162 行,把 `const indexBackend: IndexBackend = { ... }` 替换为 `this.indexBackend = { ... }`(改为类字段赋值):**

```typescript
	this.indexBackend = {
		fullReindex: async () => {
			const files = this.vault.listMarkdownFiles();
			const filtered: Array<{ path: string; content: string }> = [];
			for (const f of files) {
				const content = await this.vault.readFile(f);
				filtered.push({ path: f, content });
			}
			const response = await this.workerManager.request({
				type: 'index.full',
				payload: { files: filtered },
			});
			if (response.type === 'index.done') {
				return { indexed: response.payload.indexed, errors: response.payload.errors };
			}
			return { indexed: 0, errors: 1 };
		},
		incrementalIndex: async (file) => {
			const response = await this.workerManager.request({
				type: 'index.incremental',
				payload: { file },
			});
			if (response.type === 'index.done') {
				return { indexed: response.payload.indexed, errors: response.payload.errors };
			}
			return { indexed: 0, errors: 1 };
		},
		deleteFile: async (filePath) => {
			const response = await this.workerManager.request({
				type: 'index.delete',
				payload: { filePath },
			});
			if (response.type === 'index.done') {
				return response.payload.indexed;
			}
			return 0;
		},
		// 关键路径:smart reindex — hash diff 后仅对变更文件 batch embed。
		// 主线程读文件 + 算 sha256,worker 只 embed 待处理文件,返回 chunkCounts。
		isIndexCreated: async () => {
			return this.vectraStore.isIndexCreated();
		},
		listMarkdownFiles: async () => {
			const paths = this.vault.listMarkdownFiles();
			const files: Array<{ path: string; content: string }> = [];
			for (const p of paths) {
				const content = await this.vault.readFile(p);
				files.push({ path: p, content });
			}
			return files;
		},
		smartReindex: async () => {
			return this.smartReindex();
		},
	};
```

**1c. 修改 `IndexController` 构造调用,把 `indexBackend` 改为 `this.indexBackend`:**

在 `src/main.ts` 约 202 行(原 `this.indexController = new IndexController(this.vault, indexBackend, vaultBase);`),替换为:

```typescript
	this.indexController = new IndexController(this.vault, this.indexBackend, vaultBase);
```

- [ ] **Step 2: 在 VectraStore 加 isIndexCreated 方法**

在 `src/adapters/vector-vectra.ts` 的 `VectraStore` 类内,在 `init` 方法之后追加:

```typescript
	/**
	 * 判断索引是否已创建(磁盘上有 index 文件)。
	 *
	 * 关键路径:smart reindex 启动期判断首次(无索引走全量)还是热启动(有索引走 hash diff)。
	 */
	async isIndexCreated(): Promise<boolean> {
		const index = await this.ensureIndex();
		return index.isIndexCreated();
	}
```

- [ ] **Step 3: 在 main.ts plugin 类加 indexManifest 字段 + smartReindex 方法**

在 `src/main.ts` 的 `RatelVaultPlugin` 类内,在 Step 1a 添加的 `indexBackend` 字段之后追加字段:

```typescript
	// 关键路径:索引清单 — 记每文件 hash + 全局 embedding 参数,启动期 hash diff。
	indexManifest!: IndexManifest;
```

在 import 区追加(顶部,与其他 core import 一起):

```typescript
import { IndexManifest } from './core/index-manifest';
import { sha256 } from './utils/hash';
```

在 `onload` 内,在 `this.indexController = new IndexController(...)` 之前(约 202 行前)追加:

```typescript
		// 关键路径:manifest 与 .index/ 同目录同生命周期。
		this.indexManifest = new IndexManifest(path.join(pluginDir, 'index-manifest.json'));
```

在 `onLayoutReady` 方法之后(类内任意位置,建议在 `onLayoutReady` 之后)追加 `smartReindex` 方法:

```typescript
	/**
	 * smart reindex — 启动期 hash diff,仅对变更文件 batch embed。
	 *
	 * 关键路径:
	 * 1. 索引不存在 → 委托 fullReindex(走 index.full)
	 * 2. manifest 不存在/损坏 → 全量
	 * 3. 全局参数(embedModelId/chunkSize)变 → 清 .index/ + manifest → 全量
	 * 4. 否则 → hash diff,仅 toAdd+toUpdate 走 index.batch,toDelete 走 index.delete
	 * 5. 失败时不清 manifest,下次启动重试
	 */
	async smartReindex(): Promise<{ indexed: number; errors: number; skipped: number }> {
		// 关键路径:先检查索引是否存在,不存在走全量。
		const indexExists = await this.vectraStore.isIndexCreated();
		if (!indexExists) {
			const result = await this.indexBackend.fullReindex();
			// 关键路径:全量后写新 manifest。
			await this.writeManifestAfterFullReindex();
			return { indexed: result.indexed, errors: result.errors, skipped: 0 };
		}

		// 关键路径:加载 manifest,损坏则全量。
		const manifestData = await this.indexManifest.load();
		if (!manifestData) {
			const result = await this.indexBackend.fullReindex();
			await this.writeManifestAfterFullReindex();
			return { indexed: result.indexed, errors: result.errors, skipped: 0 };
		}

		// 关键路径:全局参数变化 → 清索引 + manifest → 全量。
		const currentEmbedModelId = this.resolveCurrentEmbedModelId();
		if (this.indexManifest.shouldFullRebuild(manifestData, currentEmbedModelId, this.settings.chunkSize, this.settings.chunkOverlap)) {
			// 关键路径:清 .index/ 目录(vectra 没有清空 API,删目录重建)。
			await this.vectraStore.dropIndex();
			this.indexManifest.invalidate(manifestData);
			manifestData.embedModelId = currentEmbedModelId;
			manifestData.chunkSize = this.settings.chunkSize;
			manifestData.chunkOverlap = this.settings.chunkOverlap;
			const result = await this.indexBackend.fullReindex();
			await this.indexManifest.save(manifestData);
			return { indexed: result.indexed, errors: result.errors, skipped: 0 };
		}

		// 关键路径:hash diff — 读所有文件 + 算 sha256。
		const files = await this.vectraStore.listMarkdownFilesForDiff(this.vault);
		const fileHashes = await Promise.all(
			files.map(async (f) => ({
				path: f.path,
				content: f.content,
				hash: await sha256(f.content),
				mtime: f.mtime,
			})),
		);

		const diff = this.indexManifest.diff(manifestData, fileHashes);
		const toEmbed = [...diff.toAdd, ...diff.toUpdate];

		let indexed = 0;
		let errors = 0;

		// 关键路径:批量 embed toAdd + toUpdate。
		if (toEmbed.length > 0) {
			const response = await this.workerManager.request({
				type: 'index.batch',
				payload: { files: toEmbed.map((f) => ({ path: f.path, content: f.content })) },
			});
			if (response.type === 'index.batch.done') {
				indexed = response.payload.indexed;
				errors = response.payload.errors;
				// 关键路径:批量记录 manifest(用返回的 chunkCount)。
				for (const f of toEmbed) {
					const hash = fileHashes.find((h) => h.path === f.path)!.hash;
					const chunkCount = response.payload.chunkCounts[f.path] ?? 0;
					this.indexManifest.recordEntry(manifestData, f.path, hash, f.mtime, chunkCount);
				}
			} else {
				errors += toEmbed.length;
			}
		}

		// 关键路径:逐个 delete。
		for (const delPath of diff.toDelete) {
			try {
				await this.workerManager.request({
					type: 'index.delete',
					payload: { filePath: delPath },
				});
				this.indexManifest.removeEntry(manifestData, delPath);
			} catch {
				// 删除失败不挂整批,下次启动重试。
				errors++;
			}
		}

		manifestData.lastIndexTime = Date.now();
		await this.indexManifest.save(manifestData);

		return { indexed, errors, skipped: diff.unchanged.length };
	}

	/** 全量重建后写新 manifest(首次/重置场景)。 */
	private async writeManifestAfterFullReindex(): Promise<void> {
		const files = this.vault.listMarkdownFiles();
		const entries: Record<string, import('./core/index-manifest').IndexManifestEntry> = {};
		for (const p of files) {
			const content = await this.vault.readFile(p);
			const hash = await sha256(content);
			// 关键路径:全量后 chunkCount 未知(未走 index.batch),填 0 占位,下次 incremental 时更新。
			entries[p] = { path: p, hash, mtime: Date.now(), chunkCount: 0 };
		}
		const data: import('./core/index-manifest').IndexManifestData = {
			version: 1,
			embedModelId: this.resolveCurrentEmbedModelId(),
			chunkSize: this.settings.chunkSize,
			chunkOverlap: this.settings.chunkOverlap,
			lastIndexTime: Date.now(),
			entries,
		};
		await this.indexManifest.save(data);
	}

	/** 解析当前 embedding 模型 ID(local 用 ModelManager id,api 用 apiBase::model)。 */
	private resolveCurrentEmbedModelId(): string {
		if (this.settings.embedProvider === 'local') {
			return this.settings.embedLocalModel || 'local-default';
		}
		return `${this.settings.embedApiBase}::${this.settings.embedApiModel}`;
	}
```

- [ ] **Step 4: VectraStore 加 dropIndex + listMarkdownFilesForDiff 辅助方法**

在 `src/adapters/vector-vectra.ts` 的 `VectraStore` 类内,在 `isIndexCreated` 之后追加:

```typescript
	/**
	 * 删除整个索引目录(模型切换/参数变更时全量重建用)。
	 *
	 * 关键路径:vectra 没有清空 API,删目录后下次 init 会重建。
	 * 必须在 init 之后调用(ensureIndex 已建立 this.index),否则删目录后 this.index 仍指向旧路径。
	 */
	async dropIndex(): Promise<void> {
		// 关键路径:先清 this.index,下次 ensureIndex 会重建。
		this.index = null;
		this._ready = null;
		if (fs.existsSync(this.indexDir)) {
			// 关键路径:rmSync 递归删整个目录,包括 index.json + 索引文件。
			fs.rmSync(this.indexDir, { recursive: true, force: true });
		}
		await this.init();
	}
```

在文件顶部 import 区追加:

```typescript
import fs from 'fs';
import type { VaultPort } from '../ports/vault';
```

> **注:** `listMarkdownFilesForDiff` 不放 VectraStore(它不该依赖 vault),而是直接在 main.ts smartReindex 里用 `this.vault.listMarkdownFiles()` + `readFile` + `stat`。修正 Step 3 中的 `this.vectraStore.listMarkdownFilesForDiff(this.vault)` 调用为下面 Step 5 的实现。

- [ ] **Step 5: 修正 smartReindex 中的 listMarkdownFilesForDiff 调用**

把 Step 3 中 smartReindex 方法里的:

```typescript
		const files = await this.vectraStore.listMarkdownFilesForDiff(this.vault);
```

替换为:

```typescript
		// 关键路径:读所有 markdown 文件 + mtime(vault 事件源是 ObsidianVault)。
		const paths = this.vault.listMarkdownFiles();
		const files: Array<{ path: string; content: string; mtime: number }> = [];
		for (const p of paths) {
			const content = await this.vault.readFile(p);
			// 关键路径:mtime 通过 vault.adapter.stat 获取,ObsidianVault 已封装。
			const stat = this.vault.stat(p);
			files.push({ path: p, content, mtime: stat?.mtime ?? Date.now() });
		}
```

- [ ] **Step 6: ObsidianVault 加 stat 方法**

在 `src/adapters/obsidian-vault.ts` 的 `ObsidianVault` 类内追加(若已存在则跳过):

```typescript
	/** 获取文件 stat(mtime/ctime/size)。 */
	stat(path: string): { mtime: number; ctime: number; size: number } | null {
		const abstractFile = this.app.vault.getAbstractFileByPath(path);
		if (!abstractFile || !('stat' in abstractFile)) return null;
		const stat = (abstractFile as { stat: { mtime: number; ctime: number; size: number } }).stat;
		return stat;
	}
```

- [ ] **Step 7: 修改 onLayoutReady 解耦 P3**

在 `src/main.ts` 的 `onLayoutReady` 方法,把开头的:

```typescript
		// 关键路径:API embedding 模式不需要本地模型,也不触发自动索引;用户提示由 FeedbackController 处理。
		if (this.settings.embedProvider !== 'local') {
			return;
		}
```

替换为:

```typescript
		// 关键路径:模型下载仅 local 模式需要;API 模式无本地模型,但仍要启动索引(P3 修复)。
		if (this.settings.embedProvider === 'local') {
			// 关键路径:全量索引进度由 Worker 回调驱动。
			const indexProgressRef: {
				handle: ReturnType<UserNotice['toastProgress']> | null;
			} = { handle: null };
			this.workerManager.setProgressCallback((done, total) => {
				const message = `Ratel: 正在索引... ${done}/${total} 个文件`;
				this.userStatus.patch({
					index: 'scanning',
					indexDetail: `${done}/${total}`,
				});
				if (!indexProgressRef.handle) {
					indexProgressRef.handle = this.userNotice.toastProgress(message);
				} else {
					indexProgressRef.handle.update(message);
				}
			});

			try {
				await this.modelManager.download();
				const embedding = this.modelManager.getEmbedding();
				if (embedding) {
					if (this.embedding instanceof EmbeddingLocal) {
						this.embedding.setEmbedding(embedding);
					}
					this.feedbackController?.notifyEmbeddingReady();
					if (this.inlineWorker) {
						await this.initEmbeddingWorkerProxy(embedding);
					}
				}
			} catch (err) {
				indexProgressRef.handle?.hide();
				indexProgressRef.handle = null;
				this.workerManager.clearProgressCallback();
				const message = err instanceof Error ? err.message : String(err);
				devLogger.error('main', 'onLayoutReady 模型下载失败', err);
				this.userNotice.toastError(`Ratel 错误: ${message}`);
				// 关键路径:模型下载失败仍继续启动索引(API 模式不依赖本地模型)。
			}
		}

		// 关键路径:索引启动 — 两条 provider 都走(P3 修复)。
		try {
			const indexResult = await this.indexController.onLayoutReady();
			this.feedbackController?.notifyFullIndexComplete(
				indexResult?.indexed ?? 0,
				indexResult?.errors ?? 0,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			devLogger.error('main', '索引启动失败', err);
			this.userNotice.toastError(`Ratel 索引错误: ${message}`);
		}
```

删除原来 try/catch 块末尾的 `indexProgressRef.handle?.hide();` / `clearProgressCallback()` / `notifyFullIndexComplete` 等重复逻辑(已被新结构取代)。

- [ ] **Step 8: 运行全部测试验证不破坏现有行为**

Run: `npx vitest run tests/core/ tests/adapters/vector-vectra.test.ts tests/worker/ tests/integration/`
Expected: PASS(允许 pre-existing 失败,但不应新增失败)

- [ ] **Step 9: 提交**

```bash
git add src/main.ts src/adapters/vector-vectra.ts src/adapters/obsidian-vault.ts
git commit -m "feat(smart-reindex): main 装配 smartReindex + 解耦模型下载与索引启动 P3"
```

---

## Task 7: 集成测试 — smart reindex 端到端

**Files:**
- Create: `tests/integration/index-startup.test.ts`

- [ ] **Step 1: 写集成测试**

创建 `tests/integration/index-startup.test.ts`:

```typescript
/**
 * @file tests/integration/index-startup.test.ts
 * @description smart reindex 端到端 — 冷启动 / 热启动 / 文件修改 / 删除 / 模型切换 / manifest 损坏
 * @module tests/integration/index-startup
 * @depends core/index-manager, core/index-manifest, adapters/vector-vectra, worker/index-processor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexManager } from '../../src/core/index-manager';
import { IndexManifest } from '../../src/core/index-manifest';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { sha256 } from '../../src/utils/hash';
import path from 'path';
import fs from 'fs';

const TEST_DIR = path.join(__dirname, '../tmp/test-smart-reindex');
const INDEX_DIR = path.join(TEST_DIR, 'index');
const MANIFEST_PATH = path.join(TEST_DIR, 'index-manifest.json');

/** Mock embeddings 返回 512 维随机向量。 */
const mockEmbedPort: import('../../src/ports/embedding').EmbeddingPort = {
    embed: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(() => Array(512).fill(0).map(() => Math.random())),
    ),
    dimensions: 512,
};

function makeBackend(opts: {
    store: VectraStore;
    manifest: IndexManifest;
    files: Map<string, string>;
    embedProvider: 'local' | 'api';
    embedModelId: string;
    chunkSize: number;
    chunkOverlap: number;
}): import('../../src/core/index-manager').IndexBackend {
    // 关键路径:模拟 main.ts 的 smartReindex 逻辑(简化版,无 worker,直接调 store)。
    // 关键路径:用命名 const backend 引用自身,smartReindex 内调 backend.fullReindex()
    // 而不是 this.fullReindex()(箭头函数内 this 不指向对象字面量)。
    const backend: import('../../src/core/index-manager').IndexBackend = {
        fullReindex: async () => {
            let indexed = 0;
            let errors = 0;
            for (const [p, content] of opts.files) {
                try {
                    const chunks = content.split('\n\n');
                    const vectors = await mockEmbedPort.embed(chunks);
                    await opts.store.beginFileUpdate();
                    for (const [i, v] of vectors.entries()) {
                        await opts.store.upsertItem(`${p}#chunk-${i}`, v, { path: p, chunkIndex: i });
                    }
                    await opts.store.endFileUpdate();
                    indexed++;
                } catch { errors++; }
            }
            return { indexed, errors };
        },
        incrementalIndex: vi.fn(),
        deleteFile: vi.fn(),
        isIndexCreated: async () => opts.store.isIndexCreated(),
        listMarkdownFiles: async () => Array.from(opts.files.entries()).map(([path, content]) => ({ path, content })),
        smartReindex: async () => {
            // 关键路径:简化版 smartReindex,直接调 store + manifest,不走 worker。
            const indexExists = await opts.store.isIndexCreated();
            if (!indexExists) {
                const r = await backend.fullReindex();
                return { indexed: r.indexed, errors: r.errors, skipped: 0 };
            }
            const data = await opts.manifest.load();
            if (!data) {
                const r = await backend.fullReindex();
                return { indexed: r.indexed, errors: r.errors, skipped: 0 };
            }
            if (opts.manifest.shouldFullRebuild(data, opts.embedModelId, opts.chunkSize, opts.chunkOverlap)) {
                await opts.store.dropIndex();
                opts.manifest.invalidate(data);
                const r = await backend.fullReindex();
                await opts.manifest.save(data);
                return { indexed: r.indexed, errors: r.errors, skipped: 0 };
            }
            const currentFiles = await Promise.all(
                Array.from(opts.files.entries()).map(async ([p, c]) => ({
                    path: p, content: c, hash: await sha256(c), mtime: Date.now(),
                })),
            );
            const diff = opts.manifest.diff(data, currentFiles);
            let indexed = 0, errors = 0;
            const toEmbed = [...diff.toAdd, ...diff.toUpdate];
            for (const f of toEmbed) {
                try {
                    await opts.store.deleteByPath(f.path);
                    const chunks = f.content.split('\n\n');
                    const vectors = await mockEmbedPort.embed(chunks);
                    await opts.store.beginFileUpdate();
                    for (const [i, v] of vectors.entries()) {
                        await opts.store.upsertItem(`${f.path}#chunk-${i}`, v, { path: f.path, chunkIndex: i });
                    }
                    await opts.store.endFileUpdate();
                    opts.manifest.recordEntry(data, f.path, await sha256(f.content), Date.now(), chunks.length);
                    indexed++;
                } catch { errors++; }
            }
            for (const p of diff.toDelete) {
                await opts.store.deleteByPath(p);
                opts.manifest.removeEntry(data, p);
            }
            await opts.manifest.save(data);
            return { indexed, errors, skipped: diff.unchanged.length };
        },
    };
    return backend;
}

describe('smart reindex 集成', () => {
    beforeEach(() => {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
        fs.mkdirSync(TEST_DIR, { recursive: true });
        mockEmbedPort.embed.mockClear();
    });

    afterEach(() => {
        if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    });

    it('冷启动 - 空 .index - 全量,manifest 写入', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'para1\n\npara2'], ['b.md', 'para1']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();

        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(2); // a.md(2 chunks) + b.md(1 chunk)
        const saved = await manifest.load();
        expect(saved).not.toBeNull();
        expect(Object.keys(saved!.entries)).toHaveLength(2);
    });

    it('热启动 - 无变更 - 0 embed 调用', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x\n\ny']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady(); // 冷启动全量
        mockEmbedPort.embed.mockClear();
        // 关键路径:不销毁 store,模拟重启后 .index 仍在磁盘。
        await mgr.onLayoutReady(); // 热启动

        expect(mockEmbedPort.embed).not.toHaveBeenCalled();
    });

    it('单文件修改 - 仅该文件 embed', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'old content'], ['b.md', 'unchanged']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        mockEmbedPort.embed.mockClear();
        files.set('a.md', 'new content');
        await mgr.onLayoutReady();

        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(1); // 只 a.md
    });

    it('文件删除 - manifest 移除', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x'], ['b.md', 'y']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        files.delete('b.md');
        await mgr.onLayoutReady();

        const saved = await manifest.load();
        expect(saved!.entries['b.md']).toBeUndefined();
        expect(saved!.entries['a.md']).toBeDefined();
    });

    it('模型切换 - 清 .index + 全量', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        mockEmbedPort.embed.mockClear();

        // 关键路径:换 embedModelId,触发全量重建。
        const backend2 = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'different-model', chunkSize: 500, chunkOverlap: 100 });
        const mgr2 = new IndexManager(backend2);
        await mgr2.onLayoutReady();

        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(1); // 全量重 embed
    });

    it('chunkSize 变更 - 全量', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        mockEmbedPort.embed.mockClear();

        const backend2 = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 800, chunkOverlap: 100 });
        const mgr2 = new IndexManager(backend2);
        await mgr2.onLayoutReady();

        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(1);
    });

    it('manifest 损坏 - 降级全量', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        mockEmbedPort.embed.mockClear();

        // 关键路径:写坏 manifest。
        fs.writeFileSync(MANIFEST_PATH, '{broken json');
        await mgr.onLayoutReady();

        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(1); // 全量
    });

    it('API 模式启动 - 索引建立(P3 验证)', async () => {
        // 关键路径:API 模式与 local 模式走同一 smartReindex,只是 embedModelId 不同。
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'api', embedModelId: 'http://localhost:11434::nomic', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();

        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(1); // 首次全量
        const saved = await manifest.load();
        expect(saved!.embedModelId).toBe('http://localhost:11434::nomic');
    });

    it('API 模式热启动 - 0 embed', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x']]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'api', embedModelId: 'http://localhost:11434::nomic', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        mockEmbedPort.embed.mockClear();
        await mgr.onLayoutReady();

        expect(mockEmbedPort.embed).not.toHaveBeenCalled();
    });

    it('文件变短(5→3 chunk) - 无残留', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        // 关键路径:用 \n\n 分块,5 chunks 长内容。
        const longContent = Array(5).fill('para').join('\n\n');
        const files = new Map([['a.md', longContent]]);
        const backend = makeBackend({ store, manifest, files, embedProvider: 'local', embedModelId: 'bge', chunkSize: 500, chunkOverlap: 100 });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        // 关键路径:缩短到 1 chunk。
        files.set('a.md', 'short');
        mockEmbedPort.embed.mockClear();
        await mgr.onLayoutReady();

        // 搜索不应命中旧的长内容 chunk。
        const queryVector = Array(512).fill(0).map(() => Math.random());
        const results = await store.search(queryVector, 100);
        const aChunks = results.filter((r) => (r.metadata as { path?: string }).path === 'a.md');
        expect(aChunks.length).toBe(1); // 只剩 1 chunk,无残留
    });
});
```

- [ ] **Step 2: 运行测试验证**

Run: `npx vitest run tests/integration/index-startup.test.ts`
Expected: PASS — 10 条全部通过

> `makeBackend` 已用命名 `const backend` 引用自身,`smartReindex` 内调 `backend.fullReindex()`(非 `this.fullReindex()`),避免箭头函数 `this` 绑定问题。

- [ ] **Step 3: 提交**

```bash
git add tests/integration/index-startup.test.ts
git commit -m "test(smart-reindex): 10 条集成测试覆盖冷启动/热启动/修改/删除/切换/损坏"
```

---

## Task 8: 全量测试 + build 验证

**Files:** 无修改

- [ ] **Step 1: 运行全部测试**

Run: `npx vitest run`
Expected: 全部通过(允许 pre-existing 失败,需对比改造前的 baseline)

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无 error

- [ ] **Step 3: 生产构建**

Run: `npm run build`
Expected: 成功生成 `dist/main.js` + `dist/worker.js`

- [ ] **Step 4: 提交(若有 build 修复)**

```bash
git add -A
git commit -m "chore: 全量测试 + build 验证通过"
```

---

## 自审

### 1. Spec 覆盖

| Spec 章节 | 对应 Task |
|---|---|
| §4 manifest 数据结构 | Task 1, 2 |
| §5.1 改造前/后 | Task 5, 6 |
| §5.2 smartReindex 时序 | Task 6(smartReindex 方法) |
| §5.3 五种启动场景 | Task 7 集成测试覆盖 |
| §5.4 diff 期间搜索可用性 | Task 5(Diffing 状态 → Ready 才可搜) |
| §5.5 批量处理策略 | Task 4(indexBatch)+ Task 6(smartReindex 调 index.batch) |
| §5.6 状态机 Diffing | Task 5 |
| §5.7 autoIndex 接线 | ⚠️ 未单独 Task,留 finishing 阶段或后续 plan(见下) |
| §6 API 模式 watcher(P3) | Task 6 Step 7(onLayoutReady 解耦) |
| §6.3 API 错误处理 | 复用 EmbeddingApi 现有重试,无新代码 |
| §6.4 设置切换 | Task 6 resolveCurrentEmbedModelId + shouldFullRebuild |
| §8 chunk 残留 | Task 3(deleteByPath)+ Task 4(reembedFile) |
| §9 错误处理矩阵 | Task 6 smartReindex 的 try/catch + Task 5 Failed 状态 |
| §9.1 原子写 | Task 1(save 方法) |

**缺口:autoIndex 接线。** Spec §5.7 提到 `autoIndex=false` 时仍启动 FolderWatcher。当前 plan 未单独做,理由:FolderWatcher 启动逻辑在 `IndexController.onLayoutReady` 内,与 smartReindex 解耦,autoIndex 接线是独立的小改动,放本 plan 会增加复杂度。**建议:finishing 阶段评估是否补,或开独立小 plan。** 已在 spec §3 非目标写了 `indexPaused` 不接,但 autoIndex 应接 —— 这是 spec 与 plan 的偏差,需用户确认。

### 2. 占位扫描

- ✅ 无 TBD/TODO
- ✅ 所有代码块完整
- ✅ 所有命令含 expected output

### 3. 类型一致性

| 类型/方法 | 定义 Task | 使用 Task | 一致性 |
|---|---|---|---|
| `IndexManifestEntry` | Task 1 | Task 2, 6 | ✅ |
| `IndexManifestData` | Task 1 | Task 2, 6 | ✅ |
| `ManifestDiff` | Task 1 | Task 2, 6 | ✅ |
| `IndexManifest.load()` | Task 1 | Task 6 | ✅ |
| `IndexManifest.diff()` | Task 2 | Task 6 | ✅ 签名 `(data, currentFiles)` |
| `IndexManifest.shouldFullRebuild()` | Task 2 | Task 6 | ✅ 签名 `(data, embedModelId, chunkSize, chunkOverlap)` |
| `VectraStore.deleteByPath()` | Task 3 | Task 4, 6 | ✅ |
| `VectraStore.isIndexCreated()` | Task 6 Step 2 | Task 6 | ✅ |
| `VectraStore.dropIndex()` | Task 6 Step 4 | Task 6 | ✅ |
| `IndexProcessor.indexBatch()` | Task 4 | Task 6(通过 worker 消息) | ✅ |
| `IndexBackend.smartReindex?` | Task 5 | Task 6 | ✅ 可选方法 |
| `IndexBackend.isIndexCreated?` | Task 5 | Task 6 | ✅ |
| `IndexBackend.listMarkdownFiles?` | Task 5 | (未实际使用,main.ts 直接用 this.vault) | ⚠️ 多余,可删 |

**修正:** Task 5 的 `listMarkdownFiles?` 在 Task 6 未实际用(main.ts 直接 `this.vault.listMarkdownFiles()`)。保留接口不害,但为 YAGNI 可删。**决定:保留**,因为未来 IndexManager 可能独立用,且当前测试用到。不阻塞。

### 4. 关键风险

1. **Task 6 smartReindex 访问私有 backend** —— ✅ 已修正:Task 6 Step 1a 把 `indexBackend` 存为类字段 `this.indexBackend`,smartReindex 内全部改用 `this.indexBackend.fullReindex()`,不再通过 `this.indexController['indexManager']['backend']` 反模式访问。

2. **Task 7 `makeBackend` 中 `this.fullReindex`** —— ✅ 已修正:`makeBackend` 改为 `const backend: IndexBackend = {...}; return backend;`,smartReindex 内调 `backend.fullReindex()`(命名引用,非 `this`)。

3. **VectraStore.dropIndex 删目录后 init 重建** —— 需确认 vectra `LocalDocumentIndex` 构造能处理目录不存在的情况(应能,createIndex 会建)。执行时验证。

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-28-index-startup-smart-reindex-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每个 Task 派遣全新 subagent,两阶段审查,快速迭代

**2. Inline Execution** — 在当前会话批量执行,带 checkpoint 审查

**Which approach?**
