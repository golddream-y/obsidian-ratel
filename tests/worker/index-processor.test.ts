/**
 * @file tests/worker/index-processor.test.ts
 * @description IndexProcessor 行为 — indexFull / indexIncremental / indexDelete / vectorSearch / status
 * @module tests/worker/index-processor
 * @depends worker/index-processor, adapters/vector-vectra, ports/embedding
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndexProcessor } from '../../src/worker/index-processor';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import type { EmbeddingPort } from '../../src/ports/embedding';
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
        processor = new IndexProcessor(store, mockEmbedding);
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
        const failProcessor = new IndexProcessor(store, failEmbedding);
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
});
