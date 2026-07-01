/**
 * @file tests/integration/index-startup.test.ts
 * @description smart reindex 端到端 — 冷启动 / 热启动 / 文件修改 / 删除 / 模型切换 / manifest 损坏
 * @module tests/integration/index-startup
 * @depends core/index-manager, core/index-manifest, adapters/vector-vectra, utils/hash
 * @run `npx vitest run tests/integration/index-startup.test.ts`(默认 vitest.config.ts 排除 integration 目录)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexManager, type IndexBackend } from '../../src/core/index-manager';
import { IndexManifest, type IndexManifestData, type IndexManifestEntry } from '../../src/core/index-manifest';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { EmbeddingPort } from '../../src/ports/embedding';
import { sha256 } from '../../src/utils/hash';
import path from 'path';
import fs from 'fs';

const TEST_DIR = path.join(__dirname, '../tmp/test-smart-reindex');
const INDEX_DIR = path.join(TEST_DIR, 'index');
const MANIFEST_PATH = path.join(TEST_DIR, 'index-manifest.json');

/**
 * Mock embeddings — 返回 512 维随机向量。
 *
 * 关键路径:适配 EmbeddingPort 契约(必须含 modelId),由 makeBackend 内部调用,
 * 不注入 VectraStore(VectraStore 用 upsertItem 走预计算向量路径,不需要 embeddings)。
 */
const mockEmbedPort: EmbeddingPort = {
    embed: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(() => Array(512).fill(0).map(() => Math.random())),
    ),
    dimensions: 512,
    modelId: 'mock-bge',
};

/**
 * 全量重建后写新 manifest — 模拟 main.ts 的 writeManifestAfterFullReindex。
 *
 * 关键路径:plan 原始 makeBackend 在「索引不存在」与「manifest 损坏」两个分支只调 fullReindex
 * 不写 manifest,会导致冷启动测试 `expect(saved).not.toBeNull()` 失败。
 * 此处补全 manifest 写入,与 main.ts 行为对齐。
 */
async function writeManifestAfterFullReindex(
    manifest: IndexManifest,
    files: Map<string, string>,
    embedModelId: string,
    chunkSize: number,
    chunkOverlap: number,
): Promise<void> {
    const entries: Record<string, IndexManifestEntry> = {};
    for (const [p, content] of files) {
        const hash = await sha256(content);
        // 关键路径:用 \n\n 分块与 makeBackend.fullReindex 一致,chunkCount 准确反映切片数。
        const chunkCount = content.split('\n\n').length;
        entries[p] = { path: p, hash, mtime: Date.now(), chunkCount };
    }
    const data: IndexManifestData = {
        version: 1,
        embedModelId,
        chunkSize,
        chunkOverlap,
        lastIndexTime: Date.now(),
        entries,
    };
    await manifest.save(data);
}

/**
 * 构建测试用 IndexBackend,模拟 main.ts 的 smartReindex 逻辑(简化版,无 worker)。
 *
 * 关键路径:用命名 const backend 引用自身,smartReindex 内调 backend.fullReindex()
 * 而非 this.fullReindex()(箭头函数内 this 不指向对象字面量)。
 *
 * @param opts - store/manifest/files/embedProvider/embedModelId/chunkSize/chunkOverlap
 * @returns 完整 IndexBackend 实现(含 smartReindex 四分支)
 */
function makeBackend(opts: {
    store: VectraStore;
    manifest: IndexManifest;
    files: Map<string, string>;
    embedProvider: 'local' | 'api';
    embedModelId: string;
    chunkSize: number;
    chunkOverlap: number;
}): IndexBackend {
    // 关键路径:模拟 main.ts 的 smartReindex 逻辑(简化版,无 worker,直接调 store)。
    // 关键路径:用命名 const backend 引用自身,smartReindex 内调 backend.fullReindex()
    // 而不是 this.fullReindex()(箭头函数内 this 不指向对象字面量)。
    const backend: IndexBackend = {
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
                } catch {
                    errors++;
                }
            }
            return { indexed, errors };
        },
        incrementalIndex: vi.fn(),
        deleteFile: vi.fn(),
        isIndexCreated: async () => opts.store.isIndexCreated(),
        listMarkdownFiles: async () =>
            Array.from(opts.files.entries()).map(([path, content]) => ({ path, content })),
        smartReindex: async () => {
            // 关键路径:简化版 smartReindex,直接调 store + manifest,不走 worker。
            const indexExists = await opts.store.isIndexCreated();
            if (!indexExists) {
                const r = await backend.fullReindex();
                // 关键路径:全量后写新 manifest(与 main.ts writeManifestAfterFullReindex 对齐)。
                await writeManifestAfterFullReindex(
                    opts.manifest,
                    opts.files,
                    opts.embedModelId,
                    opts.chunkSize,
                    opts.chunkOverlap,
                );
                return { indexed: r.indexed, errors: r.errors, skipped: 0 };
            }
            const data = await opts.manifest.load();
            if (!data) {
                const r = await backend.fullReindex();
                await writeManifestAfterFullReindex(
                    opts.manifest,
                    opts.files,
                    opts.embedModelId,
                    opts.chunkSize,
                    opts.chunkOverlap,
                );
                return { indexed: r.indexed, errors: r.errors, skipped: 0 };
            }
            if (
                opts.manifest.shouldFullRebuild(
                    data,
                    opts.embedModelId,
                    opts.chunkSize,
                    opts.chunkOverlap,
                )
            ) {
                await opts.store.dropIndex();
                opts.manifest.invalidate(data);
                // 关键路径:更新全局参数到新值(与 main.ts 行 485-487 对齐),
                // 否则下次启动 shouldFullRebuild 仍会触发重复全量。
                data.embedModelId = opts.embedModelId;
                data.chunkSize = opts.chunkSize;
                data.chunkOverlap = opts.chunkOverlap;
                const r = await backend.fullReindex();
                await opts.manifest.save(data);
                return { indexed: r.indexed, errors: r.errors, skipped: 0 };
            }
            const currentFiles = await Promise.all(
                Array.from(opts.files.entries()).map(async ([p, c]) => ({
                    path: p,
                    content: c,
                    hash: await sha256(c),
                    mtime: Date.now(),
                })),
            );
            const diff = opts.manifest.diff(data, currentFiles);
            let indexed = 0;
            let errors = 0;
            const toEmbed = [...diff.toAdd, ...diff.toUpdate];
            for (const f of toEmbed) {
                try {
                    await opts.store.deleteByPath(f.path);
                    const chunks = f.content.split('\n\n');
                    const vectors = await mockEmbedPort.embed(chunks);
                    await opts.store.beginFileUpdate();
                    for (const [i, v] of vectors.entries()) {
                        await opts.store.upsertItem(`${f.path}#chunk-${i}`, v, {
                            path: f.path,
                            chunkIndex: i,
                        });
                    }
                    await opts.store.endFileUpdate();
                    opts.manifest.recordEntry(
                        data,
                        f.path,
                        await sha256(f.content),
                        Date.now(),
                        chunks.length,
                    );
                    indexed++;
                } catch {
                    errors++;
                }
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
        const files = new Map([
            ['a.md', 'para1\n\npara2'],
            ['b.md', 'para1'],
        ]);
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 500,
            chunkOverlap: 100,
        });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();

        // 关键路径:a.md(2 chunks)+ b.md(1 chunk),每文件一次 embed 调用,共 2 次。
        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(2);
        const saved = await manifest.load();
        expect(saved).not.toBeNull();
        expect(Object.keys(saved!.entries)).toHaveLength(2);
    });

    it('热启动 - 无变更 - 0 embed 调用', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x\n\ny']]);
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 500,
            chunkOverlap: 100,
        });
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
        const files = new Map([
            ['a.md', 'old content'],
            ['b.md', 'unchanged'],
        ]);
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 500,
            chunkOverlap: 100,
        });
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
        const files = new Map([
            ['a.md', 'x'],
            ['b.md', 'y'],
        ]);
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 500,
            chunkOverlap: 100,
        });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        files.delete('b.md');
        await mgr.onLayoutReady();

        const saved = await manifest.load();
        expect(saved!.entries['b.md']).toBeUndefined();
        expect(saved!.entries['a.md']).toBeDefined();
        // 关键路径:验证 vectra 中无幽灵 chunk(不只是 manifest 移除)。
        const queryVector = Array(512).fill(0).map(() => Math.random());
        const results = await store.search(queryVector, 100);
        const bChunks = results.filter((r) => (r.metadata as { path?: string }).path === 'b.md');
        expect(bChunks).toHaveLength(0); // b.md 的 chunk 应全部删除
    });

    it('模型切换 - 清 .index + 全量', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x']]);
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 500,
            chunkOverlap: 100,
        });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        mockEmbedPort.embed.mockClear();

        // 关键路径:换 embedModelId,触发全量重建。
        const backend2 = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'different-model',
            chunkSize: 500,
            chunkOverlap: 100,
        });
        const mgr2 = new IndexManager(backend2);
        await mgr2.onLayoutReady();

        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(1); // 全量重 embed
    });

    it('chunkSize 变更 - 全量', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x']]);
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 500,
            chunkOverlap: 100,
        });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        mockEmbedPort.embed.mockClear();

        const backend2 = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 800,
            chunkOverlap: 100,
        });
        const mgr2 = new IndexManager(backend2);
        await mgr2.onLayoutReady();

        expect(mockEmbedPort.embed).toHaveBeenCalledTimes(1);
    });

    it('manifest 损坏 - 降级全量', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        const files = new Map([['a.md', 'x']]);
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 500,
            chunkOverlap: 100,
        });
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
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'api',
            embedModelId: 'http://localhost:11434::nomic',
            chunkSize: 500,
            chunkOverlap: 100,
        });
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
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'api',
            embedModelId: 'http://localhost:11434::nomic',
            chunkSize: 500,
            chunkOverlap: 100,
        });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        mockEmbedPort.embed.mockClear();
        await mgr.onLayoutReady();

        expect(mockEmbedPort.embed).not.toHaveBeenCalled();
    });

    it('文件变短(5→1 chunk) - 无残留', async () => {
        const store = new VectraStore(INDEX_DIR);
        const manifest = new IndexManifest(MANIFEST_PATH);
        // 关键路径:用 \n\n 分块,5 chunks 长内容。
        const longContent = Array(5).fill('para').join('\n\n');
        const files = new Map([['a.md', longContent]]);
        const backend = makeBackend({
            store,
            manifest,
            files,
            embedProvider: 'local',
            embedModelId: 'bge',
            chunkSize: 500,
            chunkOverlap: 100,
        });
        const mgr = new IndexManager(backend);

        await mgr.onLayoutReady();
        // 关键路径:缩短到 1 chunk。
        files.set('a.md', 'short');
        mockEmbedPort.embed.mockClear();
        await mgr.onLayoutReady();

        // 关键路径:搜索不应命中旧的长内容 chunk,只剩 1 个 a.md 文档聚合。
        const queryVector = Array(512)
            .fill(0)
            .map(() => Math.random());
        const results = await store.search(queryVector, 100);
        const aChunks = results.filter((r) => (r.metadata as { path?: string }).path === 'a.md');
        expect(aChunks.length).toBe(1); // 只剩 1 chunk,无残留
    });
});
