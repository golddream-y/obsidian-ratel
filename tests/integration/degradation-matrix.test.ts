/**
 * @file tests/integration/degradation-matrix.test.ts
 * @description 降级矩阵 — 模型未就绪 / Worker null processor 错误路径
 * @module tests/integration/degradation-matrix
 * @depends adapters/embedding-local, worker/handler
 */

import { describe, it, expect, vi } from 'vitest';
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
    it('未 initProcessor - handleMessage 返 error(NULL_PROCESSOR)', async () => {
        // 关键路径:vi.resetModules 强制重新加载 handler 模块,
        // 确保 module-level processor 变量为初始 null,不受其他测试污染。
        vi.resetModules();
        const { handleMessage } = await import('../../src/worker/handler');

        const res = await handleMessage({ type: 'index.status', payload: {} });

        expect(res.type).toBe('error');
        expect(res.payload.code).toBe('NULL_PROCESSOR');
    });
});
