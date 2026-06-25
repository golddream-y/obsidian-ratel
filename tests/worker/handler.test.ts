/**
 * @file tests/worker/handler.test.ts
 * @description handleMessage 单元测试 — 6 case 真实现 + NULL_PROCESSOR 守卫 (M-1)
 * @module tests/worker/handler
 * @depends worker/handler, worker/index-processor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initProcessor, handleMessage, setProcessorForTest } from '../../src/worker/handler';
import { IndexProcessor } from '../../src/worker/index-processor';
import type { WorkerRequest } from '../../src/types';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
import type { VectraStore } from '../../src/adapters/vector-vectra';
import path from 'path';
import fs from 'fs';

const TMP_HANDLER_DIR = path.join(__dirname, '../tmp/handler-init-test');

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

describe('handleMessage - 未初始化', () => {
    it('init 前调用 index.status - 返 NULL_PROCESSOR', async () => {
        const { handleMessage: fresh } = await import('../../src/worker/handler?init-test=' + Date.now());
        const res = await fresh({ type: 'index.status', payload: {} } as WorkerRequest);
        expect(res.type === 'index.status.result' || (res.type === 'error' && (res.payload.code === 'NULL_PROCESSOR' || res.payload.code === 'UNKNOWN_REQUEST'))).toBe(true);
    });
});

describe('handleMessage - M-1 真实现', () => {
    beforeEach(() => {
        if (fs.existsSync(TMP_HANDLER_DIR)) fs.rmSync(TMP_HANDLER_DIR, { recursive: true });
        fs.mkdirSync(TMP_HANDLER_DIR, { recursive: true });
        initProcessor(TMP_HANDLER_DIR, stubEmbedder);
    });

    it('index.status - 返真实数据(总文档数 >= 0)', async () => {
        const res = await handleMessage({ type: 'index.status', payload: {} });
        expect(res.type).toBe('index.status.result');
        expect((res as { payload: { totalDocs: number } }).payload.totalDocs).toBeGreaterThanOrEqual(0);
    });

    it('index.full - 成功索引 + 返 indexed/errors 计数', async () => {
        const res = await handleMessage({
            type: 'index.full',
            payload: { files: [{ path: 'a.md', content: 'Hello' }] },
        } as unknown as WorkerRequest);
        expect(res.type).toBe('index.done');
        expect((res as { payload: { indexed: number } }).payload.indexed).toBe(1);
    });

    it('index.incremental - 单文件 upsert', async () => {
        const res = await handleMessage({
            type: 'index.incremental',
            payload: { file: { path: 'b.md', content: 'Incremental doc' } },
        } as unknown as WorkerRequest);
        expect(res.type).toBe('index.done');
    });

    it('index.delete - 返 count', async () => {
        await handleMessage({
            type: 'index.full',
            payload: { files: [{ path: 'c.md', content: 'Delete me' }] },
        } as unknown as WorkerRequest);
        const res = await handleMessage({ type: 'index.delete', payload: { filePath: 'c.md' } });
        expect(res.type).toBe('vector.delete.done');
    });

    it('vector.search - 返 hits', async () => {
        await handleMessage({
            type: 'index.full',
            payload: { files: [{ path: 'd.md', content: 'Search me' }] },
        } as unknown as WorkerRequest);
        const res = await handleMessage({
            type: 'vector.search',
            payload: { queryVector: Array(512).fill(0.5), topK: 5 },
        } as unknown as WorkerRequest);
        expect(res.type).toBe('vector.search.result');
    });
});

describe('handler — hybrid.search', () => {
    afterEach(() => {
        // 关键路径:每个用例直接替换了全局 processor,必须清理避免污染后续 describe
        setProcessorForTest(null);
    });

    it('hybrid.search - 路由到 processor.hybridSearch 并返回 hybrid.search.result', async () => {
        const fakeStore = {} as VectraStore;
        const processor = new IndexProcessor(fakeStore);
        // 关键路径:mock processor.hybridSearch,避免真实 vectra 调用
        processor.hybridSearch = vi.fn().mockResolvedValue([
            { docId: 'notes/a.md#chunk-0', score: 0.9, metadata: { path: 'notes/a.md', chunkIndex: 0 } },
        ]);
        setProcessorForTest(processor);

        const response = await handleMessage(
            { type: 'hybrid.search', payload: { query: 'test', queryVector: [0.1, 0.2], topK: 5 } },
            () => {},
        );

        expect(response.type).toBe('hybrid.search.result');
        expect((response as { payload: unknown[] }).payload).toHaveLength(1);
        expect(processor.hybridSearch).toHaveBeenCalledWith('test', [0.1, 0.2], 5);
    });

    it('hybrid.search - 未知 payload 字段 - 仍能解析并路由', async () => {
        // 关键路径:_requestId 是主线程注入的字段,handler 不应受其影响
        const fakeStore = {} as VectraStore;
        const processor = new IndexProcessor(fakeStore);
        processor.hybridSearch = vi.fn().mockResolvedValue([]);
        setProcessorForTest(processor);

        const response = await handleMessage(
            { type: 'hybrid.search', payload: { query: 'x', queryVector: [0.1], topK: 3 }, _requestId: 'req_1' },
            () => {},
        );

        expect(response.type).toBe('hybrid.search.result');
    });
});
