/**
 * @file tests/worker/index-processor.test.ts
 * @description IndexProcessor 行为 — indexFull / indexIncremental / indexDelete / vectorSearch / status,
 *   以及新存储契约下的单事务替换、原子存储注入与提交失败恢复
 * @module tests/worker/index-processor
 * @depends worker/index-processor, adapters/vector-vectra, adapters/atomic-index-storage, ports/embedding
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexProcessor } from '../../src/worker/index-processor';
import { VectraStore } from '../../src/adapters/vector-vectra';
import { AtomicIndexStorage } from '../../src/adapters/atomic-index-storage';
import type { AtomicWriteFileSystem, AtomicWriteHandle } from '../../src/adapters/atomic-index-storage';
import { chunkMarkdown } from '../../src/worker/chunker';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import type { EmbeddingPort } from '../../src/ports/embedding';
import fsp from 'node:fs/promises';
import path from 'path';
import fs from 'fs';

const TMP_DIR = path.join(__dirname, '../tmp/index-processor-test');

const stubEmbedder: EmbeddingsModel = {
    maxTokens: 8192,
    async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
        const arr = Array.isArray(inputs) ? inputs : [inputs];
        return {
            status: 'success',
            output: arr.map(() => Array(512).fill(0).map(() => Math.random())),
        };
    },
};

/**
 * 默认分块参数 — 1 字符 = 1 token,便于断言块数。
 *
 * 关键路径:分块参数由构造时注入(IndexProcessor 不再硬编码 500/100)。
 */
const DEFAULT_CHUNK_OPTIONS = {
    maxTokens: 500,
    overlapTokens: 100,
    count: (t: string) => t.length,
};

describe('IndexProcessor', () => {
    let store: VectraStore;
    let processor: IndexProcessor;
    let embedCallCount: number;

    const mockEmbedding: EmbeddingPort = {
        dimensions: 512,
        modelId: 'test:mock',
        async embed(texts: string[]): Promise<number[][]> {
            embedCallCount++;
            return texts.map(() => Array(512).fill(0).map(() => Math.random()));
        },
    };

    beforeEach(async () => {
        if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
        fs.mkdirSync(TMP_DIR, { recursive: true });
        embedCallCount = 0;
        store = new VectraStore(TMP_DIR, { embeddings: stubEmbedder, autoInit: true });
        await store.init();
        processor = new IndexProcessor(store, mockEmbedding, DEFAULT_CHUNK_OPTIONS);
    });

    afterEach(() => {
        if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
    });

    it('indexFull - 推送 done + errors 计数', async () => {
        const progressEvents: Array<{ done: number; total: number }> = [];
        const result = await processor.indexFull(
            [{ path: 'a.md', content: 'Hello world' }, { path: 'b.md', content: 'Foo bar' }],
            (e) => progressEvents.push(e),
        );
        expect(result.indexed).toBe(2);
        expect(result.errors).toBe(0);
        expect(progressEvents.length).toBeGreaterThan(0);
        expect(progressEvents.at(-1)).toEqual({ done: 2, total: 2 });
    });

    it('indexIncremental - 单文件 upsert + 进度推 1 次', async () => {
        const progressEvents: Array<{ done: number; total: number }> = [];
        await processor.indexIncremental(
            { path: 'c.md', content: 'Single doc' },
            (e) => progressEvents.push(e),
        );
        expect(progressEvents).toEqual([{ done: 1, total: 1 }]);
        const status = await store.status();
        expect(status.totalDocs).toBeGreaterThan(0);
    });

    it('indexDelete - 文档被删', async () => {
        await processor.indexIncremental({ path: 'd.md', content: 'to be deleted' });
        const result = await processor.indexDelete('d.md');
        expect(result).toBe(1);
    });

    it('vectorSearch - 返 topK 文档', async () => {
        await processor.indexFull(
            [{ path: 'e.md', content: 'Apple' }, { path: 'f.md', content: 'Banana' }],
        );
        const results = await processor.vectorSearch(Array(512).fill(0.5), 2);
        expect(results.length).toBe(2);
    });

    it('status - 真实数据而非 0', async () => {
        await processor.indexFull([{ path: 'g.md', content: 'Status test' }]);
        const status = await processor.status();
        expect(status.totalDocs).toBeGreaterThan(0);
    });

    it('indexIncremental - 批量 embed - 100 chunk 只调 1 次 embed', async () => {
        // 关键路径:生成一个会产生多个 chunk 的长文档
        const longContent = Array(50).fill(null).map((_, i) => `## 标题${i}\n\n这是第${i}段内容,填充一些文字确保分块。`).join('\n\n');
        await processor.indexIncremental({ path: 'long.md', content: longContent });

        // 关键路径:无论多少 chunk,embed 只应被调用 1 次(批量)
        expect(embedCallCount).toBe(1);
    });

    it('indexIncremental - 空文件不触发 embed', async () => {
        await processor.indexIncremental({ path: 'empty.md', content: '' });
        expect(embedCallCount).toBe(0);
    });

    it('indexIncremental - embed 失败不挂整批 - 返回 errors=1', async () => {
        const failEmbedding: EmbeddingPort = {
            dimensions: 512,
            modelId: 'test:fail',
            async embed(): Promise<number[][]> {
                throw new Error('ONNX 推理失败');
            },
        };
        const failProcessor = new IndexProcessor(store, failEmbedding, DEFAULT_CHUNK_OPTIONS);
        const result = await failProcessor.indexIncremental({ path: 'fail.md', content: 'test content' });
        expect(result.errors).toBe(1);
        expect(result.indexed).toBe(0);
    });

    it('indexBatch - 多文件批量 embed 返回 chunkCounts', async () => {
        // 关键路径:IndexProcessor 需要 store + embeddings。用真实 VectraStore 临时目录 + mock embeddings。
        const testDir = path.join(__dirname, '../tmp/test-index-batch');
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        const store = new VectraStore(testDir, { embeddings: stubEmbedder, autoInit: true });
        await store.init();
        const mockEmbed: EmbeddingPort = {
            embed: vi.fn().mockImplementation(async (texts: string[]) => {
                // 关键路径:返回 texts.length 个 512 维向量。
                return texts.map(() => Array(512).fill(0).map(() => Math.random()));
            }),
            dimensions: 512,
            modelId: 'test:batch',
        };
        const processor = new IndexProcessor(store, mockEmbed, DEFAULT_CHUNK_OPTIONS);

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
        const testDir = path.join(__dirname, '../tmp/test-index-batch-residue');
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        const store = new VectraStore(testDir, { embeddings: stubEmbedder, autoInit: true });
        await store.init();
        const mockEmbed: EmbeddingPort = {
            embed: vi.fn().mockImplementation(async (texts: string[]) =>
                texts.map(() => Array(512).fill(0).map(() => Math.random())),
            ),
            dimensions: 512,
            modelId: 'test:batch',
        };
        const processor = new IndexProcessor(store, mockEmbed, DEFAULT_CHUNK_OPTIONS);

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

    it('setChunkOptions - 更新分块参数后按新预算切块(每条 index.* 消息可带新参数)', async () => {
        // 关键路径:handler 每条索引消息都会调 setChunkOptions ——
        // 用户在设置里改了分块大小后,下一次索引即生效,不需要重启 Worker。
        processor.setChunkOptions({ maxTokens: 20, overlapTokens: 0, count: (t: string) => t.length });
        await processor.indexIncremental({ path: 'x.md', content: '一'.repeat(100) });

        const queryVector = Array(512).fill(0).map(() => Math.random());
        const results = await store.search(queryVector, 100);
        const chunks = results.filter((r) => (r.metadata as { path?: string }).path === 'x.md');
        expect(chunks.length).toBeGreaterThan(1);
    });

    it('indexIncremental - 使用构造时传入的 token 预算 - 不再硬编码 500', async () => {
        const testDir = path.join(__dirname, '../tmp/test-index-chunk-budget');
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        const store = new VectraStore(testDir, { embeddings: stubEmbedder, autoInit: true });
        await store.init();
        const mockEmbed: EmbeddingPort = {
            embed: vi.fn().mockImplementation(async (texts: string[]) =>
                texts.map(() => Array(512).fill(0).map(() => Math.random())),
            ),
            dimensions: 512,
            modelId: 'test:budget',
        };
        // 关键路径:20 token 预算 + 1 字符 1 token → 100 字符应切成多块
        const processor = new IndexProcessor(store, mockEmbed, {
            maxTokens: 20,
            overlapTokens: 0,
            count: (t: string) => t.length,
        });

        await processor.indexIncremental({ path: 'a.md', content: '一'.repeat(100) });

        const queryVector = Array(512).fill(0).map(() => Math.random());
        const results = await store.search(queryVector, 100);
        const chunks = results.filter((r) => (r.metadata as { path?: string }).path === 'a.md');
        expect(chunks.length).toBeGreaterThan(1);

        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    });

    it('indexIncremental - 嵌入用带结构前缀的文本 - metadata 记 headingPath', async () => {
        const testDir = path.join(__dirname, '../tmp/test-index-prefix');
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
        fs.mkdirSync(testDir, { recursive: true });

        const store = new VectraStore(testDir, { embeddings: stubEmbedder, autoInit: true });
        await store.init();
        const embed = vi.fn().mockImplementation(async (texts: string[]) =>
            texts.map(() => Array(512).fill(0).map(() => Math.random())),
        );
        const processor = new IndexProcessor(store, {
            embed,
            dimensions: 512,
            modelId: 'test:prefix',
        }, DEFAULT_CHUNK_OPTIONS);

        await processor.indexIncremental({ path: 'h.md', content: '# 标题\n\n正文内容' });

        // 关键路径:嵌入输入是带前缀的文本(前缀只进嵌入,正文保持原样)
        const inputs = embed.mock.calls[0]![0] as string[];
        expect(inputs.length).toBeGreaterThan(0);
        expect(inputs[0]).toContain('正文内容');

        // 关键路径:metadata 记 headingPath,供上层扩展页号与表头
        const queryVector = Array(512).fill(0).map(() => Math.random());
        const results = await store.search(queryVector, 10);
        const meta = results.find((r) => (r.metadata as { path?: string }).path === 'h.md')!
            .metadata as { headingPath?: unknown };
        expect(Array.isArray(meta.headingPath)).toBe(true);

        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    });
});

// ---------------------------------------------------------------------------
// 新存储契约:单事务替换、原子存储注入与失败恢复
// ---------------------------------------------------------------------------

/** 新用例的索引目录根 — 每个用例用独立子目录,结束后统一清理。 */
const TMP_TX_ROOT = path.join(__dirname, '../tmp/index-processor-tx');

/** 确定性嵌入端口 — 同一文本永远得到同一向量,避免随机向量让断言漂移。 */
function deterministicPort(dimensions: number): EmbeddingPort {
    return {
        dimensions,
        modelId: 'test:deterministic',
        async embed(texts: string[]): Promise<number[][]> {
            return texts.map((text) =>
                Array.from({ length: dimensions }, (_unused, index) => ((text.length + index) % 7) / 7),
            );
        },
    };
}

/** 生产装配同款构造 — main.ts / worker/handler.ts 都向 VectraStore 注入原子存储。 */
async function createProductionStore(indexDir: string, storage: AtomicIndexStorage): Promise<VectraStore> {
    const store = new VectraStore(indexDir, { autoInit: true, storage });
    // 关键路径:`init()` 在构造期已触发,但它是异步的;这里用公开方法等它落地,
    // 否则后续断言会跑在「索引文件尚未创建」的中间态上。
    await store.isIndexCreated();
    return store;
}

/** 生成含 `sectionCount` 个小节的 Markdown,配合默认分块参数约每节一块。 */
function markdownWithSections(sectionCount: number): string {
    return Array.from(
        { length: sectionCount },
        (_unused, index) => `## 小节 ${index}\n\n第 ${index} 段正文。${'内容填充'.repeat(20)}`,
    ).join('\n\n');
}

/** 某路径按生产约定命名的块 ID 序列。 */
function blockIdsFor(filePath: string, count: number): string[] {
    return Array.from({ length: count }, (_unused, index) => `${filePath}#chunk-${index}`);
}

/** 预计算向量 — 只要求有限且同维度,用于播种旧块。 */
function fixedVector(dimensions: number, seed: number): number[] {
    return Array.from({ length: dimensions }, (_unused, index) => ((index + seed) % 11) / 11);
}

/** 在指定路径播种若干旧块(走生产写入路径 `replaceFile`)。 */
async function seedBlocks(
    store: VectraStore,
    filePath: string,
    count: number,
    dimensions: number,
): Promise<void> {
    await store.replaceFile({
        path: filePath,
        commitId: 'seed-commit',
        blocks: blockIdsFor(filePath, count).map((id, index) => ({
            id,
            vector: fixedVector(dimensions, index),
            metadata: { path: filePath, chunkIndex: index },
        })),
    });
}

/**
 * 只让第一次「临时文件打开」失败的文件系统接缝。
 *
 * 关键路径:EACCES 落在 rename 之前 → 写入结果为 `failed-before-rename`,磁盘仍是完整旧版;
 * 后续提交恢复正常,才能验证「首次提交失败后同批后续文件仍被处理」。
 *
 * @param armed - 是否已进入故障态。
 * @returns 注入故障的写入接缝。
 */
function failFirstCommitFileSystem(armed: () => boolean): AtomicWriteFileSystem {
    let remainingFailures = 1;
    return {
        async openFile(filePath: string): Promise<AtomicWriteHandle> {
            if (armed() && remainingFailures > 0) {
                remainingFailures -= 1;
                const error = new Error('注入故障:临时文件打开失败');
                (error as { code?: string }).code = 'EACCES';
                throw error;
            }
            const handle = await fsp.open(filePath, 'wx');
            return {
                async write(buffer: Uint8Array, offset: number, length: number): Promise<number> {
                    const result = await handle.write(buffer, offset, length);
                    return result.bytesWritten;
                },
                sync: () => handle.sync(),
                close: () => handle.close(),
            };
        },
        async openDirectory(directoryPath: string) {
            const handle = await fsp.open(directoryPath, 'r');
            return { sync: () => handle.sync(), close: () => handle.close() };
        },
        rename: (from: string, to: string) => fsp.rename(from, to),
        async removeFile(filePath: string): Promise<void> {
            await fsp.rm(filePath, { force: true });
        },
    };
}

describe('新存储契约 - 单事务替换与原子存储注入', () => {
    const createdDirs: string[] = [];

    /** 每个用例独立的索引目录。 */
    function freshDir(name: string): string {
        const dir = path.join(TMP_TX_ROOT, name);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        createdDirs.push(dir);
        return dir;
    }

    afterEach(() => {
        while (createdDirs.length > 0) {
            const dir = createdDirs.pop();
            if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('indexIncremental - 文件变短再变空 - 旧块被清除且返回的 chunkCount 与真实块数一致', async () => {
        const dir = freshDir('incremental-shrink');
        const store = await createProductionStore(dir, new AtomicIndexStorage({ generationRoot: dir }));
        const processor = new IndexProcessor(store, deterministicPort(512), DEFAULT_CHUNK_OPTIONS);
        const filePath = 'notes/shrink.md';

        const first = await processor.indexIncremental({ path: filePath, content: markdownWithSections(12) });
        const firstIds = (await store.inspectFile(filePath)).map((block) => block.id);
        // 关键路径:前置条件 —— 长内容必须真的产生多块,否则「变短」无从谈起。
        expect(firstIds.length).toBeGreaterThan(1);
        expect(first).toMatchObject({ indexed: 1, errors: 0, chunkCount: firstIds.length });

        const shortContent = '短内容';
        const shortExpected = chunkMarkdown(shortContent, DEFAULT_CHUNK_OPTIONS).length;
        const second = await processor.indexIncremental({ path: filePath, content: shortContent });
        const secondIds = (await store.inspectFile(filePath)).map((block) => block.id);
        // 关键路径(B1):只比数量会漏掉「旧块残留、数量看起来仍对得上」的缺陷,必须比 ID 集合。
        expect(second.chunkCount).toBe(shortExpected);
        expect(second.chunkCount).toBe(secondIds.length);
        expect(secondIds).toEqual(blockIdsFor(filePath, shortExpected));

        const third = await processor.indexIncremental({ path: filePath, content: '' });
        const remaining = await store.inspectFile(filePath);
        expect({ indexed: third.indexed, errors: third.errors, chunkCount: third.chunkCount, remaining }).toEqual({
            indexed: 1,
            errors: 0,
            chunkCount: 0,
            remaining: [],
        });

        // 关键路径:重载后读到的仍是空块集合 —— 删除确实落盘,而不是只改了内存视图。
        await store.reload();
        expect(await store.inspectFile(filePath)).toEqual([]);
    });

    it('空内容 - 三条入口都提交零块替换 - 旧块从磁盘消失', async () => {
        const entries = ['indexFull', 'indexIncremental', 'indexBatch'] as const;
        for (const entry of entries) {
            const dir = freshDir(`empty-${entry}`);
            const store = await createProductionStore(dir, new AtomicIndexStorage({ generationRoot: dir }));
            const processor = new IndexProcessor(store, deterministicPort(512), DEFAULT_CHUNK_OPTIONS);
            const filePath = `notes/${entry}.md`;
            // 关键路径:先播种旧块 —— 空内容必须提交「零块替换」,不能早退把旧块留在索引里。
            await seedBlocks(store, filePath, 5, 512);
            expect((await store.inspectFile(filePath)).length).toBe(5);

            const progress: Array<{ done: number; total: number }> = [];
            if (entry === 'indexFull') {
                await processor.indexFull([{ path: filePath, content: '' }], (event) => progress.push(event));
            } else if (entry === 'indexIncremental') {
                await processor.indexIncremental({ path: filePath, content: '' }, (event) => progress.push(event));
            } else {
                await processor.indexBatch([{ path: filePath, content: '' }], (event) => progress.push(event));
            }

            expect({ entry, remaining: await store.inspectFile(filePath) }).toEqual({ entry, remaining: [] });
            // 关键路径:磁盘真值同样为空;空内容必须算处理成功,不能记成错误后跳过删除。
            await store.reload();
            expect({ entry, disk: await store.inspectFile(filePath) }).toEqual({ entry, disk: [] });
            expect({ entry, progress: progress.at(-1) }).toEqual({ entry, progress: { done: 1, total: 1 } });
        }
    });

    it('三条写入路径 - 写入的 documentId 一致为块 ID', async () => {
        const dir = freshDir('document-id');
        const store = await createProductionStore(dir, new AtomicIndexStorage({ generationRoot: dir }));
        const processor = new IndexProcessor(store, deterministicPort(512), DEFAULT_CHUNK_OPTIONS);

        await processor.indexFull([{ path: 'notes/full.md', content: '全量入口写入的正文' }]);
        await processor.indexIncremental({ path: 'notes/incremental.md', content: '增量入口写入的正文' });
        await processor.indexBatch([{ path: 'notes/batch.md', content: '批量入口写入的正文' }]);

        /**
         * 核对一个路径的块:`documentId` 必须是块 ID。
         *
         * 关键路径(I1):三条入口都经 `replaceFile` 写入,若这里退回文件路径,
         * `search()` 的聚合粒度会从「top K 片段」静默变成「top K 文件」,且各入口彼此分裂。
         */
        const assertDocumentIdIsBlockId = (filePath: string, blocks: Array<{ id: string; metadata: Record<string, unknown> }>): void => {
            expect({ filePath, count: blocks.length > 0 }).toEqual({ filePath, count: true });
            for (const block of blocks) {
                const metadata = block.metadata as { docId?: unknown; documentId?: unknown };
                expect({ block: block.id, docId: metadata.docId, documentId: metadata.documentId }).toEqual({
                    block: block.id,
                    docId: block.id,
                    documentId: block.id,
                });
            }
        };

        const paths = ['notes/full.md', 'notes/incremental.md', 'notes/batch.md'];
        for (const filePath of paths) {
            assertDocumentIdIsBlockId(filePath, await store.inspectFile(filePath));
        }
        // 关键路径:重载后再核对一次 —— documentId 必须随块内联落盘,不是只在内存里正确。
        await store.reload();
        for (const filePath of paths) {
            assertDocumentIdIsBlockId(filePath, await store.inspectFile(filePath));
        }
    });

    it('生产装配 - 注入原子存储 - 提交经适配器落盘且能读回写入结果', async () => {
        const dir = freshDir('production-storage');
        const storage = new AtomicIndexStorage({ generationRoot: dir });
        const store = await createProductionStore(dir, storage);
        const processor = new IndexProcessor(store, deterministicPort(512), DEFAULT_CHUNK_OPTIONS);
        const indexPath = path.join(dir, 'index.json');

        // 关键路径(B3):未注入存储时该读取恒为 null,提交失败只能报「磁盘状态不明」。
        expect(storage.getLastWriteOutcome(indexPath)).not.toBeNull();
        storage.clearWriteRecords();

        await processor.indexIncremental({ path: 'notes/storage.md', content: '存储注入生效' });

        const record = storage.getLastWriteOutcome(indexPath);
        expect(record).not.toBeNull();
        expect({ path: record?.path, outcome: record?.outcome, bytes: (record?.bytes ?? 0) > 0 }).toEqual({
            path: indexPath,
            outcome: 'renamed',
            bytes: true,
        });
        // 关键路径:单文件提交只经过适配器一次 —— 删除与插入在同一事务内完成。
        expect(storage.getWriteRecords().filter((entry) => entry.path === indexPath).length).toBe(1);
        // 关键路径:同目录临时文件必须已被 rename 消费,目录里不留 .tmp- 残留。
        expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
        expect(store.isReloadRequired()).toBe(false);
    });

    it('indexBatch - 首个文件提交失败 - 同批后续文件仍被处理(自动 reload)', async () => {
        const dir = freshDir('batch-recover');
        let armed = false;
        const storage = new AtomicIndexStorage({
            generationRoot: dir,
            fileSystem: failFirstCommitFileSystem(() => armed),
        });
        const store = await createProductionStore(dir, storage);
        const processor = new IndexProcessor(store, deterministicPort(512), DEFAULT_CHUNK_OPTIONS);

        armed = true;
        const result = await processor.indexBatch([
            { path: 'notes/a.md', content: '首个文件(注入提交失败)' },
            { path: 'notes/b.md', content: '第二个文件' },
            { path: 'notes/c.md', content: '第三个文件' },
        ]);

        // 关键路径(I4):首个失败不能把同批后续文件全部算成失败 —— 自动 reload 后必须继续处理。
        expect({ indexed: result.indexed, errors: result.errors }).toEqual({ indexed: 2, errors: 1 });
        expect(result.chunkCounts['notes/a.md']).toBeUndefined();
        expect(result.chunkCounts['notes/b.md']).toBeGreaterThan(0);
        expect(result.chunkCounts['notes/c.md']).toBeGreaterThan(0);
        expect(await store.inspectFile('notes/a.md')).toEqual([]);
        expect((await store.inspectFile('notes/b.md')).length).toBeGreaterThan(0);
        expect((await store.inspectFile('notes/c.md')).length).toBeGreaterThan(0);
        // 关键路径:重载成功后存储必须回到可用状态,否则后续增量会被 reload-required 挡住。
        expect(store.isReloadRequired()).toBe(false);
        // 关键路径:故障落在 rename 之前 → 磁盘保持完整旧版,记录可查。
        const failed = storage.getWriteRecords().filter((entry) => entry.outcome === 'failed-before-rename');
        expect(failed.length).toBe(1);
    });

    it('indexFull / indexBatch - reload 失败 - 本批中止且未处理文件计入 errors', async () => {
        // 关键路径(B3b):reload 失败是「无法恢复」路径,本用例只验证 IndexProcessor 的计数契约,
        // 因此用最小桩把失败注入在存储边界上(提交失败 + 重载失败),不重复覆盖真实 IO。
        const replaceFile = vi.fn(async () => {
            throw new Error('注入故障:提交失败');
        });
        const reload = vi.fn(async () => {
            throw new Error('注入故障:重载失败');
        });
        const failingStore = { replaceFile, isReloadRequired: () => true, reload } as unknown as VectraStore;
        const processor = new IndexProcessor(failingStore, deterministicPort(512), DEFAULT_CHUNK_OPTIONS);
        const files = [
            { path: 'notes/a.md', content: '第一个文件' },
            { path: 'notes/b.md', content: '第二个文件' },
            { path: 'notes/c.md', content: '第三个文件' },
        ];

        const progress: Array<{ done: number; total: number }> = [];
        const fullResult = await processor.indexFull(files, (event) => progress.push(event));
        // 关键路径:1 个失败 + 2 个未处理 = errors 3,indexed 保持 0 —— 未处理绝不能算成已索引。
        expect(fullResult).toEqual({ indexed: 0, errors: 3 });
        expect(progress).toEqual([{ done: 1, total: 3 }]);
        expect(replaceFile).toHaveBeenCalledTimes(1);
        expect(reload).toHaveBeenCalledTimes(1);

        const batchResult = await processor.indexBatch(files);
        expect({ indexed: batchResult.indexed, errors: batchResult.errors }).toEqual({ indexed: 0, errors: 3 });
        expect(batchResult.chunkCounts).toEqual({});

        const incrementalResult = await processor.indexIncremental({ path: 'notes/a.md', content: '单个文件' });
        expect(incrementalResult).toEqual({ indexed: 0, errors: 1, chunkCount: 0 });
    });
});
