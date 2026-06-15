/**
 * @file tests/adapters/embedding-local.test.ts
 * @description EmbeddingLocal 行为 — 构造默认值 / 注入 extractor / 未就绪抛 IndexNotReadyError
 * @module tests/adapters/embedding-local
 * @depends adapters/embedding-local
 *
 * 关键路径:M-6 改造后,EmbeddingLocal 不再懒加载,所有加载由 ModelManager 负责。
 * 这里只验证两件事:
 * 1. 构造时 modelId / dimensions 正确
 * 2. 注入 extractor 后 embed 可调;未注入时抛 IndexNotReadyError
 */

import { describe, it, expect, vi } from 'vitest';
import { EmbeddingLocal, IndexNotReadyError } from '../../src/adapters/embedding-local';

describe('EmbeddingLocal - 构造', () => {
    it('默认值 - modelId / dimensions', () => {
        const adapter = new EmbeddingLocal();
        expect(adapter.modelId).toBe('local:Xenova/bge-small-zh-v1.5');
        expect(adapter.dimensions).toBe(512);
    });

    it('自定义模型 - modelId / dimensions', () => {
        const adapter = new EmbeddingLocal('Xenova/bge-micro-v2', 384);
        expect(adapter.modelId).toBe('local:Xenova/bge-micro-v2');
        expect(adapter.dimensions).toBe(384);
    });
});

describe('EmbeddingLocal - M-6 注入式', () => {
    it('未注入 extractor 时 embed - 抛 IndexNotReadyError(code=INDEX_NOT_READY)', async () => {
        const e = new EmbeddingLocal();
        try {
            await e.embed(['hello']);
            expect.fail('应该抛错');
        } catch (err) {
            expect(err).toBeInstanceOf(IndexNotReadyError);
            expect((err as IndexNotReadyError).code).toBe('INDEX_NOT_READY');
        }
    });

    it('注入 extractor 后 embed - 调用并返回', async () => {
        const mockExtractor = vi.fn().mockResolvedValue({
            tolist: () => [Array(512).fill(0.5)],
        });
        const e = new EmbeddingLocal();
        e.setExtractor(mockExtractor as unknown as Parameters<EmbeddingLocal['setExtractor']>[0]);
        const vectors = await e.embed(['hello']);
        expect(vectors).toHaveLength(1);
        expect(vectors[0]).toHaveLength(512);
        expect(mockExtractor).toHaveBeenCalledWith(['hello'], expect.objectContaining({ pooling: 'mean', normalize: true }));
    });
});
