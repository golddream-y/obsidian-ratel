/**
 * @file tests/worker/index-processor.test.ts
 * @description IndexProcessor 行为 — indexFull / indexIncremental / indexDelete / vectorSearch / status
 * @module tests/worker/index-processor
 * @depends worker/index-processor, adapters/vector-vectra
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IndexProcessor } from '../../src/worker/index-processor';
import { VectraStore } from '../../src/adapters/vector-vectra';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
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

    beforeEach(async () => {
        if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true });
        fs.mkdirSync(TMP_DIR, { recursive: true });
        store = new VectraStore(TMP_DIR, { embeddings: stubEmbedder, autoInit: true });
        await store.init();
        processor = new IndexProcessor(store);
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
});
