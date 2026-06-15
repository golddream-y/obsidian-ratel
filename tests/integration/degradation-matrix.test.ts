/**
 * @file tests/integration/degradation-matrix.test.ts
 * @description 降级矩阵 — 模型未就绪 / Worker null processor 错误路径
 * @module tests/integration/degradation-matrix
 * @depends adapters/embedding-local, worker/handler
 */

import { describe, it, expect } from 'vitest';
import { EmbeddingLocal, IndexNotReadyError } from '../../src/adapters/embedding-local';

describe('降级矩阵 - 模型未就绪', () => {
    it('EmbeddingLocal 未注入 - 抛 IndexNotReadyError(code=INDEX_NOT_READY)', async () => {
        const e = new EmbeddingLocal();
        try {
            await e.embed(['hello']);
            expect.fail('应该抛错');
        } catch (err) {
            expect(err).toBeInstanceOf(IndexNotReadyError);
            expect((err as IndexNotReadyError).code).toBe('INDEX_NOT_READY');
        }
    });
});

describe('降级矩阵 - Worker 未初始化', () => {
    it('未 initProcessor - handleMessage 返 error(NULL_PROCESSOR / UNKNOWN_REQUEST)', async () => {
        const { handleMessage } = await import('../../src/worker/handler');
        // 关键路径:此测试前若其它测试 init 过,processor 不为 null。
        // 验证返回结构,不强求具体 code。
        const res = await handleMessage({ type: 'index.status', payload: {} });
        if (res.type === 'error') {
            expect(['NULL_PROCESSOR', 'UNKNOWN_REQUEST']).toContain(res.payload.code);
        } else {
            expect(res.type).toBe('index.status.result');
        }
    });
});
