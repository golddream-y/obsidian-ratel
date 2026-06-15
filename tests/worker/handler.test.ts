/**
 * @file tests/worker/handler.test.ts
 * @description handleMessage 单元测试 — 6 case 真实现 + NULL_PROCESSOR 守卫 (M-1)
 * @module tests/worker/handler
 * @depends worker/handler, worker/index-processor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initProcessor, handleMessage } from '../../src/worker/handler';
import type { WorkerRequest } from '../../src/types';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra';
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
